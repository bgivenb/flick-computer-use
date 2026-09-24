import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture } from '../tests/fixture.js';
import { mcpClient } from '../tests/mcp-client.js';
import { loadConfig } from '../src/config.js';

const config = loadConfig();
const dir = await mkdtemp(join(tmpdir(), 'jev-live-'));
const web = await fixture();
const { client, call } = await mcpClient(dir);
try {
  const existingChrome = process.argv.includes('--existing-chrome');
  if (existingChrome) console.log('Connecting to your existing Chrome. Click Allow in Chrome if it asks.');
  const opened = await call('computer_open', { url: web.url, headless: !existingChrome && !process.argv.includes('--headed'),
    ...(existingChrome ? { connection: 'existing-chrome', browser: 'chrome' } : {}) });
  const task = await call('computer_run', {
    sessionId: opened.sessionId,
    goal: 'Open Export settings. Set Contact email to the supplied email, choose CSV as the export format, enable Include column headers, and Save settings.',
    inputs: { email: 'demo@example.com' },
    until: [{ kind: 'text', text: 'Export settings saved' }, { kind: 'field', name: 'Contact email', value: 'demo@example.com' },
      { kind: 'field', name: 'Export format', value: 'csv' }, { kind: 'checked', name: 'Include column headers', checked: true }],
    maxSteps: 12, timeoutMs: 60000,
  });
  let result;
  do { result = await call('computer_status', { taskId: task.id, waitMs: 20000 }); } while (result.status === 'running');
  const saved = await fetch(web.url + '/state').then(r => r.json());
  const report = { testedAt: new Date().toISOString(), scenario: `Local browser export-settings form through stdio MCP and live Jev (${existingChrome ? 'existing Chrome profile' : 'dedicated profile'})`,
    status: result.status, reason: result.reason, steps: result.steps, metrics: result.metrics, events: result.events,
    independentlyVerified: JSON.stringify(saved) === JSON.stringify({ email: 'demo@example.com', format: 'csv', headers: true }) };
  console.log(JSON.stringify(report, null, 2));
  await mkdir(config.localDir, { recursive: true });
  await writeFile(join(config.localDir, existingChrome ? 'last-existing-chrome-smoke.json' : 'last-live-smoke.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  assert.equal(result.status, 'succeeded', result.reason);
  assert.deepEqual(saved, { email: 'demo@example.com', format: 'csv', headers: true });
  await call('computer_close', { sessionId: opened.sessionId });
} finally { await client.close(); await web.close(); await rm(dir, { recursive: true, force: true }); }
