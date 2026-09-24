import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { resolve } from 'node:path';
import { root } from '../src/config.js';

export async function mcpClient(dataDir: string, env: Record<string, string> = {}) {
  const client = new Client({ name: 'flick-verification', version: '0.1.0' });
  // The SDK forwards only a small default environment. Live checks must also honor
  // the same credential/model configuration as the server launched by an MCP client.
  const providerEnv = Object.fromEntries(['TYPESAFE_API_KEY', 'TYPESAFE_MODEL', 'JEV_ENV_FILE']
    .filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]!]));
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve(root, 'dist/cli.js')], cwd: root,
    env: { ...getDefaultEnvironment(), ...providerEnv, JEV_DATA_DIR: dataDir, ...env }, stderr: 'pipe' });
  transport.stderr?.on('data', () => {});
  await client.connect(transport);
  return { client, transport, call: async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as Array<{ type: string; text?: string }>).find(c => c.type === 'text')?.text;
    if (result.isError) throw new Error(text ?? 'MCP tool failed.');
    return text ? JSON.parse(text) : result;
  } };
}
