import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import {
  AgentStackUserFilesClient,
  downloadDriveFile,
  rfc9530Sha256,
  resolveExampleSession,
  runUploadedFileTurn,
  sha256Hex,
  uploadInlineFile,
  uploadMultipartFile,
} from '../src/agent-stack-user-files.mjs';

let root;

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'agent-stack-upload-example-'));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

test('inline example creates an intent, sends RFC 9530 digest, and checks status', async () => {
  const bytes = Buffer.from('inline example');
  const filePath = join(root, 'inline.txt');
  await writeFile(filePath, bytes);
  const digest = sha256Hex(bytes);
  const requests = [];

  const client = testClient(async (url, init) => {
    const request = await capture(url, init);
    requests.push(request);
    if (request.path === '/api/user-files/upload-capabilities') {
      return json({
        capabilities: {
          protocol: 'agent9.user-files.v2',
          inlineThreshold: 1024,
          maxUploadBytes: 4096,
          checksum: 'sha-256',
        },
      });
    }
    if (request.path === '/api/user-files/uploads' && request.method === 'POST') {
      return json(
        {
          upload: {
            uploadId: 'file-inline',
            mode: 'agent9',
            expectedChecksumVerification: 'whole',
            file: { userFileId: 'file-inline', status: 'uploading' },
            contentUrl: '/api/user-files/uploads/file-inline/content',
            expiresAt: '2099-01-01T00:00:00.000Z',
          },
        },
        201,
      );
    }
    if (request.path.endsWith('/content')) {
      assert.equal(request.headers.get('content-digest'), rfc9530Sha256(digest));
      assert.equal(request.headers.get('content-length'), String(bytes.length));
      assert.deepEqual(request.body, bytes);
      return json({
        file: {
          userFileId: 'file-inline',
          status: 'ready',
          sha256: digest,
          checksumVerification: 'whole',
        },
      });
    }
    if (request.path === '/api/user-files/uploads/file-inline') {
      return json({
        upload: {
          uploadId: 'file-inline',
          mode: 'agent9',
          state: 'completed',
          file: {
            userFileId: 'file-inline',
            status: 'ready',
            checksumVerification: 'whole',
          },
        },
      });
    }
    return json({ error: { code: 'not_found' } }, 404);
  });

  const result = await uploadInlineFile({
    client,
    filePath,
    contentType: 'text/plain',
  });

  assert.equal(result.file.status, 'ready');
  assert.equal(result.status.state, 'completed');
  assert.equal(requests.length, 4);
  assert.equal(requests[1].headers.get('authorization'), 'Bearer test-user-key');
  assert.equal(requests[1].headers.get('x-agent9-project-id'), 'project-test');
  assert.match(
    requests[1].headers.get('idempotency-key'),
    /^agent-stack-inline-\d{13}$/u,
  );
  assert.deepEqual(JSON.parse(requests[1].body.toString()), {
    originalName: 'inline.txt',
    byteSize: bytes.length,
    sha256: digest,
    contentType: 'text/plain',
  });
});

