import {
  resolveExampleSession,
  runUploadedFileTurn,
  uploadMultipartFile,
} from '../src/agent-stack-user-files.mjs';
import { exampleConfig, requiredFilePath } from './config.mjs';

const filePath = requiredFilePath();
const { client, contentType, sessionId: configuredSessionId } = exampleConfig();
const session = await resolveExampleSession(client, configuredSessionId);

const result = await uploadMultipartFile({
  client,
  contentType,
  filePath,
  onProgress({ number, totalParts, bytesUploaded, totalBytes }) {
    console.error(
      `Uploaded part ${number}/${totalParts} (${bytesUploaded}/${totalBytes} bytes)`,
    );
  },
});
const turn = await runUploadedFileTurn({
  client,
  sessionId: session.sessionId,
  userFileId: result.file.userFileId,
});

console.log(
  JSON.stringify(
    {
      path: 'multipart',
      sessionId: session.sessionId,
      sessionCreated: session.created,
      idempotencyKey: result.idempotencyKey,
      uploadId: result.upload.uploadId,
      userFileId: result.file.userFileId,
      status: result.file.status,
      checksumVerification: result.file.checksumVerification,
      turnId: turn.turnId,
      turnStatus: turn.status,
      assistantText: turn.assistantText,
    },
    null,
    2,
  ),
);
