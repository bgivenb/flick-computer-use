import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { root, loadConfig } from '../src/config.js';
import { mcpClient } from '../tests/mcp-client.js';

if (process.platform !== 'darwin') throw new Error('This smoke test requires macOS.');
const config = loadConfig();
const temp = await mkdtemp(join(tmpdir(), 'jev-native-test-'));
const bundle = join(temp, 'JevTestLab.app');
const executable = join(bundle, 'Contents/MacOS/JevTestLab');
await mkdir(join(bundle, 'Contents/MacOS'), { recursive: true });
await writeFile(join(bundle, 'Contents/Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>local.jev-mcp.TestLab</string><key>CFBundleExecutable</key><string>JevTestLab</string><key>CFBundleName</key><string>Jev Test Lab</string><key>CFBundlePackageType</key><string>APPL</string><key>NSHighResolutionCapable</key><true/></dict></plist>`);
const compile = spawnSync('swiftc', [join(root, 'tests/NativeFixture.swift'), '-o', executable, '-framework', 'AppKit'], { stdio: 'inherit' });
if (compile.status !== 0) throw new Error('Native test app did not compile.');
const output = join(temp, 'saved.json');
const app = spawn(executable, [output], { stdio: 'ignore' });
const { client, call } = await mcpClient(join(temp, 'data'));
try {
  const health = await call('computer_health');
  assert.equal(health.native.accessibility, true, 'Grant Accessibility permission to the launching app before native tests.');
  for (let i = 0; i < 30; i++) {
    const apps = await call('computer_apps');
    if (apps.apps.some((a: any) => a.bundleId === 'local.jev-mcp.TestLab')) break;
    await delay(100);
  }
  const opened = await call('computer_open', { kind: 'macos', bundleId: 'local.jev-mcp.TestLab' });
  console.log('Native fixture controls:', opened.observation.elements.map((e: any) => ({ role: e.role, name: e.name })));
  const task = await call('computer_run', {
    sessionId: opened.sessionId,
    goal: 'Fill Contact email with the supplied email. Enable Include column headers. Click Save settings.',
    inputs: { email: 'demo@example.com' }, until: [{ kind: 'text', text: 'Native settings saved' },
      { kind: 'field', name: 'Contact email', value: 'demo@example.com' }, { kind: 'checked', name: 'Include column headers', checked: true }],
    maxSteps: 8, timeoutMs: 30000,
  });
  let result;
  do { result = await call('computer_status', { taskId: task.id, waitMs: 10000 }); } while (result.status === 'running');
  console.log(JSON.stringify({ status: result.status, reason: result.reason, steps: result.steps, metrics: result.metrics, events: result.events }, null, 2));
  assert.equal(result.status, 'succeeded', result.reason);
  assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), { email: 'demo@example.com', headers: true });
  const screenshot = await client.callTool({ name: 'computer_screenshot', arguments: { sessionId: opened.sessionId } });
  assert.equal(screenshot.isError, undefined);
  const image = (screenshot.content as any[]).find(c => c.type === 'image');
  assert.ok(image?.data);
  await writeFile(join(config.localDir, 'native-smoke.png'), Buffer.from(image.data, 'base64'), { mode: 0o600 });
  await writeFile(join(config.localDir, 'last-native-smoke.json'), JSON.stringify({ testedAt: new Date().toISOString(), status: result.status,
    independentlyVerified: true, steps: result.steps, metrics: result.metrics }, null, 2), { mode: 0o600 });
  await call('computer_close', { sessionId: opened.sessionId });
} finally { await client.close(); app.kill(); await delay(150); await rm(temp, { recursive: true, force: true }); }