test('multipart example binds each digest, sends exact S3 headers, and completes in order', async () => {
  const bytes = Buffer.from('abcdefghij');
  const filePath = join(root, 'multipart.bin');
  await writeFile(filePath, bytes);
  const partBodies = [];
  let completedParts;

  const client = testClient(async (url, init) => {
    const request = await capture(url, init);
    if (request.origin === 'https://s3.example') {
      const number = Number(request.path.slice(1));
      assert.equal(request.method, 'PUT');
      assert.equal(request.headers.get('x-upload-contract'), `part-${number}`);
      assert.equal(request.headers.get('authorization'), null);
      partBodies.push(request.body);
      return new Response('', {
        status: 200,
        headers: { etag: `\"etag-${number}\"` },
      });
    }
    if (request.path === '/api/user-files/upload-capabilities') {
      return json({
        capabilities: {
          protocol: 'agent9.user-files.v2',
          inlineThreshold: 4,
          maxUploadBytes: 100,
          checksum: 'sha-256',
        },
      });
    }
    if (request.path === '/api/user-files/uploads' && request.method === 'POST') {
      return json(
        {
          upload: {
            uploadId: 'file-multipart',
            mode: 's3',
            expectedChecksumVerification: 'part_only',
            file: { userFileId: 'file-multipart', status: 'uploading' },
            partSize: 4,
            totalParts: 3,
            expiresAt: '2099-01-01T00:00:00.000Z',
          },
        },
        201,
      );
    }
    const presign = request.path.match(/\/parts\/(\d+)\/presign$/u);
    if (presign) {
      const number = Number(presign[1]);
      const size = number < 3 ? 4 : 2;
      const expectedPart = bytes.subarray((number - 1) * 4, (number - 1) * 4 + size);
      assert.equal(JSON.parse(request.body.toString()).sha256, sha256Hex(expectedPart));
      return json({
        part: {
          number,
          url: `https://s3.example/${number}`,
          size,
          headers: { 'x-upload-contract': `part-${number}` },
          expiresAt: '2099-01-01T00:00:00.000Z',
        },
      });
    }
    if (request.path.endsWith('/complete')) {
      completedParts = JSON.parse(request.body.toString()).parts;
      return json({
        file: {
          userFileId: 'file-multipart',
          status: 'ready',
          checksumVerification: 'part_only',
        },
      });
    }
    if (request.path === '/api/user-files/uploads/file-multipart') {
      return json({
        upload: {
          uploadId: 'file-multipart',
          mode: 's3',
          state: 'completed',
          file: {
            userFileId: 'file-multipart',
            status: 'ready',
            checksumVerification: 'part_only',
          },
        },
      });
    }
    return json({ error: { code: 'not_found' } }, 404);
  });

  const progress = [];
  const result = await uploadMultipartFile({
    client,
    filePath,
    onProgress: (event) => progress.push(event),
  });

  assert.deepEqual(partBodies, [
    Buffer.from('abcd'),
    Buffer.from('efgh'),
    Buffer.from('ij'),
  ]);
  assert.deepEqual(
    completedParts.map(({ number, etag }) => ({ number, etag })),
    [
      { number: 1, etag: '"etag-1"' },
      { number: 2, etag: '"etag-2"' },
      { number: 3, etag: '"etag-3"' },
    ],
  );
  assert.deepEqual(
    completedParts.map(({ sha256 }) => sha256),
    partBodies.map(sha256Hex),
  );
  assert.equal(progress.length, 3);
  assert.equal(progress.at(-1).bytesUploaded, bytes.length);
  assert.equal(result.file.status, 'ready');
  assert.equal(result.status.state, 'completed');
});

test('examples create or reuse a session and attach the uploaded file to a Turn', async () => {
  const requests = [];
  const client = testClient(async (url, init) => {
    const request = await capture(url, init);
    requests.push(request);
    if (request.path === '/api/sessions') {
      assert.deepEqual(JSON.parse(request.body.toString()), {});
      return json(
        {
          session: {
            sessionId: 'session-created',
          },
        },
        201,
      );
    }
    if (request.path === '/api/sessions/session-created/turns') {
      assert.deepEqual(JSON.parse(request.body.toString()), {
        input: {
          type: 'text',
          text: '看一下这个文件的内容',
          userFileIds: ['file-ready'],
        },
      });
      return new Response(
        [
          JSON.stringify({
            event: 'turn_started',
            turnId: 'turn-1',
            sessionId: 'session-created',
            seq: 1,
            payload: {},
          }),
          '',
          JSON.stringify({
            event: 'assistant_message',
            turnId: 'turn-1',
            sessionId: 'session-created',
            seq: 2,
            payload: { messageId: 'message-1', text: 'File contents' },
          }),
          JSON.stringify({
            event: 'turn_finished',
            turnId: 'turn-1',
            sessionId: 'session-created',
            seq: 3,
            payload: { status: 'succeeded' },
          }),
          '',
        ].join('\n'),
        {
          status: 201,
          headers: { 'content-type': 'application/x-ndjson' },
        },
      );
    }
    return json({ error: { code: 'not_found' } }, 404);
  });

  const created = await resolveExampleSession(client);
  const reused = await resolveExampleSession(client, 'session-existing');
  const turn = await runUploadedFileTurn({
    client,
    sessionId: created.sessionId,
    userFileId: 'file-ready',
  });

  assert.deepEqual(created, { sessionId: 'session-created', created: true });
  assert.deepEqual(reused, { sessionId: 'session-existing', created: false });
  assert.equal(turn.turnId, 'turn-1');
  assert.equal(turn.status, 'succeeded');
  assert.equal(turn.assistantText, 'File contents');
  assert.equal(turn.events.length, 3);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].headers.get('authorization'), 'Bearer test-user-key');
  assert.equal(requests[1].headers.get('x-agent9-project-id'), 'project-test');
});

