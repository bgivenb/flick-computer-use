import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
console.log(JSON.stringify({ mcpServers: { flick: { command: process.execPath, args: [resolve(root, 'dist/cli.js')] } } }, null, 2));
