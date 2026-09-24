import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { root } from '../src/config.js';
import { mcpClient } from '../tests/mcp-client.js';

const temp = await mkdtemp(join(tmpdir(), 'jev-ocr-test-'));
const bundle = join(temp, 'OCRLab.app');
const executable = join(bundle, 'Contents/MacOS/OCRLab');
await mkdir(join(bundle, 'Contents/MacOS'), { recursive: true });
await writeFile(join(bundle, 'Contents/Info.plist'), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>local.jev-mcp.OCRLab</string><key>CFBundleExecutable</key><string>OCRLab</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>');
assert.equal(spawnSync('swiftc', [join(root, 'tests/OCRFixture.swift'), '-o', executable, '-framework', 'AppKit'], { stdio: 'inherit' }).status, 0);
const output = join(temp, 'clicked.txt');
const app = spawn(executable, [output], { stdio: 'ignore' });
const { client, call } = await mcpClient(join(temp, 'data'), { TYPESAFE_API_KEY: '' });
try {
  for (let i = 0; i < 30; i++) {
    if ((await call('computer_apps')).apps.some((a: any) => a.bundleId === 'local.jev-mcp.OCRLab')) break;
    await delay(100);
  }
  await delay(200);
  const session = await call('computer_open', { kind: 'macos', bundleId: 'local.jev-mcp.OCRLab', ocr: 'off' });
  assert.equal(session.observation.ocr.used, false);
  assert.equal(JSON.stringify(session.observation).includes('Painted button'), false);
  const observed = await call('computer_inspect', { sessionId: session.sessionId, ocr: 'auto' });
  assert.equal(observed.ocr.used, true);
  const target = observed.elements.find((e: any) => e.name === 'Painted button' && e.source === 'ocr');
  assert.ok(target, 'OCR must find text absent from the Accessibility tree');
  await call('computer_act', { sessionId: session.sessionId, observationId: observed.id, action: { kind: 'click', elementId: target.id } });
  assert.equal(await readFile(output, 'utf8'), 'clicked', 'The rendered control must independently receive the click');
  const after = await call('computer_inspect', { sessionId: session.sessionId, ocr: 'always' });
  assert.match(after.text, /OCR click worked/);
  for (const action of [{ button: 'right' }, { button: 'middle' }, { button: 'left', clickCount: 2 }]) {
    const fresh = await call('computer_inspect', { sessionId: session.sessionId, ocr: 'always' });
    const button = fresh.elements.find((e: any) => e.source === 'ocr' && e.name.includes('OCR click worked'));
    assert.ok(button);
    await call('computer_act', { sessionId: session.sessionId, observationId: fresh.id, action: { kind: 'click', elementId: button.id, ...action } });
  }
  const clicks = JSON.parse(await readFile(output + '.events.json', 'utf8'));
  assert.deepEqual(clicks.map((e: any) => e.button), [0, 1, 2, 0, 0]);
  assert.deepEqual(clicks.slice(-2).map((e: any) => e.count), [1, 2]);
  console.log(JSON.stringify({ passed: true, localOCR: true, independentlyVerifiedClick: true, buttons: ['left', 'right', 'middle', 'double'], ocrMs: observed.ocr.durationMs }));
  await call('computer_close', { sessionId: session.sessionId });
} finally { await client.close(); app.kill(); await delay(100); await rm(temp, { recursive: true, force: true }); }
