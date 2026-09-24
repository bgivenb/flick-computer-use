import { createInterface } from 'node:readline';
import { writeFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { loadConfig } from '../src/config.js';
import { mcpClient } from '../tests/mcp-client.js';

// Interactive developer harness: all operations still travel over real MCP stdio.
const config = loadConfig();
const { client } = await mcpClient(config.localDir);
console.log(JSON.stringify({ ready: true }));
const lines = createInterface({ input: process.stdin, terminal: false });
for await (const line of lines) {
  if (!line.trim()) continue;
  try {
    const request = JSON.parse(line);
    if (request.name === 'exit') break;
    const result = await client.callTool({ name: request.name, arguments: request.arguments ?? {} });
    const output: unknown[] = [];
    for (const item of result.content as any[]) {
      if (item.type === 'text') {
        let value; try { value = JSON.parse(item.text); } catch { value = item.text; }
        if (request.save) {
          const path = join(config.localDir, basename(request.save) + '.json');
          await writeFile(path, JSON.stringify(value, null, 2), { mode: 0o600 });
          output.push({ saved: path });
        }
        output.push(value);
      } else if (item.type === 'image') {
        const path = join(config.localDir, basename(request.imageName ?? 'mcp-image') + (item.mimeType === 'image/jpeg' ? '.jpg' : '.png'));
        await writeFile(path, Buffer.from(item.data, 'base64'), { mode: 0o600 });
        output.push({ image: path, mimeType: item.mimeType });
      }
    }
    console.log(JSON.stringify({ isError: result.isError ?? false, output }));
  } catch (error) { console.log(JSON.stringify({ error: error instanceof Error ? error.message : 'Failed' })); }
}
await client.close();
