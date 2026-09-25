import test from 'node:test';
import assert from 'node:assert/strict';
import { CerebrasTextHelper, FallbackTextHelper, GroqTextHelper, OpenAITextHelper } from '../src/providers/text-helper.js';
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
  assert.match(requestBody.messages[0].content, /Jev has no mouth/);
  const state = JSON.parse(requestBody.messages[1].content);
  assert.equal(state.goal, input.goal);
  assert.equal(state.page.url, observation.url);
  assert.equal(state.form.chosenFieldId, field.id);
  assert.equal(state.form.visibleFields[0].name, 'Search');
});

test('a search-field need_input answer is retried with the current search step', async () => {
  let calls = 0;
  const mock: typeof fetch = async (_url, init) => {
    const state = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
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

test('a required field without a supplied value is not invented', async () => {
  const states: any[] = [];
  const mock: typeof fetch = async (_url, init) => {
    states.push(JSON.parse(JSON.parse(String(init?.body)).messages[1].content));
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ status: 'need_input', text: '' }) } }] }),
      { status: 200 });
  };
  const helper = new GroqTextHelper('private-test-key', 'qwen/qwen3.8-27b', mock);
  const field: Observation['elements'][number] = { id: 'employer', role: 'textbox', name: 'Employer name *',
    disabled: false, actions: ['fill'] };
  const observation: Observation = { id: 'o', revision: 'r', sessionId: 's', kind: 'browser', title: 'Income Calculator',
    url: 'https://example.com/income-calculator', text: 'Employer details. Employer name *',
    elements: [field], truncated: false, capturedAt: Date.now() };
  const input = taskSchema.parse({ sessionId: 's', goal: 'Create fictional test borrowers and fill the income calculator.',
    until: [{ kind: 'text', text: 'Saved' }] });
  const result = await helper.compose(input, observation, field, new AbortController().signal);
  assert.deepEqual(result, { status: 'need_input', text: '', modelCalls: 1 });
  assert.match(states[0].instruction, /specific value that is absent/);
  assert.equal(states[0].field.name, 'Employer name *');
  assert.equal(states[0].page.url, observation.url);
  assert.equal(states.length, 1);
});

test('an unlabeled creative editor drafts requested writing after an unnecessary need_input', async () => {
  let calls = 0;
  const mock: typeof fetch = async (_url, init) => {
    calls++;
    const body = JSON.parse(String(init?.body));
    assert.match(body.messages[0].content, /Your only job is to write the text/);
    const state = JSON.parse(body.messages[1].content);
    assert.match(state.instruction, calls === 1 ? /creative text/ : /no separate exact value is needed/);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(calls === 1
      ? { status: 'need_input', text: '' } : { status: 'text', text: 'A quiet page\nReceives the morning light' }) } }] }),
      { status: 200 });
  };
  const helper = new GroqTextHelper('private-test-key', 'qwen/qwen3.8-27b', mock);
  const field: Observation['elements'][number] = { id: 'editor', role: 'textbox', name: '', disabled: false,
    actions: ['fill'], multiline: true };
  const observation: Observation = { id: 'o', revision: 'r', sessionId: 's', kind: 'browser', title: 'Online note editor',
    text: 'Write a note', elements: [field], truncated: false, capturedAt: Date.now() };
  const input = taskSchema.parse({ sessionId: 's', goal: 'Find an online note editor and write a poem there.',
    until: [{ kind: 'text', text: 'A quiet page' }] });
  const result = await helper.compose(input, observation, field, new AbortController().signal);
  assert.equal(result.status, 'text');
  assert.match(result.text, /A quiet page/);
  assert.equal(result.modelCalls, 2);
});

