import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '');
const directory = `${root}/.codex`;
const path = `${directory}/config.toml`;
mkdirSync(directory, { recursive: true });
const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
if (/^\[mcp_servers\.(jev_local|flick)\]/m.test(existing)) {
  console.log('Flick is already configured for this project; existing settings preserved.');
} else {
  const quote = value => JSON.stringify(value);
  const block = `\n[mcp_servers.flick]\ncommand = ${quote(process.execPath)}\nargs = [${quote(`${root}/dist/cli.js`)}]\ncwd = ${quote(root)}\nstartup_timeout_sec = 10\ntool_timeout_sec = 180\n`;
  writeFileSync(path, existing + block, { mode: 0o600 });
  console.log(`Configured Flick in ${path}. Refresh MCP servers or open a new task in this trusted project.`);
}
