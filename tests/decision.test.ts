import test from 'node:test';
import assert from 'node:assert/strict';
import { candidatesFor, taskSchema, type Observation } from '../src/core/types.js';
import { decisionContract, TypeSafeDecider } from '../src/providers/typesafe.js';

const answer = (choice: string, confidence = .99) => ({ type: 'choice', choice, confidence, probabilities: { [choice]: .99 } });
const observed = (count = 1): Observation => ({ id: 'o', sessionId: 's', kind: 'browser', title: 'Form', text: '', revision: '1', capturedAt: 0, truncated: false,
  elements: Array.from({ length: count }, (_, i) => ({ id: `e${i}`, name: `Field ${i}`, role: 'textbox', disabled: false, actions: ['fill'], value: '' })) });

test('factored decisions resolve a field/value pair beyond the flat 255-choice limit', () => {
  const o = observed(40);
  const inputs = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`input${i}`, `value${i}`]));
  const candidates = candidatesFor(o, inputs, { factored: true });
  assert.ok(Object.keys(candidates).length > 800);
  const contract = decisionContract(candidates, o);
  assert.equal(Object.keys(contract.questions.fill_target.criteria).length, 40);
  assert.equal(Object.keys(contract.questions.fill_value.criteria).length, 20);
  const result = contract.resolve({ operation: answer('fill'), fill_target: answer('e39', .8), fill_value: answer('v19', .9), press_target: 'unused malformed answer' });
  assert.deepEqual(candidates[result.choice].action, { kind: 'fill', elementId: 'e39', value: 'value19' });
  assert.equal(result.confidence, .8);
});
test('copy text is chosen as an operation followed by an observed text target', () => {
  const o: Observation = { ...observed(0), text: 'The reference number is 1234.', elements: [
    { id: 'read:line:1234', role: 'text', name: 'The reference number is 1234.', value: 'The reference number is 1234.', disabled: false, actions: [] },
  ] };
  const candidates = candidatesFor(o, {}, { factored: true, canCopyText: true });
  const contract = decisionContract(candidates, o);
  assert.ok(contract.questions.operation.criteria.copy_text);
  assert.match(contract.questions.copy_text_target.criteria['read:line:1234'], /reference number/);
  const selected = contract.resolve({ operation: answer('copy_text'), copy_text_target: answer('read:line:1234') });
  assert.deepEqual(candidates[selected.choice].action, { kind: 'copy_text', elementId: 'read:line:1234' });
});
test('tab switching chooses an observed browser tab', () => {
  const o: Observation = { ...observed(0), activeTabId: 'first', tabs: [
    { id: 'first', title: 'First', url: 'https://example.test/first' },
    { id: 'second', title: 'Second', url: 'https://example.test/second' },
  ] };
  const candidates = candidatesFor(o, {}, { factored: true });
  const contract = decisionContract(candidates, o);
  assert.ok(contract.questions.operation.criteria.switch_tab);
  assert.match(Object.values(contract.questions.switch_tab_target.criteria).join(' '), /Second/);
  const selected = contract.resolve({ operation: answer('switch_tab'), switch_tab_target: answer('switch_tab:second') });
  assert.deepEqual(candidates[selected.choice].action, { kind: 'switch_tab', tabId: 'second' });
});
test('options are keyed by the element IDs in the request and described in words', () => {
  const o: Observation = { ...observed(0), elements: [
    { id: 'e8', role: 'textbox', name: 'Search', disabled: false, actions: ['click', 'fill'], focused: true },
    { id: 'e12', role: 'button', name: 'Search', context: 'Google search form', disabled: false, actions: ['click'] },
    { id: 'e60', role: 'AXImage', name: 'Elvis Presley - Wikipedia', disabled: false, actions: ['click'], clickVariants: ['right'] }] };
  const contract = decisionContract(candidatesFor(o, { query: 'Elvis Presley' }), o);
  const sent = new Set(o.elements.map(e => e.id));
  for (const name of ['click_target', 'right_click_target', 'fill_target']) for (const key of Object.keys(contract.questions[name].criteria)) assert.ok(sent.has(key), `${name}: ${key}`);
  assert.equal(contract.questions.click_target.criteria.e12, 'button "Search" in "Google search form"');
  assert.equal(contract.questions.right_click_target.criteria.e60, 'image "Elvis Presley - Wikipedia"');
  assert.ok(contract.questions.operation.criteria.fill_submit);
  const resolved = contract.resolve({ operation: answer('fill_submit'), fill_submit_target: answer('e8'), fill_value_0: answer('v0') });
  assert.deepEqual(contract.questions.fill_value_0.criteria.none, 'None of these values belongs in this field.');
  assert.equal(resolved.choice, 'submit:e8:0'); assert.equal(resolved.used.length, 3);
});
test('each field states its own premise for the value it receives, and "none" cannot write', () => {
  const o = observed(2), candidates = candidatesFor(o, { first: 'Ann', last: 'Lee' }, { factored: true });
  const contract = decisionContract(candidates, o);
  assert.match(contract.questions.fill_value_1.instructions, /"Field 1"/);
  const resolved = contract.resolve({ operation: answer('fill'), fill_target: answer('e1'), fill_value_0: answer('v0'), fill_value_1: answer('v1') });
  assert.deepEqual(candidates[resolved.choice].action, { kind: 'fill', elementId: 'e1', value: 'Lee' });
  assert.throws(() => contract.resolve({ operation: answer('fill'), fill_target: answer('e0'), fill_value_0: answer('none') }), /No supplied/);
});
test('service failures keep their evidence, and successful requests record size and token usage', async () => {
  const o = observed(), candidates = candidatesFor(o, {}), input = taskSchema.parse({ sessionId: 's', goal: 'Save', until: [{ kind: 'text', text: 'Saved' }] });
  const decide = (request: typeof fetch) => new TypeSafeDecider('k', 'jev-latest', request).decide(input, o, candidates, [], new AbortController().signal);
  await assert.rejects(decide(async () => new Response(JSON.stringify({ error: { type: 'invalid_request', message: 'state exceeds 32k tokens' } }), { status: 400 })),
    /HTTP 400: invalid_request: state exceeds 32k tokens; request \d+ characters/);
  let calls = 0;
  await assert.rejects(decide(async () => { calls++; throw new TypeError('fetch failed', { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) }); }),
    /after 5 attempt\(s\) \(UND_ERR_SOCKET: other side closed\)/);
  assert.equal(calls, 5);
  const ok = await decide(async () => new Response(JSON.stringify({ model: 'jev-1.13.0', usage: { input_tokens: 812 }, answers: { operation: answer('done') } })));
  assert.equal(ok.choice, 'done'); assert.equal(ok.trace?.inputTokens, 812); assert.equal(ok.trace?.model, 'jev-1.13.0');
  assert.ok(ok.trace!.requestChars > 100); assert.equal(ok.trace?.used[0].question, 'operation');
});
test('a TLS transport failure gets slower retries and a fresh-connection fallback', async () => {
  const o = observed();
  const input = taskSchema.parse({ sessionId: 's', goal: 'Finish', until: [{ kind: 'text', text: 'Finished' }] });
  let pooledCalls = 0, freshCalls = 0;
  const broken = Object.assign(new Error('ssl/tls alert bad record mac'), { code: 'ERR_SSL_SSL/TLS_ALERT_BAD_RECORD_MAC' });
  const decider = new TypeSafeDecider('k', 'jev-latest', async () => {
    pooledCalls++;
    throw new TypeError('fetch failed', { cause: broken });
  }, async () => {
    freshCalls++;
    return new Response(JSON.stringify({ answers: { operation: answer('done') } }));
  });
  const result = await decider.decide(input, o, candidatesFor(o, {}), [], new AbortController().signal);
  assert.equal(result.choice, 'done');
  assert.equal(pooledCalls, 4);
  assert.equal(freshCalls, 1);
  assert.equal(result.modelCalls, 5);
});
test('selected answers must reference offered choices; unrelated answers do not affect a decision', () => {
  const o = observed(), candidates = candidatesFor(o, { text: 'Hello' });
  const contract = decisionContract(candidates, o);
  assert.equal(contract.resolve({ operation: answer('done'), fill_target: answer('invented', 0) }).choice, 'done');
  assert.throws(() => contract.resolve({ operation: answer('fill'), fill_target: answer('invented'), fill_value: answer('v0') }), /unavailable/);
  assert.throws(() => contract.resolve({ operation: answer('execute_script') }), /unavailable/);
});

