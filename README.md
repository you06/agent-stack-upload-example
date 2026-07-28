# Agent Stack public 2-path upload examples

Dependency-free Node.js examples for the public Agent Stack user-file upload API:

- **Inline path:** the client sends the complete file to Agent Stack. Agent Stack verifies the whole-file SHA-256.
- **Multipart path:** Agent Stack returns checksum-bound presigned URLs. The client sends each part directly to S3, then asks Agent Stack to complete the upload.

The server chooses the path from the current `inlineThreshold`. Do not hard-code that threshold: both examples read `GET /api/user-files/upload-capabilities` first.

## Requirements

- Node.js 20 or newer
- An Agent Stack **user API key** (`ag9_uak...`)
- A project id in the API key's workspace

Session cookies and workspace API keys are intentionally rejected by this public API.

## Configuration

Export the required variables:

```bash
export AGENT_STACK_BASE_URL='https://your-agent-stack-host.example'
export AGENT_STACK_USER_API_KEY='ag9_uak_replace_me'
export AGENT_STACK_PROJECT_ID='your-project-id'
```

Optional variables:

```bash
export CONTENT_TYPE='application/pdf'
export AGENT_STACK_SESSION_ID='existing-session-id'
```

When `AGENT_STACK_SESSION_ID` is omitted, the example creates a new session. When
it is set, the example reuses that session. In both cases, the uploaded
`userFileId` is attached to a new Turn with the prompt `看一下这个文件的内容`
("Look at the contents of this file"). The Session and Turn are visible in the
web console.

Each example creates its `Idempotency-Key` from the current millisecond timestamp when the process starts. The same key is reused throughout that upload attempt. Starting the command again creates a new upload intent.

The examples never print the API key.

## Inline upload

Choose a file smaller than the server's current `inlineThreshold`:

```bash
npm run example:inline -- ./small-file.txt
```

The example performs:

1. Reuse `AGENT_STACK_SESSION_ID`, or `POST /api/sessions` to create a session.
2. `GET /api/user-files/upload-capabilities`
3. `POST /api/user-files/uploads`
4. `PUT /api/user-files/uploads/{uploadId}/content`
5. `GET /api/user-files/uploads/{uploadId}`
6. `POST /api/sessions/{sessionId}/turns` with the ready `userFileId`

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

1. Reuse `AGENT_STACK_SESSION_ID`, or `POST /api/sessions` to create a session.
2. `GET /api/user-files/upload-capabilities`
3. `POST /api/user-files/uploads`
4. For every server-defined part:
   - compute the exact part SHA-256;
   - `POST /api/user-files/uploads/{uploadId}/parts/{partNumber}/presign`;
   - `PUT` the exact bytes directly to the returned S3 URL with every returned header;
   - retain the S3 `ETag`.
5. `POST /api/user-files/uploads/{uploadId}/complete` with all parts in ascending order.
6. `GET /api/user-files/uploads/{uploadId}`
7. `POST /api/sessions/{sessionId}/turns` with the ready `userFileId`

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

The examples throw `AgentStackApiError` with `status`, `code`, `details`, and the parsed error payload so applications can implement their own retry policy.

## Use as a library

```js
import {
  AgentStackUserFilesClient,
  uploadInlineFile,
  uploadMultipartFile,
} from './src/agent-stack-user-files.mjs';

const client = new AgentStackUserFilesClient({
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

The runnable examples additionally use `resolveExampleSession` and
`runUploadedFileTurn` to create or reuse a Session and submit the uploaded file
to a Turn.

## Validation

Run the dependency-free contract tests:

```bash
npm test
```

The tests verify authentication headers, Session creation/reuse, selected
`userFileId` Turn input, NDJSON Turn responses, request metadata, RFC 9530 digest
formatting, exact part boundaries, checksum binding, direct-S3 headers, ETag
retention, ordered completion, and final status lookup.

## Contract source

The authoritative API contract is the `UserFiles` section of Agent Stack's `docs/openapi.yaml`. This repository is an example client, not a replacement for the OpenAPI schema.
