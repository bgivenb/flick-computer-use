import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, copyFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { root, loadConfig } from '../src/config.js';
import { fixture } from '../tests/fixture.js';
import { mcpClient } from '../tests/mcp-client.js';

const temp = await mkdtemp(join(tmpdir(), 'jev-goal-'));
const config = loadConfig();
const web = await fixture();
const processes: ChildProcess[] = [];
const reports: unknown[] = [];
const sourceId = 'local.jev-mcp.SourceNotes', destinationId = 'local.jev-mcp.DispatchDesk';
const binary = join(temp, 'TransferLab');
assert.equal(spawnSync('swiftc', [join(root, 'tests/TransferFixture.swift'), '-o', binary, '-framework', 'AppKit'], { stdio: 'inherit' }).status, 0);
for (const [name, id] of [['SourceNotes', sourceId], ['DispatchDesk', destinationId]]) {
  const bundle = join(temp, `${name}.app`);
  await mkdir(join(bundle, 'Contents/MacOS'), { recursive: true });
  await copyFile(binary, join(bundle, 'Contents/MacOS/TransferLab'));
  await writeFile(join(bundle, 'Contents/Info.plist'), `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${id}</string><key>CFBundleExecutable</key><string>TransferLab</string><key>CFBundleName</key><string>${name}</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`);
}
const { client, call } = await mcpClient(join(temp, 'data'));
try {
  for (let trial = 0; trial < 3; trial++) {
    const hybrid = trial === 2;
    const reference = hybrid ? `trial-${randomUUID().slice(0, 8)}@example.test` : randomUUID();
    const output = join(temp, `saved-${trial}.txt`);
    const source = spawn(join(temp, 'SourceNotes.app/Contents/MacOS/TransferLab'), ['source', reference, output], { stdio: 'ignore' });
    processes.push(source);
    const destination = hybrid ? undefined : spawn(join(temp, 'DispatchDesk.app/Contents/MacOS/TransferLab'), ['destination', '', output], { stdio: 'ignore' });
    if (destination) processes.push(destination);
    for (let i = 0; i < 40; i++) {
      const apps = (await call('computer_apps')).apps;
      if (apps.some((a: any) => a.bundleId === sourceId) && (hybrid || apps.some((a: any) => a.bundleId === destinationId))) break;
      await delay(100);
    }
    await delay(150);
    const targets: Record<string, unknown>[] = [{ kind: 'macos', bundleId: sourceId, name: 'Source Notes' }, hybrid
      ? { kind: 'browser', name: 'Export Workspace', url: web.url, browser: 'chrome', headless: false }
      : { kind: 'macos', bundleId: destinationId, name: 'Dispatch Desk' }];
    if (trial === 1) targets.reverse(); // The available-app list must not prescribe the sequence.
    const task = await call('computer_execute', {
      goal: hybrid ? 'Use the Task reference from Source Notes as the Contact email in Export Workspace. Save CSV export settings with column headers included.'
        : 'Copy the Task reference from Source Notes into the Task reference in Dispatch Desk and save the transfer.',
      targets, ocr: 'off', until: hybrid ? [
        { kind: 'text', text: 'Export settings saved' },
        { kind: 'field_from_memory', name: 'Contact email', source: 'Source Notes / Task reference' },
        { kind: 'field', name: 'Export format', value: 'csv' }, { kind: 'checked', name: 'Include column headers', checked: true },
      ] : [{ kind: 'text', text: 'Transfer saved' }, { kind: 'target', targetId: destinationId },
        { kind: 'field_from_memory', name: 'Task reference', source: 'Source Notes / Task reference' }],
      maxSteps: 20, timeoutMs: 60000,
    });
    let result;
    do { result = await call('computer_status', { taskId: task.id, waitMs: 10000, includeObservation: true }); } while (result.status === 'running');
    const report = { trial: trial + 1, kind: hybrid ? 'native-to-browser' : 'native-to-native', status: result.status, reason: result.reason,
      steps: result.steps, metrics: result.metrics, events: result.events, ocrUsed: result.lastObservation?.ocr?.used ?? false };
    console.log(JSON.stringify(report, null, 2));
    await writeFile(join(config.localDir, 'last-goal-debug.json'), JSON.stringify(result, null, 2), { mode: 0o600 });
    assert.equal(result.status, 'succeeded', result.reason);
    if (hybrid) assert.deepEqual(web.state(), { email: reference, format: 'csv', headers: true });
    else assert.equal(await readFile(output, 'utf8'), reference);
    reports.push({ ...report, independentlyVerified: true, hostInterventions: 0 });
    await call('computer_close', { sessionId: task.sessionId });
    source.kill(); destination?.kill(); await delay(200);
  }
  await writeFile(join(config.localDir, 'last-goal-smoke.json'), JSON.stringify({ testedAt: new Date().toISOString(), reports }, null, 2), { mode: 0o600 });
} finally { await client.close(); for (const process of processes) process.kill(); await web.close(); await delay(150); await rm(temp, { recursive: true, force: true }); }
