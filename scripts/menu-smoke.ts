import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { root } from '../src/config.js';
import { mcpClient } from '../tests/mcp-client.js';

// No model calls: exercises native context menus, region capture, and click gating through real MCP stdio.
if (process.platform !== 'darwin') throw new Error('This smoke test requires macOS.');
const temp = await mkdtemp(join(tmpdir(), 'jev-menu-test-'));
const bundle = join(temp, 'MenuLab.app');
await mkdir(join(bundle, 'Contents/MacOS'), { recursive: true });
await writeFile(join(bundle, 'Contents/Info.plist'), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>local.jev-mcp.MenuLab</string><key>CFBundleExecutable</key><string>MenuLab</string><key>CFBundlePackageType</key><string>APPL</string><key>NSHighResolutionCapable</key><true/></dict></plist>');
assert.equal(spawnSync('swiftc', [join(root, 'tests/MenuFixture.swift'), '-o', join(bundle, 'Contents/MacOS/MenuLab'), '-framework', 'AppKit'], { stdio: 'inherit' }).status, 0);
const output = join(temp, 'result.txt');
const app = spawn(join(bundle, 'Contents/MacOS/MenuLab'), [output], { stdio: 'ignore' });
const { client, call } = await mcpClient(join(temp, 'data'), { TYPESAFE_API_KEY: '' });
try {
  for (let i = 0; i < 30; i++) {
    if ((await call('computer_apps')).apps.some((a: any) => a.bundleId === 'local.jev-mcp.MenuLab')) break;
    await delay(100);
  }
  await delay(300);
  const session = await call('computer_open', { kind: 'macos', bundleId: 'local.jev-mcp.MenuLab', ocr: 'off' });
  const photo = session.observation.elements.find((e: any) => e.name === 'Sample photograph');
  assert.ok(photo?.clickVariants?.includes('right'), 'the photo must offer a context menu');

  // 1. Region capture: OCR boxes must land inside the real window, not the 66×20 child window over the title bar.
  const scanned = await call('computer_inspect', { sessionId: session.sessionId, ocr: 'always' });
  const text = scanned.elements.find((e: any) => e.source === 'ocr' && /Painted caption/.test(e.name));
  assert.ok(text, 'OCR must read the painted caption');
  assert.ok(text.bounds.width > 100 && text.bounds.height > 10, `OCR bounds must be real screen geometry, got ${JSON.stringify(text.bounds)}`);

  // 2. A right-click opens a menu that Accessibility reports as the whole observation.
  const before = (await call('computer_inspect', { sessionId: session.sessionId, ocr: 'off' }));
  const started = Date.now();
  const menu = await call('computer_act', { sessionId: session.sessionId, observationId: before.id, action: { kind: 'click', elementId: before.elements.find((e: any) => e.name === 'Sample photograph').id, button: 'right' } });
  const rightClickMs = Date.now() - started;
  assert.equal(menu.modal?.kind, 'menu', 'the open context menu must be observed');
  const copy = menu.elements.find((e: any) => e.name === 'Copy Image' && e.modal);
  assert.ok(copy, `menu items: ${menu.elements.map((e: any) => e.name).join(', ')}`);

  // 3. Choosing the item copies a new image; the fixture independently records the command.
  const clipboardBefore = menu.clipboard.changeCount;
  let after = await call('computer_act', { sessionId: session.sessionId, observationId: menu.id, action: { kind: 'click', elementId: copy.id } });
  const firstResult = { menuOpen: Boolean(after.modal), clipboardChanged: after.clipboard.changeCount > clipboardBefore, hasImage: after.clipboard.hasImage };
  // Menu dismissal and clipboard delivery are asynchronous. Observe their completion without repeating the click.
  const settleStarted = Date.now();
  while ((after.modal || !after.clipboard.hasImage || after.clipboard.changeCount <= clipboardBefore) && Date.now() - settleStarted < 1200) {
    await delay(30);
    after = await call('computer_inspect', { sessionId: session.sessionId, ocr: 'off' });
  }
  console.log(JSON.stringify({ firstResult, settleMs: Date.now() - settleStarted,
    finalResult: { menuOpen: Boolean(after.modal), clipboardChanged: after.clipboard.changeCount > clipboardBefore, hasImage: after.clipboard.hasImage } }));
  assert.equal(after.modal, undefined, 'the menu must close');
  assert.ok(after.clipboard.hasImage && after.clipboard.changeCount > clipboardBefore, 'a new image must be on the clipboard');
  assert.equal(await readFile(output, 'utf8'), 'copied');
  console.log(JSON.stringify({ passed: true, ocrBounds: text.bounds, rightClickToMenuMs: rightClickMs, menuItems: menu.elements.filter((e: any) => e.modal).map((e: any) => e.name) }));
  await call('computer_close', { sessionId: session.sessionId });
} finally { await client.close(); app.kill(); await delay(100); await rm(temp, { recursive: true, force: true }); }