test('Cerebras 503 falls back to Groq and skips the unavailable primary on the next field', async () => {
  let cerebrasCalls = 0, groqCalls = 0;
  const failing: typeof fetch = async () => { cerebrasCalls++; return new Response('', { status: 503 }); };
  const working: typeof fetch = async () => {
    groqCalls++;
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ status: 'text', text: 'evrylo.com' }) } }] }), { status: 200 });
  };
  const helper = new FallbackTextHelper(new CerebrasTextHelper('private-primary-key', 'qwen-3.8-27b', failing),
    new GroqTextHelper('private-backup-key', 'qwen/qwen3.8-27b', working));
  const field: Observation['elements'][number] = { id: 'search', role: 'combobox', name: 'Search', disabled: false, actions: ['fill'] };
  const observation: Observation = { id: 'o', revision: 'r', sessionId: 's', kind: 'browser', title: 'Google', text: 'Search',
    elements: [field], truncated: false, capturedAt: Date.now() };
  const input = taskSchema.parse({ sessionId: 's', goal: 'Search for evrylo.com', until: [{ kind: 'text', text: 'Found' }] });
  const first = await helper.compose(input, observation, field, new AbortController().signal);
  const second = await helper.compose(input, observation, field, new AbortController().signal);
  assert.equal(first.text, 'evrylo.com'); assert.equal(first.modelCalls, 2);
  assert.equal(second.text, 'evrylo.com'); assert.equal(second.modelCalls, 1);
  assert.equal(cerebrasCalls, 1); assert.equal(groqCalls, 2);
});

test('Groq 429 falls through to GPT-6 Luna with no reasoning', async () => {
  const called: string[] = [];
  const failingCerebras: typeof fetch = async url => { called.push(String(url)); return new Response('', { status: 503 }); };
  const limitedGroq: typeof fetch = async url => {
    called.push(String(url));
    return new Response('', { status: 429, headers: { 'Retry-After': '30' } });
  };
  const openai: typeof fetch = async (url, init) => {
    called.push(String(url));
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, 'gpt-6-luna');
    assert.equal(body.reasoning_effort, 'none');
    assert.equal(body.response_format.type, 'json_schema');
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ status: 'text', text: 'Cedar Harbor Studio' }) } }] }),
      { status: 200 });
  };
  const helper = new FallbackTextHelper(
    new CerebrasTextHelper('primary', 'qwen-3.8-27b', failingCerebras),
    new GroqTextHelper('backup', 'qwen/qwen3.8-27b', limitedGroq),
    new OpenAITextHelper('third', 'gpt-6-luna', openai));
  const field: Observation['elements'][number] = { id: 'employer', role: 'textbox', name: 'Employer name *',
    disabled: false, actions: ['fill'] };
  const observation: Observation = { id: 'o', revision: 'r', sessionId: 's', kind: 'browser', title: 'Income Calculator',
    text: 'Employer name *', elements: [field], truncated: false, capturedAt: Date.now() };
  const input = taskSchema.parse({ sessionId: 's', goal: 'Use fictional test data', until: [{ kind: 'text', text: 'Saved' }] });
  const result = await helper.compose(input, observation, field, new AbortController().signal);
  assert.equal(result.text, 'Cedar Harbor Studio');
  assert.equal(result.modelCalls, 3);
  assert.deepEqual(called, ['https://api.cerebras.ai/v1/chat/completions',
    'https://api.groq.com/openai/v1/chat/completions', 'https://api.openai.com/v1/chat/completions']);
  called.length = 0;
  await helper.compose(input, observation, field, new AbortController().signal);
  assert.deepEqual(called, ['https://api.openai.com/v1/chat/completions']);
});

