import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import {
  Agent9UserFilesClient,
  rfc9530Sha256,
  sha256Hex,
  uploadInlineFile,
  uploadMultipartFile,
} from '../src/agent9-user-files.mjs';

let root;

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'agent9-upload-example-'));
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
  assert.match(requests[1].headers.get('idempotency-key'), /^agent9-example-inline-/u);
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

function testClient(fetchImpl) {
  return new Agent9UserFilesClient({
    baseUrl: 'https://agent9.example',
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
  };
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
