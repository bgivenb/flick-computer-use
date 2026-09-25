import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { loadConfig, root } from '../src/config.js';
import { mcpClient } from '../tests/mcp-client.js';

const config = loadConfig();
const page = await readFile(resolve(root, 'playground/index.html'), 'utf8');
const port = Number(process.env.FLICK_PLAYGROUND_PORT || 3947);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('FLICK_PLAYGROUND_PORT must be a valid port.');

type Input = Record<string, string>;
type Task = { id: string; sessionId: string; status: string };
let mcp: Awaited<ReturnType<typeof mcpClient>> | undefined;
let task: Task | undefined;
let closing = false;

function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
  res.end(JSON.stringify(value));
}
async function body(req: IncomingMessage): Promise<any> {
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 100_000) throw new Error('Request is too large.');
  }
  try { return JSON.parse(data || '{}'); } catch { throw new Error('Send valid JSON.'); }
}
function inputs(value: unknown): Input {
  if (value == null || value === '') return {};
  const parsed = typeof value === 'string' ? (() => {
    const trimmed = value.trim();
    if (!trimmed) return {};
    if (!trimmed.startsWith('{')) return { text: value };
    try { return JSON.parse(trimmed); } catch { throw new Error('Exact values must be plain text or a JSON object.'); }
  })() : value;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.values(parsed).some(v => typeof v !== 'string'))
    throw new Error('Exact values must be a JSON object of names to text.');
  return parsed as Input;
}
function minimumConfidence(value: unknown) {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) throw new Error('Minimum confidence must be between 0 and 1.');
  return parsed;
}
async function client() { return mcp ??= await mcpClient(resolve(config.localDir, 'playground')); }

async function jevRequest(data: any) {
  if (!config.apiKey) throw new Error('Add TYPESAFE_API_KEY to .env.local first.');
  let state: unknown, questions: Record<string, unknown>;
  if (typeof data.raw === 'string' && data.raw.trim()) {
    let parsed: any;
    try { parsed = JSON.parse(data.raw); } catch { throw new Error('Raw request must be valid JSON.'); }
    state = parsed?.state;
    questions = parsed?.questions;
  } else {
    state = data.state;
    const instruction = String(data.question ?? '').trim();
    if (!instruction) throw new Error('Enter a question for Jev.');
    const lines = String(data.options ?? '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    if (lines.length === 1 || lines.length > 255) throw new Error('Use no options for a yes/no question, or 2–255 options for a choice.');
    const criteria: Record<string, string | null> = {};
    for (const line of lines) {
      const [name, ...description] = line.split('|');
      const key = name.trim();
      if (!key || key.length > 100 || Object.hasOwn(criteria, key)) throw new Error('Each option needs a unique name of at most 100 characters.');
      criteria[key] = description.join('|').trim() || null;
    }
    questions = { answer: lines.length ? { type: 'choice', instructions: instruction, criteria } : { type: 'noul', instructions: instruction } };
  }
  if (!(typeof state === 'string' || Array.isArray(state) || (state && typeof state === 'object')) || !questions || typeof questions !== 'object' || Array.isArray(questions) || !Object.keys(questions).length)
    throw new Error('Supply state and at least one typed question.');
  const sent = { model: config.model, state, questions };
  if (JSON.stringify(sent).length > 80_000) throw new Error('Request is too large.');
  const started = performance.now();
  const response = await fetch('https://api.typesafe.ai/v1/systemone', { method: 'POST',
    headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(sent), signal: AbortSignal.timeout(30_000) });
  const text = await response.text();
  if (!response.ok) throw new Error(`TypeSafe returned HTTP ${response.status}: ${text.slice(0, 500)}`);
  let output: unknown;
  try { output = JSON.parse(text); } catch { throw new Error('TypeSafe returned invalid JSON.'); }
  return { sent, output, elapsedMs: Math.round(performance.now() - started) };
}

async function route(req: IncomingMessage, res: ServerResponse) {
  try {
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
      res.end(page); return;
    }
    if (req.method === 'GET' && req.url === '/api/health') { json(res, 200, { model: config.model, keyConfigured: Boolean(config.apiKey),
      groqConfigured: Boolean(config.groqApiKey), groqModel: config.groqApiKey ? config.groqModel : undefined }); return; }
    if (req.method === 'GET' && req.url === '/api/task') {
      const result = task ? await (await client()).call('computer_status', { taskId: task.id, waitMs: 0 }) : null;
      if (result) task!.status = result.status;
      json(res, 200, result); return;
    }
    if (req.method !== 'POST' || !req.url?.startsWith('/api/')) { json(res, 404, { error: 'Not found.' }); return; }
    const origin = req.headers.origin;
    if (origin && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) { json(res, 403, { error: 'Use this local page to send requests.' }); return; }
    const data = await body(req);
    if (req.url === '/api/jev') { json(res, 200, await jevRequest(data)); return; }
    if (req.url === '/api/task/start') {
      if (task?.status === 'running') throw new Error('A computer task is already running.');
      const goal = String(data.goal ?? '').trim(), doneText = String(data.doneText ?? '').trim();
      if (!goal || !doneText) throw new Error('Enter a goal and exact text to look for when done.');
      if (task) await (await client()).call('computer_close', { sessionId: task.sessionId });
      const target = data.target === 'browser'
        ? { kind: 'browser', name: 'Existing Chrome', connection: 'existing-chrome', url: String(data.url ?? '').trim() }
        : { kind: 'macos', name: 'Mac app', bundleId: String(data.bundleId || 'com.google.Chrome').trim() };
      if (target.kind === 'browser' && !/^https?:\/\//.test(target.url)) throw new Error('Fast browser mode needs a starting http(s) URL.');
      const until = /^https?:\/\//i.test(doneText)
        ? [{ kind: 'url' as const, contains: doneText }]
        : [{ kind: 'text' as const, text: doneText }];
      const started = await (await client()).call('computer_execute', { goal, inputs: inputs(data.values),
        targets: [target], until, maxSteps: 60, timeoutMs: 180_000,
        minConfidence: minimumConfidence(data.minConfidence) });
      task = { id: started.id, sessionId: started.sessionId, status: started.status };
      json(res, 200, started); return;
    }
    if (req.url === '/api/task/continue') {
      if (!task || task.status === 'running' || task.status === 'succeeded') throw new Error('There is no stopped task to continue.');
      const result = await (await client()).call('computer_continue', { taskId: task.id,
        guidance: String(data.guidance ?? '').trim(), inputs: inputs(data.values),
        minConfidence: minimumConfidence(data.minConfidence) });
      task = { id: result.id, sessionId: result.sessionId, status: result.status };
      json(res, 200, result); return;
    }
    if (req.url === '/api/task/stop') {
      if (!task || task.status !== 'running') throw new Error('No computer task is running.');
      json(res, 200, await (await client()).call('computer_cancel', { taskId: task.id })); return;
    }
    json(res, 404, { error: 'Not found.' });
  } catch (error) { json(res, 400, { error: error instanceof Error ? error.message : 'Request failed.' }); }
}

const server = createServer((req, res) => { void route(req, res); });
server.listen(port, '127.0.0.1', () => console.log(`Flick playground: http://127.0.0.1:${port}`));
async function close() {
  if (closing) return;
  closing = true;
  server.close();
  if (mcp && task?.status === 'running') await mcp.call('computer_cancel', { taskId: task.id }).catch(() => {});
  await mcp?.client.close();
}
process.once('SIGINT', () => { void close().finally(() => process.exit(0)); });
process.once('SIGTERM', () => { void close().finally(() => process.exit(0)); });
