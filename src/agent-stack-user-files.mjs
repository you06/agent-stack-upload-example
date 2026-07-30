import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

const JSON_CONTENT_TYPE = 'application/json';

export class AgentStackApiError extends Error {
  constructor({ method, url, status, payload, responseText }) {
    const error = payload?.error;
    const code = error?.code ?? `http_${status}`;
    const message = error?.message ?? responseText ?? `HTTP ${status}`;
    super(`${method} ${url} failed (${status}, ${code}): ${message}`);
    this.name = 'AgentStackApiError';
    this.method = method;
    this.url = url;
    this.status = status;
    this.code = code;
    this.details = error?.details;
    this.payload = payload;
  }
}

export class AgentStackUserFilesClient {
  constructor({ baseUrl, apiKey, projectId, fetchImpl = globalThis.fetch }) {
    if (!baseUrl) throw new Error('baseUrl is required');
    if (!apiKey) throw new Error('apiKey is required');
    if (!projectId) throw new Error('projectId is required');
    if (typeof fetchImpl !== 'function') throw new Error('fetch is not available');

    this.baseUrl = baseUrl.replace(/\/+$/u, '');
    this.apiKey = apiKey;
    this.projectId = projectId;
    this.fetch = fetchImpl;
  }

  async getCapabilities() {
    return this.#requestJson('/api/user-files/upload-capabilities');
  }