test('an unavailable field/value choice is reconsidered without an action and every request is counted', async () => {
  const o = observed(); o.elements[0].value = 'Ann';
  o.elements.push({ id: 'save', role: 'button', name: 'Save', disabled: false, actions: ['click'] });
  const inputs = { first: 'Ann', last: 'Lee' };
  const candidates = candidatesFor(o, inputs, { factored: true });
  const input = taskSchema.parse({ sessionId: 's', goal: 'Set Field 0 to Ann and save', inputs, until: [{ kind: 'text', text: 'Saved' }] });
  let calls = 0;
  const decider = new TypeSafeDecider('k', 'jev-latest', async (_url, init) => {
    const body = JSON.parse(String(init?.body)); calls++;
    if (calls === 1) {
      const key = Object.keys(body.questions.fill_value_0.criteria).find(k => body.questions.fill_value_0.criteria[k].includes('"Ann"'))!;
      return new Response(JSON.stringify({ answers: { operation: answer('fill'), fill_target: answer('e0'), fill_value_0: answer(key) } }));
    }
    assert.equal(body.questions.fill_target, undefined);
    assert.ok(body.questions.fill_submit_target.criteria.e0);
    return new Response(JSON.stringify({ answers: { operation: answer('click'), click_target: answer('save') } }));
  });
  const result = await decider.decide(input, o, candidates, [], new AbortController().signal);
  assert.equal(result.choice, 'click:save'); assert.equal(calls, 2); assert.equal(result.modelCalls, 2);
  assert.deepEqual(result.trace?.recoveries, [{ operation: 'fill', elementId: 'e0' }]);
});
test('Jev choosing no matching value reconsiders another action instead of stopping the task', async () => {
  const o = observed();
  o.elements.push({ id: 'next', role: 'button', name: 'Continue', disabled: false, actions: ['click'] });
  const inputs = { text: 'search terms' };
  const candidates = candidatesFor(o, inputs, { factored: true });
  const input = taskSchema.parse({ sessionId: 's', goal: 'Continue', inputs, until: [{ kind: 'text', text: 'Done' }] });
  let calls = 0;
  const decider = new TypeSafeDecider('k', 'jev-latest', async (_url, init) => {
    const body = JSON.parse(String(init?.body)); calls++;
    if (calls === 1) return new Response(JSON.stringify({ answers: {
      operation: answer('fill'), fill_target: answer('e0'), fill_value_0: answer('none'),
    } }));
    assert.equal(body.questions.fill_target, undefined);
    assert.equal(body.questions.fill_submit_target.criteria.e0, 'textbox "Field 0"');
    return new Response(JSON.stringify({ answers: { operation: answer('click'), click_target: answer('next') } }));
  });
  const result = await decider.decide(input, o, candidates, [], new AbortController().signal);
  assert.equal(result.choice, 'click:next');
  assert.equal(result.modelCalls, 2);
  assert.deepEqual(result.trace?.recoveries, [{ operation: 'fill', elementId: 'e0' }]);
});
