import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = new Set(process.argv.slice(2));
if (args.has('--help')) {
  console.log('Usage: node scripts/setup-agent.mjs [--native]\nInstalls pinned dependencies, builds the MCP, installs Chromium, and creates .env.local only when missing.\n--native also builds the experimental Swift helper on macOS. It does not change OS permissions.');
  process.exit(0);
}
if ([...args].some(arg => arg !== '--native')) throw new Error('Unknown option. Use --help.');
if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Flick requires Node.js 22 or newer.');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.error || result.status !== 0) {
    console.error(`Setup stopped: ${command} ${args.join(' ')}`);
    if (result.error) console.error(result.error.message);
    process.exit(result.status || 1);
  }
}
run(npm, ['ci']);
run(npm, ['run', 'build']);
run(process.execPath, [resolve(root, 'node_modules/playwright/cli.js'), 'install', 'chromium']);
if (args.has('--native')) {
  if (process.platform !== 'darwin') throw new Error('--native currently requires macOS. Browser setup is complete.');
  run(npm, ['run', 'build:native']);
}
const env = resolve(root, '.env.local');
const createdEnv = !existsSync(env);
if (createdEnv) copyFileSync(resolve(root, '.env.example'), env);
if (process.platform !== 'win32') chmodSync(env, 0o600);
console.log(JSON.stringify({ installed: true, credentialFileCreated: createdEnv,
  next: ['Set TYPESAFE_API_KEY in .env.local if not already configured.', 'Run npm run mcp:config and merge its launch entry into your current MCP client.', 'Run npm run doctor and npm run test:live, then verify computer_health from the connected client.'],
  guide: resolve(root, 'INSTALL.md') }, null, 2));