test('short Groq Retry-After gets one bounded retry when other providers fail', async () => {
  let groqCalls = 0;
  const unavailable: typeof fetch = async () => new Response('', { status: 503 });
  const groq: typeof fetch = async () => {
    groqCalls++;
    return groqCalls === 1 ? new Response('', { status: 429, headers: { 'Retry-After': '0' } })
      : new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ status: 'text', text: 'Example' }) } }] }),
        { status: 200 });
  };
  const helper = new FallbackTextHelper(new CerebrasTextHelper('primary', undefined, unavailable),
    new GroqTextHelper('backup', undefined, groq));
  const field: Observation['elements'][number] = { id: 'name', role: 'textbox', name: 'Name', disabled: false, actions: ['fill'] };
  const observation: Observation = { id: 'o', revision: 'r', sessionId: 's', kind: 'browser', title: 'Form', text: 'Name',
    elements: [field], truncated: false, capturedAt: Date.now() };
  const input = taskSchema.parse({ sessionId: 's', goal: 'Enter a fictional name', until: [{ kind: 'text', text: 'Saved' }] });
  const result = await helper.compose(input, observation, field, new AbortController().signal);
  assert.equal(result.text, 'Example');
  assert.equal(result.modelCalls, 3);
  assert.equal(groqCalls, 2);
});

test('Groq token-limit headers move the next field to OpenAI before a 429', async () => {
  let groqCalls = 0, openaiCalls = 0;
  const groq: typeof fetch = async () => {
    groqCalls++;
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ status: 'text', text: 'First' }) } }] }),
      { status: 200, headers: { 'x-ratelimit-remaining-tokens': '100', 'x-ratelimit-reset-tokens': '25s' } });
  };
  const openai: typeof fetch = async () => {
    openaiCalls++;
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ status: 'text', text: 'Second' }) } }] }),
      { status: 200 });
  };
  const helper = new FallbackTextHelper(new GroqTextHelper('primary', undefined, groq),
    new OpenAITextHelper('backup', undefined, openai));
  const field: Observation['elements'][number] = { id: 'name', role: 'textbox', name: 'Name', disabled: false, actions: ['fill'] };
  const observation: Observation = { id: 'o', revision: 'r', sessionId: 's', kind: 'browser', title: 'Form', text: 'Name',
    elements: [field], truncated: false, capturedAt: Date.now() };
  const input = taskSchema.parse({ sessionId: 's', goal: 'Enter a fictional name', until: [{ kind: 'text', text: 'Saved' }] });
  assert.equal((await helper.compose(input, observation, field, new AbortController().signal)).text, 'First');
  assert.equal((await helper.compose(input, observation, field, new AbortController().signal)).text, 'Second');
  assert.equal(groqCalls, 1);
  assert.equal(openaiCalls, 1);
});

test('a fast healthy provider becomes preferred after one timing probe', async () => {
  let slowCalls = 0, fastCalls = 0;
  const slow: typeof fetch = async () => {
    slowCalls++;
    await new Promise(resolve => setTimeout(resolve, 20));
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ status: 'text', text: 'Slow' }) } }] }),
      { status: 200 });
  };
  const fast: typeof fetch = async () => {
    fastCalls++;
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ status: 'text', text: 'Fast' }) } }] }),
      { status: 200 });
  };
  const helper = new FallbackTextHelper(new CerebrasTextHelper('primary', undefined, slow),
    new GroqTextHelper('backup', undefined, fast));
  const field: Observation['elements'][number] = { id: 'name', role: 'textbox', name: 'Name', disabled: false, actions: ['fill'] };
  const observation: Observation = { id: 'o', revision: 'r', sessionId: 's', kind: 'browser', title: 'Form', text: 'Name',
    elements: [field], truncated: false, capturedAt: Date.now() };
  const input = taskSchema.parse({ sessionId: 's', goal: 'Enter a fictional name', until: [{ kind: 'text', text: 'Saved' }] });
  const answers = [];
  for (let i = 0; i < 6; i++) answers.push((await helper.compose(input, observation, field, new AbortController().signal)).text);
  assert.deepEqual(answers, ['Slow', 'Slow', 'Slow', 'Slow', 'Fast', 'Fast']);
  assert.equal(slowCalls, 4);
  assert.equal(fastCalls, 2);
});
