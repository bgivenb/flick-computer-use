import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { MacOSDriver, NativeBridge } from '../src/drivers/macos.js';
import { DesktopDriver } from '../src/drivers/desktop.js';
import { StaleObservationError, type Observation } from '../src/core/types.js';

function lab(request: (method: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>) {
  const bridge = { request, close() {} };
  const driver = Reflect.construct(MacOSDriver, [bridge, 'test.editor', () => {}, 'off']) as MacOSDriver;
  const observation = { id: 'before', sessionId: driver.id, kind: 'macos', targetId: 'test.editor', title: 'Editor', text: '',
    revision: 'r1', capturedAt: 0, truncated: false, elements: [
      { id: 'editor', name: 'Body', role: 'textbox', value: '', disabled: false, actions: ['fill'] },
    ] } as Observation;
  return { driver, observation };
}

test('native actions forward cancellation into the helper and retain the original interruption reason', async () => {
  const controller = new AbortController(), reason = new Error('User took control');
  let calls = 0;
  const { driver, observation } = lab(async (method, params, signal) => {
    calls++;
    assert.equal(method, 'act');
    assert.equal(signal, controller.signal);
    assert.deepEqual(params.action, { kind: 'fill', elementId: 'editor', value: 'a long poem', submit: true });
    controller.abort(reason);
    throw new Error('USER_INPUT_INTERRUPTED');
  });
  assert.equal(driver.userActivityScope, 'desktop');
  await assert.rejects(driver.act({ kind: 'fill', elementId: 'editor', value: 'a long poem', submit: true }, observation, controller.signal), error => error === reason);
  assert.equal(calls, 1);
});

test('an already interrupted action or app switch dispatches nothing', async () => {
  const controller = new AbortController(), reason = new Error('User took control');
  const { driver, observation } = lab(async () => { assert.fail('No native request should be dispatched'); });
  controller.abort(reason);
  await assert.rejects(driver.act({ kind: 'fill', elementId: 'editor', value: 'text' }, observation, controller.signal), error => error === reason);
  await assert.rejects(driver.switchApp('test.other', controller.signal), error => error === reason);
  assert.equal(driver.label, 'test.editor');
});

test('interrupted app activation forwards its signal and does not claim the new app is connected', async () => {
  const controller = new AbortController(), reason = new Error('User took control');
  const { driver } = lab(async (method, params, signal) => {
    assert.equal(method, 'connect');
    assert.equal(params.bundleId, 'test.other');
    assert.equal(signal, controller.signal);
    controller.abort(reason);
    return { connected: true };
  });
  await assert.rejects(driver.switchApp('test.other', controller.signal), error => error === reason);
  assert.equal(driver.label, 'test.editor');
});

test('fresh native observation reconciles an app activated before connect was interrupted', async () => {
  const controller = new AbortController(), reason = new Error('User took control');
  let actions = 0;
  const { driver, observation } = lab(async method => {
    if (method === 'connect') { controller.abort(reason); throw new Error('USER_INPUT_INTERRUPTED'); }
    if (method === 'observe') return { ...observation, targetId: 'test.other', title: 'Other editor' };
    actions++;
    return { ok: true };
  });
  await assert.rejects(driver.switchApp('test.other', controller.signal), error => error === reason);
  const resumed = new AbortController().signal;
  await assert.rejects(driver.act({ kind: 'fill', elementId: 'editor', value: 'text' }, observation, resumed), StaleObservationError);
  assert.equal(actions, 0);
  const fresh = await driver.observe();
  assert.equal(fresh.targetId, 'test.other');
  assert.equal(driver.label, 'test.other');
  await assert.rejects(driver.act({ kind: 'fill', elementId: 'editor', value: 'text' }, observation, resumed), StaleObservationError);
  await driver.act({ kind: 'fill', elementId: 'editor', value: 'text' }, fresh, resumed);
  assert.equal(actions, 1);
});

test('interrupted native connection cannot relabel controls when the helper omits app identity', async () => {
  const controller = new AbortController(), reason = new Error('User took control');
  const { driver } = lab(async method => {
    if (method === 'connect') { controller.abort(reason); throw new Error('USER_INPUT_INTERRUPTED'); }
    return { title: 'Unknown editor', text: 'Sensitive text', elements: [], revision: 'r2' };
  });
  await assert.rejects(driver.switchApp('test.other', controller.signal), error => error === reason);
  await assert.rejects(driver.observe(), /Reconnect the intended app/);
});

test('desktop Continue offers a fresh app choice after native activation was interrupted', async () => {
  const controller = new AbortController(), reason = new Error('User took control');
  let current = 'test.editor', shouldInterrupt = false, observations = 0;
  const { driver: native, observation: screen } = lab(async (method, params) => {
    if (method === 'connect') {
      current = String(params.bundleId);
      if (shouldInterrupt) { controller.abort(reason); throw new Error('USER_INPUT_INTERRUPTED'); }
      return { connected: true };
    }
    observations++;
    return { ...screen, targetId: current, title: current };
  });
  const desktop = new DesktopDriver([
    { kind: 'macos', bundleId: 'test.editor', name: 'Editor' },
    { kind: 'macos', bundleId: 'test.other', name: 'Other editor' },
  ], { native: () => native, browser: async () => { throw new Error('Unexpected browser'); } });
  const resumed = new AbortController().signal;
  await desktop.act({ kind: 'switch', targetId: 'test.editor' }, await desktop.observe(), resumed);
  const original = await desktop.observe();
  shouldInterrupt = true;
  await assert.rejects(desktop.act({ kind: 'switch', targetId: 'test.other' }, original, controller.signal), error => error === reason);
  const before = observations, fresh = await desktop.observe();
  assert.equal(observations, before, 'Disconnected desktop must not label controls from its old driver');
  assert.equal(fresh.targetId, undefined);
  assert.deepEqual(fresh.elements, []);
  await assert.rejects(desktop.act({ kind: 'fill', elementId: 'editor', value: 'text' }, original, resumed), StaleObservationError);
  shouldInterrupt = false;
  await desktop.act({ kind: 'switch', targetId: 'test.other' }, fresh, resumed);
  assert.equal((await desktop.observe()).targetId, 'test.other');
  await desktop.close();
});

// The executable speaks the real JSONL protocol but never reads or changes the desktop.
// This exercises signal delivery and waiting for key-release acknowledgement with an
// actual child process. NativeBridge's macOS platform check is deliberately preserved.
async function fakeHelper() {
  const directory = await mkdtemp(join(tmpdir(), 'flick-interruption-'));
  const path = join(directory, 'fake-helper');
  await writeFile(path, `#!/usr/bin/env node
const readline = require('node:readline');
const send = output => process.stdout.write(JSON.stringify(output) + '\\n');
let active;
process.on('SIGUSR1', () => {
  if (!active) return;
  const id = active.id;
  active = undefined;
  // Simulate the helper completing key-up before reporting interruption.
  setTimeout(() => send({ id, error: 'USER_INPUT_INTERRUPTED' }), 50);
});
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.method === 'health') return send({ id: request.id, result: { healthy: true } });
  if (request.method === 'state') return send({ id: request.id, result: { active: !!active } });
  setTimeout(() => {
    active = request;
    send({ id: request.id, event: 'started' });
  }, request.startDelay || 0);
});
`);
  await chmod(path, 0o755);
  return { path, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test('native bridge waits for interruption acknowledgement and delivers cancellation queued before request start', { skip: process.platform !== 'darwin' }, async () => {
  const fixture = await fakeHelper(), bridge = new NativeBridge(fixture.path);
  try {
    const controller = new AbortController(), reason = new Error('User took control');
    const request = bridge.request('act', { startDelay: 70 }, controller.signal);
    let settled = false;
    const checked = assert.rejects(request, error => error === reason).then(() => { settled = true; });
    controller.abort(reason);
    await delay(30);
    assert.equal(settled, false, 'Desktop ownership must remain until the helper finishes release/cleanup');
    await checked;
    assert.deepEqual(await bridge.request('health'), { healthy: true }, 'Cancellation must leave the helper usable');
  } finally { bridge.close(); await fixture.cleanup(); }
});

test('native bridge rejects a cancelled request before writing to the child', { skip: process.platform !== 'darwin' }, async () => {
  const fixture = await fakeHelper(), bridge = new NativeBridge(fixture.path);
  try {
    const controller = new AbortController(), reason = new Error('User took control');
    controller.abort(reason);
    assert.throws(() => bridge.request('act', {}, controller.signal), error => error === reason);
    assert.deepEqual(await bridge.request('health'), { healthy: true });
  } finally { bridge.close(); await fixture.cleanup(); }
});

test('native bridge interrupts an already running action without waiting for another JSONL request', { skip: process.platform !== 'darwin' }, async () => {
  const fixture = await fakeHelper(), bridge = new NativeBridge(fixture.path);
  try {
    const controller = new AbortController(), reason = new Error('User took control');
    const request = bridge.request('act', {}, controller.signal);
    const checked = assert.rejects(request, error => error === reason);
    const deadline = Date.now() + 2000;
    while (!(await bridge.request('state')).active) {
      assert.ok(Date.now() < deadline, 'Fake action should have begun');
      await delay(5);
    }
    controller.abort(reason);
    await checked;
    assert.deepEqual(await bridge.request('state'), { active: false });
  } finally { bridge.close(); await fixture.cleanup(); }
});
