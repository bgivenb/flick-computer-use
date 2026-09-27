import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { MacOSDriver } from '../src/drivers/macos.js';
import { RecoverableActionError, StaleObservationError, type Observation } from '../src/core/types.js';

const screen = (value = '') => ({ title: 'Test editor', text: value, revision: 'r1', truncated: false,
  focusedId: 'editor', elements: [{ id: 'editor', name: 'Body', role: 'textbox', value, disabled: false, actions: ['fill'] }] });
function lab(request: (method: string, params: Record<string, unknown>) => Promise<unknown>) {
  // Supply only an in-memory bridge; never launch the Swift helper, acquire the real desktop, or write UI.
  const bridge = { request, close() {} };
  const driver = Reflect.construct(MacOSDriver, [bridge, 'test.editor', () => {}, 'off']) as MacOSDriver;
  const observation = { ...screen(), id: 'before', sessionId: driver.id, kind: 'macos', capturedAt: 0 } as Observation;
  return { driver, observation };
}
const signal = () => new AbortController().signal;

test('native focus errors become recovery guidance without retrying the input or losing its focus identity', async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const { driver, observation } = lab(async (method, params) => {
    calls.push({ method, params });
    throw new Error('Focus moved to another application. Inspect and refocus before acting.');
  });
  await assert.rejects(driver.act({ kind: 'press', key: 'Enter' }, observation, signal()), error => {
    assert.ok(error instanceof RecoverableActionError);
    assert.match(error.guidance, /switch back to the intended app/);
    return true;
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'act');
  assert.equal(calls[0].params.revision, 'r1');
  assert.equal(calls[0].params.focusedId, 'editor');
});

test('stale native targets remain stale; permission and helper failures remain fatal', async () => {
  for (const failure of [new StaleObservationError(),
    new Error('Accessibility permission is required for the native helper.'),
    new Error('Native helper timed out.')]) {
    const { driver, observation } = lab(async () => { throw failure; });
    await assert.rejects(driver.act({ kind: 'fill', elementId: 'editor', value: 'text' }, observation, signal()),
      error => error === failure);
  }
  const { driver, observation } = lab(async () => { throw new Error('The text under the click point no longer matches what was read; refusing to click.'); });
  await assert.rejects(driver.act({ kind: 'press', key: 'Enter' }, observation, signal()), StaleObservationError);
});

test('disabled and unsupported native controls have alternate-route guidance and send no input', async () => {
  let requests = 0;
  const { driver, observation } = lab(async () => { requests++; return {}; });
  observation.elements[0].disabled = true;
  await assert.rejects(driver.act({ kind: 'fill', elementId: 'editor', value: 'text' }, observation, signal()), error => {
    assert.ok(error instanceof RecoverableActionError);
    assert.match(error.guidance, /Wait for the interface/);
    return true;
  });
  observation.elements[0].disabled = false;
  await assert.rejects(driver.act({ kind: 'click', elementId: 'editor' }, observation, signal()), error => {
    assert.ok(error instanceof RecoverableActionError);
    assert.match(error.guidance, /keyboard route/);
    return true;
  });
  await assert.rejects(driver.act({ kind: 'click', elementId: 'missing' }, observation, signal()), StaleObservationError);
  assert.equal(requests, 0);
});

test('native fill recovery distinguishes rejected text from text already entered before a failed submit', async () => {
  for (const [message, guidance] of [
    ['Multi-line text could not be set directly and is not typed, because a newline could submit. Paste it instead.', /clipboard paste/],
    ['The value was entered, but the field could not take focus to submit it.', /Do not type the value again/],
  ] as const) {
    let requests = 0;
    const { driver, observation } = lab(async () => { requests++; throw new Error(message); });
    await assert.rejects(driver.act({ kind: 'fill', elementId: 'editor', value: 'A frog\nOn a log', submit: true }, observation, signal()), error => {
      assert.ok(error instanceof RecoverableActionError);
      assert.match(error.guidance, guidance);
      return true;
    });
    assert.equal(requests, 1);
  }
});

test('native wait_for_change ignores snapshot revision churn and returns observed content changes', async () => {
  const methods: string[] = [];
  const { driver, observation } = lab(async method => {
    methods.push(method);
    return methods.length === 1 ? { ...screen(), revision: 'incidental revision' } : screen('Editor ready');
  });
  const result = await driver.act({ kind: 'wait_for_change' }, observation, signal());
  assert.equal(result?.text, 'Editor ready');
  assert.deepEqual(methods, ['observe', 'observe']);
});

test('cancelling a native wait interrupts polling and preserves the cancellation reason', async () => {
  const controller = new AbortController(), reason = new Error('Stop this task');
  let requests = 0;
  const { driver, observation } = lab(async () => { requests++; return screen(); });
  const waiting = driver.act({ kind: 'wait_for_change' }, observation, controller.signal);
  await delay(10);
  controller.abort(reason);
  await assert.rejects(waiting, error => error === reason);
  assert.equal(requests, 1);
});

test('cancellation during a native observation does not return a late OCR result', async () => {
  const controller = new AbortController(), reason = new Error('Stop this task');
  const { driver, observation } = lab(async () => { controller.abort(reason); return screen('Late result'); });
  await assert.rejects(driver.act({ kind: 'scan_screen' }, observation, controller.signal), error => error === reason);
});

test('native waits do not claim to observe browser page or image resource loading', async () => {
  let requests = 0;
  const { driver, observation } = lab(async () => { requests++; return screen(); });
  for (const kind of ['wait_for_load', 'wait_for_images'] as const) {
    await assert.rejects(driver.act({ kind }, observation, signal()), error => {
      assert.ok(error instanceof RecoverableActionError);
      assert.match(error.guidance, /wait_for_change/);
      return true;
    });
  }
  assert.equal(requests, 0);
});

test('a native app that is still launching can recover without claiming the switch succeeded', async () => {
  const { driver } = lab(async () => { throw new Error('Target application did not finish launching.'); });
  await assert.rejects(driver.switchApp('test.other'), error => {
    assert.ok(error instanceof RecoverableActionError);
    assert.match(error.guidance, /Wait for the interface/);
    return true;
  });
  assert.equal(driver.label, 'test.editor');
});
