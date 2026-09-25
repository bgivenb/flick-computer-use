import test from 'node:test';
import assert from 'node:assert/strict';
import { GroqTextHelper } from '../src/providers/groq.js';
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
  assert.deepEqual(await helper.compose(input, observation, field, new AbortController().signal), { status: 'text', text: 'Find evryLO' });
  assert.equal(await helper.repair(input, observation, ['Click failed'], new AbortController().signal), 'Wait for the menu to close.');
  assert.equal(requests.length, 2);
  assert.ok(requests.every(body => body.model === 'qwen/qwen3.8-27b' && body.reasoning_effort === 'none' && body.response_format.json_schema.strict));
  assert.equal(JSON.stringify(requests).includes('private-test-key'), false);
});
