import { downloadDriveFile } from '../src/agent-stack-user-files.mjs';
import { exampleConfig, requiredDownloadRequest } from './config.mjs';

const { client } = exampleConfig();
const { relPath, outputPath } = requiredDownloadRequest();
const result = await downloadDriveFile({
  client,
  relPath,
  outputPath,
});

console.log(
  JSON.stringify(
    {
      relPath: result.relPath,
      outputPath: result.outputPath,
      expiresAt: result.expiresAt,
      byteSize: result.byteSize,
      sha256: result.sha256,
      contentType: result.contentType,
    },
    null,
    2,
  ),
);
