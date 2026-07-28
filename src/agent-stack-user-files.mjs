import { createHash } from 'node:crypto';
import { open, readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { basename } from 'node:path';

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

  async #requestJson(pathOrUrl, init = {}) {
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
