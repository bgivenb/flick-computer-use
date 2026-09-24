import { mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
if (process.platform !== 'darwin') { console.log('Native macOS helper skipped on this platform. Browser automation is available.'); process.exit(0); }
mkdirSync(`${root}.local/bin`, { recursive: true, mode: 0o700 });
const result = spawnSync('swiftc', ['-O', `${root}native/MacHelper.swift`, '-o', `${root}.local/bin/jev-macos`, '-framework', 'AppKit', '-framework', 'ApplicationServices', '-framework', 'Vision'], { stdio: 'inherit' });
if (result.error) console.error('Install Xcode Command Line Tools to build the native helper.');
process.exit(result.status ?? 1);