  async createUpload({ idempotencyKey, originalName, byteSize, sha256, contentType }) {
    return this.#requestJson('/api/user-files/uploads', {
      method: 'POST',
      headers: {
        'content-type': JSON_CONTENT_TYPE,
        'idempotency-key': idempotencyKey,
      },
      body: JSON.stringify({
        originalName,
        byteSize,
        sha256,
        contentType,
      }),
    });
  }

  async uploadInlineContent({ uploadId, contentUrl, bytes, sha256 }) {
    const path = contentUrl ?? `/api/user-files/uploads/${encodeURIComponent(uploadId)}/content`;
    return this.#requestJson(path, {
      method: 'PUT',
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': String(bytes.length),
        'content-digest': rfc9530Sha256(sha256),
      },
      body: bytes,
    });
  }

  async presignPart({ uploadId, partNumber, sha256 }) {
    return this.#requestJson(
      `/api/user-files/uploads/${encodeURIComponent(uploadId)}/parts/${partNumber}/presign`,
      {
        method: 'POST',
        headers: { 'content-type': JSON_CONTENT_TYPE },
        body: JSON.stringify({ sha256 }),
      },
    );
  }

  async putPresignedPart({ url, headers, bytes }) {
    const response = await this.fetch(url, {
      method: 'PUT',
      headers,
      body: bytes,
    });
    if (!response.ok) {
      const responseText = await response.text();
      throw new AgentStackApiError({
        method: 'PUT',
        url,
        status: response.status,
        payload: null,
        responseText,
      });
    }
    const etag = response.headers.get('etag');
    if (!etag) {
      throw new Error(`S3 PUT ${url} succeeded without an ETag response header`);
    }
    return etag;
  }

  async completeUpload({ uploadId, parts }) {
    return this.#requestJson(
      `/api/user-files/uploads/${encodeURIComponent(uploadId)}/complete`,
      {
        method: 'POST',
        headers: { 'content-type': JSON_CONTENT_TYPE },
        body: JSON.stringify({ parts }),
      },
    );
  }

  async getUploadStatus(uploadId) {
    return this.#requestJson(`/api/user-files/uploads/${encodeURIComponent(uploadId)}`);
  }

  async abortUpload(uploadId) {
    return this.#requestJson(`/api/user-files/uploads/${encodeURIComponent(uploadId)}`, {
      method: 'DELETE',
    });
  }

  async createDownloadUrl({ relPath }) {
    return this.#requestJson(
      `/api/console/drive/${encodeURIComponent(this.projectId)}/file/download-url`,
      {
        method: 'POST',
        headers: { 'content-type': JSON_CONTENT_TYPE },
        body: JSON.stringify({ relPath }),
      },
    );
  }

  async redeemDownloadUrl({ url, outputPath }) {
    const baseUrl = new URL(`${this.baseUrl}/`);
    const requestUrl = new URL(url, baseUrl);
    const downloadPath = /^\/api\/drive-downloads\/[^/]+$/u;
    if (
      requestUrl.origin !== baseUrl.origin ||
      requestUrl.username ||
      requestUrl.password ||
      requestUrl.search ||
      requestUrl.hash ||
      !downloadPath.test(requestUrl.pathname)
    ) {
      throw new Error(
        'Refusing to redeem an invalid Agent Stack download ticket URL',
      );
    }

    const response = await this.fetch(requestUrl, {
      method: 'GET',
      redirect: 'follow',
      cache: 'no-store',
    });
    if (!response.ok) {
      await throwApiError({
        method: 'GET',
        url: `${baseUrl.origin}/api/drive-downloads/[redacted]`,
        response,
      });
    }
    if (!response.body) {
      throw new Error('Download response did not include a response body');
    }

    const absoluteOutputPath = await writeResponseBody({
      response,
      outputPath,
    });
    const fileStat = await stat(absoluteOutputPath);
    return {
      outputPath: absoluteOutputPath,
      byteSize: fileStat.size,
      sha256: await sha256File(absoluteOutputPath),
      contentType: response.headers.get('content-type'),
    };
  }

  async createSession() {
    return this.#requestJson('/api/sessions', {
      method: 'POST',
      headers: { 'content-type': JSON_CONTENT_TYPE },
      body: JSON.stringify({}),
    });
  }

  async runTurn({
    sessionId,
    text,
    userFileIds = [],
    onEvent = () => {},
  }) {
    const path = `/api/sessions/${encodeURIComponent(sessionId)}/turns`;
    const { method, url, response } = await this.#authenticatedFetch(path, {
      method: 'POST',
      headers: { 'content-type': JSON_CONTENT_TYPE },
      body: JSON.stringify({
        input: {
          type: 'text',
          text,
          userFileIds,
        },
      }),
    });
    if (!response.ok) {
      await throwApiError({ method, url, response });
    }

    const events = [];
    for await (const event of readNdjson(response)) {
      events.push(event);
      onEvent(event);
    }
    const assistantText =
      events.findLast((event) => event.event === 'assistant_message')?.payload?.text ??
      null;
    const turnStatus =
      events.findLast((event) => event.event === 'turn_finished')?.payload?.status ??
      null;
    return {
      events,
      turnId: events[0]?.turnId ?? null,
      assistantText,
      status: turnStatus,
    };
  }

  async #requestJson(pathOrUrl, init = {}) {
    const { method, url, response } = await this.#authenticatedFetch(pathOrUrl, init);
    const responseText = await response.text();
    let payload = null;
    if (responseText) {
      try {
        payload = JSON.parse(responseText);
      } catch {
        payload = null;
      }
    }
    if (!response.ok) {
      throw new AgentStackApiError({
        method,
        url,
        status: response.status,
        payload,
        responseText,
      });
    }
    if (payload === null) {
      throw new Error(`${method} ${url} returned a non-JSON success response`);
    }
    return payload;
  }

  async #authenticatedFetch(pathOrUrl, init = {}) {
    const method = init.method ?? 'GET';
    const baseUrl = new URL(`${this.baseUrl}/`);
    const requestUrl = new URL(pathOrUrl, baseUrl);
    if (requestUrl.origin !== baseUrl.origin) {
      throw new Error(
        `Refusing to send the Agent Stack API key to a different origin: ${requestUrl.origin}`,
      );
    }
    const url = requestUrl.toString();
    const response = await this.fetch(url, {
      ...init,
      method,
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'x-agent9-project-id': this.projectId,
        ...init.headers,
      },
    });
    return { method, url, response };
  }
}

