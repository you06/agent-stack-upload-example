# Agent Stack file examples

Dependency-free Node.js examples for the public Agent Stack file APIs:

- **Inline path:** the client sends the complete file to Agent Stack. Agent Stack verifies the whole-file SHA-256.
- **Multipart path:** Agent Stack returns checksum-bound presigned URLs. The client sends each part directly to S3, then asks Agent Stack to complete the upload.
- **List path:** the client lists Project Drive files and prints their download-ready `relPath` values.
- **Download path:** the client exchanges its user API key for a 60-second opaque URL, then redeems that URL without credentials. Agent Stack streams inline bytes or redirects large files to S3.
- **Artifact paths:** the client lists the caller's ready Artifact catalog and downloads one immutable revision through the same two-phase ticket flow, with end-to-end size and SHA-256 verification.

The server chooses the upload path from the current `inlineThreshold`. Do not
hard-code that threshold: both upload examples read
`GET /api/user-files/upload-capabilities` first.

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
web console. When reusing a Session, the user bound to the API key must own or
participate in that Session; otherwise the API returns `session_not_found`.

Each example creates its `Idempotency-Key` from the current millisecond timestamp when the process starts. The same key is reused throughout that upload attempt. Starting the command again creates a new upload intent.

The examples never print the API key.

## List files

List the Project Drive's legacy flat file view:

```bash
npm run example:list-files
```

The response contains a `files` array. Each entry includes `name`, `relPath`,
`size`, `modifiedAt`, `type`, and `isDir`; pass a file's `relPath` to the
download example.

To browse one directory instead, pass its project-relative path:

```bash
npm run example:list-files -- 'sess_0f84cddee3c64fc688014aa9a11e6bd3'
```

Directory mode sends `GET /api/console/drive/{projectId}?path=...` and returns
separate `folders` and `files` arrays plus breadcrumbs. Pass an empty argument
(`''`) to browse the project root as a directory. Listing is not recursive in
directory mode; use a returned folder's `relPath` for the next request.

## Download

Pass the Drive-relative path returned by the Drive listing API. An optional
second argument selects the local output path; otherwise the remote basename is
written in the current directory.

```bash
npm run example:download -- \
  'sess_0f84cddee3c64fc688014aa9a11e6bd3/给你的诗.docx' \
  './给你的诗.docx'
```

The example performs:

1. `POST /api/console/drive/{projectId}/file/download-url` with the user API
   key and `{ "relPath": "..." }`.
2. Read the returned opaque URL and expiry. The URL itself is never printed.
3. `GET /api/drive-downloads/{ticket}` **without** the API key or project
   header.
4. Follow an Agent Stack redirect to S3 when the file uses object storage, or
   stream an inline response directly.
5. Write through a private temporary file, atomically rename it to the requested
   output path, and print the final byte size and SHA-256.

The Agent Stack ticket is reusable for 60 seconds. A redeemed S3 URL can remain
usable for up to 10 additional minutes. Revoking the API key or removing the
user from the project blocks new URLs but does not revoke an already-issued
ticket or S3 URL. A successful download returns the exact version captured at
mint time; overwrite or deletion can make it return `404`, but it never switches
to a newer version.

The current S3 redirect does not guarantee preservation of the original browser
download filename. This CLI writes to the explicit local output path and is not
affected by that browser limitation.

## List Artifacts

List the caller's ready current Artifact catalog:

```bash
npm run example:list-artifacts
```

Each `artifacts` entry contains logical Artifact metadata and its current ready
`revision`, including the `artifactId`, `revisionId`, `safeName`, `byteSize`, and
`sha256` needed for download. The response is paginated and includes
`nextCursor`.

Pass an optional free-text query to search display names and descriptions:

```bash
npm run example:list-artifacts -- 'quarterly report'
```

The reusable `client.listArtifacts()` method also accepts `kind`, `role`,
`cursor`, and `limit` for filtered or paginated clients.

## Download an Artifact

Pass an `artifactId`, `revisionId`, and explicit local output path from the
Artifact listing:

```bash
npm run example:download-artifact -- \
  'artifact_abc123' \
  'revision_def456' \
  './quarterly-report.pdf'
```

The example performs:

1. `POST /api/artifacts/{artifactId}/revisions/{revisionId}/download-url` with
   the user API key and project header.
2. Read the relative 60-second URL, immutable `byteSize`, and required
   `sha256`. The bearer URL itself is never printed.
3. Redeem `/api/drive-downloads/{ticket}` without credentials. Despite the
   route name, this endpoint redeems both Drive and Artifact tickets.
4. Follow a validated S3 redirect or receive inline bytes, then write through a
   private temporary file and atomically rename it.
5. Recompute the downloaded file's byte size and SHA-256. A mismatch fails the
   command and deletes the output file.

Artifact authorization is unchanged: ordinary Artifacts remain scoped to their
owner, while eligible generated media can also be read by an active source
Session participant. This demo does not make Artifacts project-wide.

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
  downloadArtifactRevision,
  downloadDriveFile,
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

Use `client.listDriveFiles()` for the flat Project Drive file list, or
`client.listDriveFiles({ directoryPath: 'session-id' })` to browse one
directory.

Use `downloadDriveFile` for the download path:

```js
const downloaded = await downloadDriveFile({
  client,
  relPath: 'session-id/output/report.pdf',
  outputPath: './report.pdf',
});

console.log(downloaded.sha256);
```

Use `client.listArtifacts()` and `downloadArtifactRevision` for immutable
Artifact revisions:

```js
const { artifacts } = await client.listArtifacts({ limit: 25 });
const { artifact, revision } = artifacts[0];

const downloadedArtifact = await downloadArtifactRevision({
  client,
  artifactId: artifact.artifactId,
  revisionId: revision.revisionId,
  outputPath: `./${revision.safeName}`,
});

console.log(downloadedArtifact.sha256);
```

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
retention, ordered completion, final status lookup, authenticated Drive
listing, authenticated URL minting, anonymous redemption, and streamed file
output.

Artifact tests additionally verify authenticated catalog listing, authenticated
Artifact ticket minting, anonymous shared redemption, and deletion of output
when immutable size or SHA-256 metadata does not match.

## Contract source

The authoritative API contract is Agent Stack's `docs/openapi.yaml`. This
repository is an example client, not a replacement for the OpenAPI schema.
