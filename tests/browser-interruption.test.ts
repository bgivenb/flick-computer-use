import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { BrowserDriver } from '../src/drivers/browser.js';
import { DesktopDriver } from '../src/drivers/desktop.js';
import type { Observation } from '../src/core/types.js';

// Exercise the driver's dispatch boundaries without opening the user's browser or
// generating input. Playwright's atomic operations are represented by these fakes.
function browserLab(headless = false, existing = false) {
  const calls: string[] = [];
  const page = {
    on() {}, setDefaultTimeout() {}, isClosed: () => false, url: () => 'https://fixture.invalid/',
    mouse: { move: async () => { calls.push('move'); }, wheel: async () => { calls.push('wheel'); } },
  };
  const context = { on() {}, pages: () => [page] };
  const driver = Reflect.construct(BrowserDriver, [context, page, undefined, 'chromium', existing ? {} : undefined, undefined, headless]) as BrowserDriver;
  const observation: Observation = {
    id: 'observation', revision: 'revision', sessionId: driver.id, kind: 'browser',
    title: 'Fixture', url: page.url(), text: '', truncated: false, capturedAt: Date.now(),
    elements: [{ id: 'field', name: 'Message', role: 'textbox', disabled: false, actions: ['fill'], value: '' }],
  };
  driver.observe = async () => { calls.push('observe'); return observation; };
  const element = {
    fill: async (_value: string, _options?: object) => { calls.push('fill'); },
    press: async (_key: string, _options?: object) => { calls.push('submit'); },
  };
  const handle = { asElement: () => element, dispose: async () => { calls.push('dispose'); } };
  const frame = { evaluateHandle: async () => handle };
  (driver as any).references.set(observation.id, new Map([['field', { frame, localId: 'field', epoch: 'epoch' }]]));
  return { driver, observation, calls, element, frame, page };
}

test('browser activity scope follows actual visibility, including existing Chrome', () => {
  assert.equal(browserLab().driver.userActivityScope, 'desktop');
  assert.equal(browserLab(true).driver.userActivityScope, 'headless');
  assert.equal(browserLab(true, true).driver.userActivityScope, 'desktop');
});

test('interruption while filling prevents the following submit', async () => {
  const { driver, observation, calls, element } = browserLab(true);
  const controller = new AbortController(), reason = new Error('User took control.');
  element.fill = async () => { calls.push('fill'); controller.abort(reason); };
  await assert.rejects(driver.act({ kind: 'fill', elementId: 'field', value: 'Draft', submit: true }, observation, controller.signal), error => error === reason);
  assert.deepEqual(calls, ['observe', 'fill', 'dispose']);
});

test('interruption is preserved when the in-flight browser action also fails', async () => {
  const { driver, observation, calls, element } = browserLab(true);
  const controller = new AbortController(), reason = new Error('User took control.');
  element.fill = async () => { calls.push('fill'); controller.abort(reason); throw new Error('Timeout waiting for field'); };
  await assert.rejects(driver.act({ kind: 'fill', elementId: 'field', value: 'Draft', submit: true }, observation, controller.signal), error => error === reason);
  assert.deepEqual(calls, ['observe', 'fill', 'dispose']);
});

test('interruption during target resolution prevents any input', async () => {
  const { driver, observation, calls, frame } = browserLab(true);
  const controller = new AbortController(), reason = new Error('User took control.');
  const resolveHandle = frame.evaluateHandle;
  frame.evaluateHandle = async () => { controller.abort(reason); return resolveHandle(); };
  await assert.rejects(driver.act({ kind: 'fill', elementId: 'field', value: 'Draft' }, observation, controller.signal), error => error === reason);
  assert.deepEqual(calls, ['observe', 'dispose']);
});

test('interruption between pointer positioning and scrolling prevents the wheel event', async () => {
  const { driver, observation, calls, page } = browserLab(true);
  const controller = new AbortController(), reason = new Error('User took control.');
  page.mouse.move = async () => { calls.push('move'); controller.abort(reason); };
  await assert.rejects(driver.act({ kind: 'scroll', direction: 'down' }, observation, controller.signal), error => error === reason);
  assert.deepEqual(calls, ['observe', 'move']);
});

test('an already interrupted browser action does not inspect or dispatch input', async () => {
  const { driver, observation, calls } = browserLab(true);
  const reason = new Error('User took control.');
  await assert.rejects(driver.act({ kind: 'fill', elementId: 'field', value: 'Draft' }, observation, AbortSignal.abort(reason)), error => error === reason);
  assert.deepEqual(calls, []);
});

function openingLab() {
  const calls: string[] = [];
  const page = {
    on() {}, setDefaultTimeout() {},
    goto: async () => { calls.push('navigate'); },
    close: async () => { calls.push('close tab'); },
  };
  const context = {
    on() {}, pages: () => [page],
    newPage: async () => { calls.push('new tab'); return page; },
    close: async () => { calls.push('close context'); },
  };
  const browser = {
    contexts: () => [context], isConnected: () => true,
    close: async () => { calls.push('close browser'); },
  };
  return { calls, page, context, browser };
}

