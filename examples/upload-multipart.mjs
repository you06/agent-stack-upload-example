import { uploadMultipartFile } from '../src/agent-stack-user-files.mjs';
import { exampleConfig, requiredFilePath } from './config.mjs';

const filePath = requiredFilePath();
const config = exampleConfig();

const result = await uploadMultipartFile({
  ...config,
  filePath,
  onProgress({ number, totalParts, bytesUploaded, totalBytes }) {
    console.error(
      `Uploaded part ${number}/${totalParts} (${bytesUploaded}/${totalBytes} bytes)`,
    );
  },
});

console.log(
  JSON.stringify(
    {
      path: 'multipart',
      idempotencyKey: result.idempotencyKey,
      uploadId: result.upload.uploadId,
      userFileId: result.file.userFileId,
      status: result.file.status,
      checksumVerification: result.file.checksumVerification,
    },
    null,
    2,
  ),
);