export async function resolveExampleSession(client, sessionId) {
  if (sessionId) {
    return { sessionId, created: false };
  }
  const { session } = await client.createSession();
  return { sessionId: session.sessionId, created: true };
}

export async function runUploadedFileTurn({
  client,
  sessionId,
  userFileId,
  prompt = '看一下这个文件的内容',
  onEvent,
}) {
  return client.runTurn({
    sessionId,
    text: prompt,
    userFileIds: [userFileId],
    onEvent,
  });
}

export async function downloadDriveFile({
  client,
  relPath,
  outputPath = basename(relPath),
}) {
  if (!relPath) throw new Error('relPath is required');
  if (!outputPath) throw new Error('outputPath is required');

  const { url, expiresAt } = await client.createDownloadUrl({ relPath });
  if (!url || !expiresAt) {
    throw new Error('Download URL response did not include url and expiresAt');
  }
  const file = await client.redeemDownloadUrl({ url, outputPath });
  return {
    relPath,
    expiresAt,
    ...file,
  };
}

export async function uploadInlineFile({
  client,
  filePath,
  contentType = 'application/octet-stream',
  idempotencyKey,
}) {
  const metadata = await fileMetadata(filePath, contentType);
  const { capabilities } = await client.getCapabilities();
  assertWithinMaximum(metadata.byteSize, capabilities.maxUploadBytes);
  if (metadata.byteSize >= capabilities.inlineThreshold) {
    throw new Error(
      `File is ${metadata.byteSize} bytes; inline requires less than ` +
        `${capabilities.inlineThreshold} bytes. Use the multipart example.`,
    );
  }

  const requestKey =
    idempotencyKey ?? currentTimestampIdempotencyKey('inline');
  const { upload } = await client.createUpload({
    idempotencyKey: requestKey,
    ...metadata,
  });
  if (upload.mode !== 'agent9') {
    throw new Error(`Server selected ${upload.mode}; use the multipart example`);
  }

  let file = upload.file;
  if (file.status !== 'ready') {
    const bytes = await readFile(filePath);
    ({ file } = await client.uploadInlineContent({
      uploadId: upload.uploadId,
      contentUrl: upload.contentUrl,
      bytes,
      sha256: metadata.sha256,
    }));
  }
  const status = await client.getUploadStatus(upload.uploadId);
  return {
    capabilities,
    idempotencyKey: requestKey,
    upload,
    file,
    status: status.upload,
  };
}

export async function uploadMultipartFile({
  client,
  filePath,
  contentType = 'application/octet-stream',
  idempotencyKey,
  onProgress = () => {},
}) {
  const metadata = await fileMetadata(filePath, contentType);
  const { capabilities } = await client.getCapabilities();
  assertWithinMaximum(metadata.byteSize, capabilities.maxUploadBytes);
  if (metadata.byteSize < capabilities.inlineThreshold) {
    throw new Error(
      `File is ${metadata.byteSize} bytes; multipart starts at ` +
        `${capabilities.inlineThreshold} bytes. Use the inline example.`,
    );
  }

  const requestKey =
    idempotencyKey ?? currentTimestampIdempotencyKey('multipart');
  const { upload } = await client.createUpload({
    idempotencyKey: requestKey,
    ...metadata,
  });
  if (upload.mode !== 's3') {
    throw new Error(`Server selected ${upload.mode}; use the inline example`);
  }

  let file = upload.file;
  if (file.status !== 'ready') {
    const handle = await open(filePath, 'r');
    const completedParts = [];
    try {
      for (let number = 1; number <= upload.totalParts; number += 1) {
        const offset = (number - 1) * upload.partSize;
        const expectedSize = Math.min(upload.partSize, metadata.byteSize - offset);
        const bytes = Buffer.alloc(expectedSize);
        const { bytesRead } = await handle.read(bytes, 0, expectedSize, offset);
        if (bytesRead !== expectedSize) {
          throw new Error(
            `Part ${number}: expected ${expectedSize} bytes, read ${bytesRead}`,
          );
        }
        const partSha256 = sha256Hex(bytes);
        const { part } = await client.presignPart({
          uploadId: upload.uploadId,
          partNumber: number,
          sha256: partSha256,
        });
        if (part.number !== number || part.size !== expectedSize) {
          throw new Error(
            `Part ${number}: server plan mismatch (number=${part.number}, size=${part.size})`,
          );
        }
        const etag = await client.putPresignedPart({
          url: part.url,
          headers: part.headers,
          bytes,
        });
        completedParts.push({
          number,
          etag,
          sha256: partSha256,
        });
        onProgress({
          number,
          totalParts: upload.totalParts,
          bytesUploaded: offset + expectedSize,
          totalBytes: metadata.byteSize,
        });
      }
    } finally {
      await handle.close();
    }

    ({ file } = await client.completeUpload({
      uploadId: upload.uploadId,
      parts: completedParts,
    }));
  }
  const status = await client.getUploadStatus(upload.uploadId);
  return {
    capabilities,
    idempotencyKey: requestKey,
    upload,
    file,
    status: status.upload,
  };
}

