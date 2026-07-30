import { AgentStackUserFilesClient } from '../src/agent-stack-user-files.mjs';
import { basename } from 'node:path';

export function exampleConfig() {
  const baseUrl = requiredEnv('AGENT_STACK_BASE_URL');
  const apiKey = requiredEnv('AGENT_STACK_USER_API_KEY');
  const projectId = requiredEnv('AGENT_STACK_PROJECT_ID');
  return {
    client: new AgentStackUserFilesClient({ baseUrl, apiKey, projectId }),
    contentType: process.env.CONTENT_TYPE ?? 'application/octet-stream',
    sessionId: process.env.AGENT_STACK_SESSION_ID?.trim() || undefined,
  };
}

export function requiredFilePath() {
  const filePath = process.argv[2];
  if (!filePath) {
    throw new Error(`Usage: ${process.argv[1]} <file-path>`);
  }
  return filePath;
}

export function requiredDownloadRequest() {
  const relPath = process.argv[2];
  if (!relPath) {
    throw new Error(`Usage: ${process.argv[1]} <drive-rel-path> [output-path]`);
  }
  return {
    relPath,
    outputPath: process.argv[3] ?? basename(relPath),
  };
}

export function optionalDirectoryPath() {
  return process.argv.length > 2 ? process.argv[2] : undefined;
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