test('download example mints with a user key and redeems without credentials', async () => {
  const bytes = Buffer.from('downloaded example');
  const outputPath = join(root, 'downloads', 'poem.txt');
  const requests = [];
  const client = testClient(async (url, init) => {
    const request = await capture(url, init);
    requests.push(request);
    if (
      request.path ===
      '/api/console/drive/project-test/file/download-url'
    ) {
      assert.equal(request.method, 'POST');
      assert.deepEqual(JSON.parse(request.body.toString()), {
        relPath: 'session-1/poem.txt',
      });
      return json({
        url: '/api/drive-downloads/opaque-ticket',
        expiresAt: '2099-01-01T00:00:00.000Z',
      });
    }
    if (request.path === '/api/drive-downloads/opaque-ticket') {
      assert.equal(request.method, 'GET');
      assert.equal(request.headers.get('authorization'), null);
      assert.equal(request.headers.get('x-agent9-project-id'), null);
      assert.equal(request.redirect, 'follow');
      assert.equal(request.cache, 'no-store');
      return new Response(bytes, {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      });
    }
    return json({ error: { code: 'not_found' } }, 404);
  });

  const result = await downloadDriveFile({
    client,
    relPath: 'session-1/poem.txt',
    outputPath,
  });

  assert.deepEqual(await readFile(outputPath), bytes);
  assert.equal(result.outputPath, outputPath);
  assert.equal(result.byteSize, bytes.length);
  assert.equal(result.sha256, sha256Hex(bytes));
  assert.equal(result.contentType, 'text/plain');
  assert.equal(result.expiresAt, '2099-01-01T00:00:00.000Z');
  assert.equal(requests.length, 2);
  assert.equal(requests[0].headers.get('authorization'), 'Bearer test-user-key');
  assert.equal(requests[0].headers.get('x-agent9-project-id'), 'project-test');
});

test('download errors redact the bearer ticket', async () => {
  const ticket = 'opaque-ticket-that-must-not-leak';
  const client = testClient(async () =>
    json({ error: { code: 'download_not_found', message: 'Not found' } }, 404),
  );

  await assert.rejects(
    client.redeemDownloadUrl({
      url: `https://agent-stack.example/api/drive-downloads/${ticket}`,
      outputPath: join(root, 'downloads', 'missing.txt'),
    }),
    (error) => {
      assert.equal(error.status, 404);
      assert.equal(error.code, 'download_not_found');
      assert.equal(
        error.url,
        'https://agent-stack.example/api/drive-downloads/[redacted]',
      );
      assert.equal(error.message.includes(ticket), false);
      return true;
    },
  );
});

test('download redemption rejects non-ticket URL variants before fetch', async () => {
  let fetchCalls = 0;
  const client = testClient(async () => {
    fetchCalls += 1;
    throw new Error('fetch should not be called');
  });

  for (const url of [
    'https://s3.example/api/drive-downloads/opaque-ticket',
    '/api/drive-downloads/opaque-ticket/extra',
    '/api/drive-downloads/opaque-ticket?leak=1',
    '/api/drive-downloads/opaque-ticket#fragment',
  ]) {
    await assert.rejects(
      client.redeemDownloadUrl({
        url,
        outputPath: join(root, 'downloads', 'invalid.txt'),
      }),
      /invalid Agent Stack download ticket URL/u,
    );
  }

  assert.equal(fetchCalls, 0);
});

function testClient(fetchImpl) {
  return new AgentStackUserFilesClient({
    baseUrl: 'https://agent-stack.example',
    apiKey: 'test-user-key',
    projectId: 'project-test',
    fetchImpl,
  });
}

async function capture(url, init) {
  const headers = new Headers(init.headers);
  const body =
    init.body === undefined || init.body === null
      ? Buffer.alloc(0)
      : Buffer.from(await new Response(init.body).arrayBuffer());
  const parsed = new URL(url);
  return {
    origin: parsed.origin,
    path: parsed.pathname,
    method: init.method ?? 'GET',
    headers,
    body,
    redirect: init.redirect,
    cache: init.cache,
  };
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
