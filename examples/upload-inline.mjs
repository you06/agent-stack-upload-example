import { uploadInlineFile } from '../src/agent9-user-files.mjs';
import { exampleConfig, requiredFilePath } from './config.mjs';

const filePath = requiredFilePath();
const config = exampleConfig();

const result = await uploadInlineFile({
  ...config,
  filePath,
});

console.log(
  JSON.stringify(
    {
      path: 'inline',
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
