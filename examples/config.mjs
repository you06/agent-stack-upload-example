import { AgentStackUserFilesClient } from '../src/agent-stack-user-files.mjs';

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

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
