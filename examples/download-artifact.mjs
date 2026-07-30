import { downloadArtifactRevision } from '../src/agent-stack-user-files.mjs';
import {
  exampleConfig,
  requiredArtifactDownloadRequest,
} from './config.mjs';

const { client } = exampleConfig();
const request = requiredArtifactDownloadRequest();
const result = await downloadArtifactRevision({
  client,
  ...request,
});

console.log(
  JSON.stringify(
    {
      artifactId: result.artifactId,
      revisionId: result.revisionId,
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
