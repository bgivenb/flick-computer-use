import test from 'node:test';
import assert from 'node:assert/strict';
import { CerebrasTextHelper, GroqTextHelper } from '../src/providers/text-helper.js';
import { taskSchema, type Observation } from '../src/core/types.js';

test('Groq helper requests strict Qwen output and validates its typed answer', async () => {
  const requests: any[] = [];
  const mock: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)); requests.push(body);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(requests.length === 1
      ? { status: 'text', text: 'Find evryLO' } : { guidance: 'Wait for the menu to close.' }) } }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const helper = new GroqTextHelper('private-test-key', 'qwen/qwen3.8-27b', mock);
  const input = taskSchema.parse({ sessionId: 's', goal: 'Find evryLO', until: [{ kind: 'text', text: 'Found' }] });
  const field: Observation['elements'][number] = { id: 'q', role: 'textbox', name: 'Search', disabled: false, actions: ['fill'] };
  const observation: Observation = { id: 'o', revision: 'r', sessionId: 's', kind: 'browser', title: 'Search', text: 'Search the site',
    elements: [field], truncated: false, capturedAt: Date.now() };
  assert.deepEqual(await helper.compose(input, observation, field, new AbortController().signal), { status: 'text', text: 'Find evryLO', modelCalls: 1 });
  assert.equal(await helper.repair(input, observation, ['Click failed'], new AbortController().signal), 'Wait for the menu to close.');
  assert.equal(requests.length, 2);
  assert.ok(requests.every(body => body.model === 'qwen/qwen3.8-27b' && body.reasoning_effort === 'none' && body.response_format.json_schema.strict));
  assert.equal(JSON.stringify(requests).includes('private-test-key'), false);
});

test('Cerebras receives the user goal, current page, and chosen form field', async () => {
  let requestBody: any;
  const mock: typeof fetch = async (url, init) => {
    assert.equal(url, 'https://api.cerebras.ai/v1/chat/completions');
    requestBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ status: 'text', text: 'evrylo.com' }) } }] }), { status: 200 });
  };
  const helper = new CerebrasTextHelper('private-test-key', 'qwen-3.8-27b', mock);
  const input = taskSchema.parse({ sessionId: 's', goal: 'Search for evrylo.com and open the site', until: [{ kind: 'text', text: 'Found' }] });
  const field: Observation['elements'][number] = { id: 'search', role: 'combobox', name: 'Search', disabled: false, actions: ['fill'] };
  const observation: Observation = { id: 'o', revision: 'r', sessionId: 's', kind: 'browser', title: 'Google', url: 'https://www.google.com/',
    text: 'Search the web', elements: [field], truncated: false, capturedAt: Date.now() };
  const answer = await helper.compose(input, observation, field, new AbortController().signal);
  assert.equal(answer.text, 'evrylo.com');
  assert.equal(requestBody.model, 'qwen-3.8-27b');
  assert.equal(requestBody.reasoning_effort, 'none');
  const state = JSON.parse(requestBody.messages[0].content);
  assert.equal(state.goal, input.goal);
  assert.equal(state.page.url, observation.url);
  assert.equal(state.form.chosenFieldId, field.id);
  assert.equal(state.form.visibleFields[0].name, 'Search');
});

test('a search-field need_input answer is retried with the current search step', async () => {
  let calls = 0;
  const mock: typeof fetch = async (_url, init) => {
    const state = JSON.parse(JSON.parse(String(init?.body)).messages[0].content);
    calls++;
    if (calls === 2) assert.match(state.instruction, /current Search field/);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(calls === 1
      ? { status: 'need_input', text: '' } : { status: 'text', text: 'evrylo.com' }) } }] }), { status: 200 });
  };
  const helper = new CerebrasTextHelper('private-test-key', 'qwen-3.8-27b', mock);
  const field: Observation['elements'][number] = { id: 'search', role: 'combobox', name: 'Search', disabled: false, actions: ['fill'] };
  const observation: Observation = { id: 'o', revision: 'r', sessionId: 's', kind: 'browser', title: 'Google',
    text: 'Search the web', elements: [field], truncated: false, capturedAt: Date.now() };
  const input = taskSchema.parse({ sessionId: 's', goal: 'Find evrylo.com, then fill out an income calculator', until: [{ kind: 'text', text: 'Found' }] });
  const result = await helper.compose(input, observation, field, new AbortController().signal);
  assert.equal(result.text, 'evrylo.com');
  assert.equal(result.modelCalls, 2);
  assert.equal(calls, 2);
});