export async function sha256File(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function rfc9530Sha256(sha256) {
  return `sha-256=:${Buffer.from(sha256, 'hex').toString('base64')}:`;
}

export function currentTimestampIdempotencyKey(mode, now = Date.now()) {
  return `agent-stack-${mode}-${now}`;
}

async function fileMetadata(filePath, contentType) {
  const fileStat = await stat(filePath);
  if (!fileStat.isFile()) throw new Error(`${filePath} is not a regular file`);
  return {
    originalName: basename(filePath),
    byteSize: fileStat.size,
    sha256: await sha256File(filePath),
    contentType,
  };
}

function assertWithinMaximum(byteSize, maximum) {
  if (byteSize > maximum) {
    throw new Error(`File is ${byteSize} bytes; server maximum is ${maximum} bytes`);
  }
}

async function throwApiError({ method, url, response }) {
  const responseText = await response.text();
  let payload = null;
  if (responseText) {
    try {
      payload = JSON.parse(responseText);
    } catch {
      payload = null;
    }
  }
  throw new AgentStackApiError({
    method,
    url,
    status: response.status,
    payload,
    responseText,
  });
}

async function writeResponseBody({ response, outputPath }) {
  const absoluteOutputPath = resolve(outputPath);
  await mkdir(dirname(absoluteOutputPath), { recursive: true });
  const temporaryPath = `${absoluteOutputPath}.part-${randomUUID()}`;
  const reader = response.body.getReader();
  let handle;

  try {
    handle = await open(temporaryPath, 'wx', 0o600);
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      await writeAll(handle, value);
    }
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, absoluteOutputPath);
    return absoluteOutputPath;
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    await handle?.close().catch(() => {});
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function writeAll(handle, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await handle.write(
      bytes,
      offset,
      bytes.length - offset,
    );
    if (bytesWritten <= 0) {
      throw new Error('Download output write made no progress');
    }
    offset += bytesWritten;
  }
}

async function* readNdjson(response) {
  if (!response.body) {
    throw new Error('Turn response did not include a response body');
  }
  const decoder = new TextDecoder();
  let buffered = '';
  for await (const chunk of response.body) {
    buffered += decoder.decode(chunk, { stream: true });
    let newlineIndex;
    while ((newlineIndex = buffered.indexOf('\n')) !== -1) {
      const line = buffered.slice(0, newlineIndex).trim();
      buffered = buffered.slice(newlineIndex + 1);
      if (line) yield JSON.parse(line);
    }
  }
  buffered += decoder.decode();
  if (buffered.trim()) yield JSON.parse(buffered);
}
