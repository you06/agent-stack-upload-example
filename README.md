# Agent9 public 2-path upload examples

Dependency-free Node.js examples for the public Agent9 user-file upload API:

- **Inline path:** the client sends the complete file to Agent9. Agent9 verifies the whole-file SHA-256.
- **Multipart path:** Agent9 returns checksum-bound presigned URLs. The client sends each part directly to S3, then asks Agent9 to complete the upload.

The server chooses the path from the current `inlineThreshold`. Do not hard-code that threshold: both examples read `GET /api/user-files/upload-capabilities` first.

## Requirements

- Node.js 20 or newer
- An Agent9 **user API key** (`ag9_uak...`)
- A project id in the API key's workspace

Session cookies and workspace API keys are intentionally rejected by this public API.

## Configuration

Export the required variables:

```bash
export AGENT_STACK_BASE_URL='https://your-agent9-host.example'
export AGENT_STACK_USER_API_KEY='ag9_uak_replace_me'
export AGENT_STACK_PROJECT_ID='your-project-id'
```

Optional variables:

```bash
export CONTENT_TYPE='application/pdf'
```

Each example creates its `Idempotency-Key` from the current millisecond timestamp when the process starts. The same key is reused throughout that upload attempt. Starting the command again creates a new upload intent.

The examples never print the API key.

## Inline upload

Choose a file smaller than the server's current `inlineThreshold`:

```bash
npm run example:inline -- ./small-file.txt
```

The example performs:

1. `GET /api/user-files/upload-capabilities`
2. `POST /api/user-files/uploads`
3. `PUT /api/user-files/uploads/{uploadId}/content`
4. `GET /api/user-files/uploads/{uploadId}`

The raw `PUT` includes exact `Content-Length` and an RFC 9530 header:

```text
Content-Digest: sha-256=:<base64 SHA-256>:
```

A settled inline file reports `checksumVerification: "whole"`.

## Multipart upload

Choose a file at or above the current `inlineThreshold`, up to the returned `maxUploadBytes`:

```bash
npm run example:multipart -- ./large-file.bin
```

The example performs:

1. `GET /api/user-files/upload-capabilities`
2. `POST /api/user-files/uploads`
3. For every server-defined part:
   - compute the exact part SHA-256;
   - `POST /api/user-files/uploads/{uploadId}/parts/{partNumber}/presign`;
   - `PUT` the exact bytes directly to the returned S3 URL with every returned header;
   - retain the S3 `ETag`.
4. `POST /api/user-files/uploads/{uploadId}/complete` with all parts in ascending order.
5. `GET /api/user-files/uploads/{uploadId}`

The server, not the caller, defines `partSize` and `totalParts`. Only the final part may be smaller.

The completion body contains the same SHA-256 bound at presign time:

```json
{
  "parts": [
    {
      "number": 1,
      "etag": "\"example-etag\"",
      "sha256": "lowercase-hex-sha256"
    }
  ]
}
```

For a one-part S3 upload the server can report `checksumVerification: "whole"`. A multi-part upload currently reports `"part_only"` because every part is verified but the assembled object's whole-file SHA-256 is not yet verified by Drive9.

## Retry and recovery

- Retry `POST /uploads` within the same process with the same timestamp-based `Idempotency-Key` and exact metadata to replay the durable intent.
- Starting the command again generates a new timestamp and therefore creates a new upload intent.
- `GET /uploads/{uploadId}` returns the durable intent and file state.
- `DELETE /uploads/{uploadId}` abandons the intent and aborts remote multipart state when present.
- A `409` means the idempotency key was reused with different input or an operation is already in progress.
- A typed `503` means durable state or Drive9 is temporarily unavailable. Preserve the idempotency key and retry.
- After a typed `413`, read capabilities again before changing the plan.

The examples throw `Agent9ApiError` with `status`, `code`, `details`, and the parsed error payload so applications can implement their own retry policy.

## Use as a library

```js
import {
  Agent9UserFilesClient,
  uploadInlineFile,
  uploadMultipartFile,
} from './src/agent9-user-files.mjs';

const client = new Agent9UserFilesClient({
  baseUrl: process.env.AGENT_STACK_BASE_URL,
  apiKey: process.env.AGENT_STACK_USER_API_KEY,
  projectId: process.env.AGENT_STACK_PROJECT_ID,
});

const result = await uploadInlineFile({
  client,
  filePath: './small-file.txt',
  contentType: 'text/plain',
});

console.log(result.file);
```

Use `uploadMultipartFile` with the same client for the S3 path.

## Validation

Run the dependency-free contract tests:

```bash
npm test
```

The tests verify authentication headers, request metadata, RFC 9530 digest formatting, exact part boundaries, checksum binding, direct-S3 headers, ETag retention, ordered completion, and final status lookup.

## Contract source

The authoritative API contract is the `UserFiles` section of Agent9's `docs/openapi.yaml`. This repository is an example client, not a replacement for the OpenAPI schema.