test('interruption during browser launch waits for settlement and closes only its dedicated context', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'flick-opening-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { context, calls } = openingLab();
  const started = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
  t.mock.method(chromium, 'launchPersistentContext', async () => {
    calls.push('launch'); started.resolve(); await finish.promise; return context as any;
  });
  const controller = new AbortController(), reason = new Error('User took control.');
  const opening = BrowserDriver.open({ url: 'https://fixture.invalid/', headless: true, signal: controller.signal }, directory);
  let settled = false;
  void opening.then(() => { settled = true; }, () => { settled = true; });
  await started.promise;
  controller.abort(reason);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, 'Ownership must remain held while the dispatched launch is pending.');
  finish.resolve();
  await assert.rejects(opening, error => error === reason);
  assert.deepEqual(calls, ['launch', 'close context']);
});

test('interruption during dedicated new-tab creation prevents navigation', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'flick-opening-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { context, page, calls } = openingLab();
  const controller = new AbortController(), reason = new Error('User took control.');
  context.pages = () => [];
  context.newPage = async () => { calls.push('new tab'); controller.abort(reason); return page; };
  t.mock.method(chromium, 'launchPersistentContext', async () => context as any);
  await assert.rejects(BrowserDriver.open({ url: 'https://fixture.invalid/', headless: true, signal: controller.signal }, directory), error => error === reason);
  assert.deepEqual(calls, ['new tab', 'close context']);
});

test('interruption after dedicated navigation cleans up instead of returning a usable session', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'flick-opening-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { context, page, calls } = openingLab();
  const controller = new AbortController(), reason = new Error('User took control.');
  page.goto = async () => { calls.push('navigate'); controller.abort(reason); };
  t.mock.method(chromium, 'launchPersistentContext', async () => context as any);
  await assert.rejects(BrowserDriver.open({ url: 'https://fixture.invalid/', headless: true, signal: controller.signal }, directory), error => error === reason);
  assert.deepEqual(calls, ['navigate', 'close context']);
});

test('interruption during an existing Chrome approval wait does not start another connection', async t => {
  const driverClass = BrowserDriver as any;
  const oldPending = driverClass.openingChrome, oldExisting = driverClass.existingChrome;
  t.after(() => { driverClass.openingChrome = oldPending; driverClass.existingChrome = oldExisting; });
  const { browser, calls } = openingLab(), connection = Promise.withResolvers<{ endpoint: string; browser: unknown }>();
  const endpoint = 'ws://127.0.0.1:9999/devtools/browser/test';
  driverClass.openingChrome = connection.promise; driverClass.existingChrome = undefined;
  t.mock.method(chromium, 'connectOverCDP', async () => { throw new Error('A second approval must not be requested.'); });
  const controller = new AbortController(), reason = new Error('User took control.');
  const opening = driverClass.approvedChrome(endpoint, controller.signal);
  let settled = false;
  void opening.then(() => { settled = true; }, () => { settled = true; });
  controller.abort(reason);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  connection.resolve({ endpoint, browser });
  await assert.rejects(opening, error => error === reason);
  assert.deepEqual(calls, [], 'The shared personal Chrome connection stays open.');
});

test('interruption during personal Chrome tab creation closes only that task tab', async () => {
  const { browser, context, page, calls } = openingLab();
  const controller = new AbortController(), reason = new Error('User took control.');
  context.newPage = async () => { calls.push('new tab'); controller.abort(reason); return page; };
  await assert.rejects((BrowserDriver as any).openExistingTab(browser, { url: 'https://fixture.invalid/', signal: controller.signal }, undefined), error => error === reason);
  assert.deepEqual(calls, ['new tab', 'close tab']);
});

test('interruption after personal Chrome navigation closes the task tab and preserves the shared connection', async () => {
  const { browser, page, calls } = openingLab();
  const controller = new AbortController(), reason = new Error('User took control.');
  page.goto = async () => { calls.push('navigate'); controller.abort(reason); };
  await assert.rejects((BrowserDriver as any).openExistingTab(browser, { url: 'https://fixture.invalid/', signal: controller.signal }, undefined), error => error === reason);
  assert.deepEqual(calls, ['new tab', 'navigate', 'close tab']);
});

test('desktop browser opening receives the interruption signal and never focuses after abort', async () => {
  const controller = new AbortController(), reason = new Error('User took control.');
  let opened = false;
  const driver = new DesktopDriver([{ kind: 'browser', name: 'Fixture', url: 'https://fixture.invalid/', headless: true,
    connection: 'dedicated', browser: 'chromium', allowedOrigins: [] }], {
    native: () => { throw new Error('Native UI must not open.'); },
    browser: async options => {
      opened = true; assert.equal(options.signal, controller.signal);
      controller.abort(reason); options.signal!.throwIfAborted(); throw new Error('Unreachable');
    },
  });
  try {
    await assert.rejects(driver.act({ kind: 'switch', targetId: 'browser:0' }, await driver.observe(), controller.signal), error => error === reason);
    assert.equal(opened, true);
    assert.equal((await driver.observe()).targetId, undefined);
  } finally { await driver.close(); }
});
