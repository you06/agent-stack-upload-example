import { Agent9UserFilesClient } from '../src/agent9-user-files.mjs';

export function exampleConfig() {
  const baseUrl = requiredEnv('AGENT9_BASE_URL');
  const apiKey = requiredEnv('AGENT9_USER_API_KEY');
  const projectId = requiredEnv('AGENT9_PROJECT_ID');
  return {
    client: new Agent9UserFilesClient({ baseUrl, apiKey, projectId }),
    contentType: process.env.CONTENT_TYPE ?? 'application/octet-stream',
    idempotencyKey: process.env.AGENT9_IDEMPOTENCY_KEY,
  };
}

export function requiredFilePath() {
  const filePath = process.argv[2];
  if (!filePath) {
    throw new Error(`Usage: ${process.argv[1]} <file-path>`);
  }
  return filePath;
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
