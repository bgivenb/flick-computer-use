import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture } from './fixture.js';
import { mcpClient } from './mcp-client.js';

test('real stdio MCP: discovery, schemas, session, action, missing-key error, and cleanup', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jev-mcp-')); const web = await fixture();
  const { client, call } = await mcpClient(dir, { TYPESAFE_API_KEY: '' });
  try {
    const tools = (await client.listTools()).tools;
    assert.ok(tools.some(t => t.name === 'computer_run'));
    assert.ok(tools.some(t => t.name === 'computer_workflow'));
    assert.ok(tools.some(t => t.name === 'computer_execute'));
    assert.ok(tools.some(t => t.name === 'computer_continue'));
    assert.equal((await call('computer_health')).apiKeyConfigured, false);
    const session = await call('computer_open', { url: web.url, headless: true });
    assert.ok(session.sessionId);
    const button = session.observation.elements.find((e: any) => e.name === 'Export settings');
    const result = await call('computer_act', { sessionId: session.sessionId, observationId: session.observation.id, action: { kind: 'click', elementId: button.id } });
    assert.ok(result.elements.some((e: any) => e.name === 'Contact email'));
    await assert.rejects(call('computer_run', { sessionId: session.sessionId, goal: 'Save', until: [{ kind: 'text', text: 'Saved' }] }), /TYPESAFE_API_KEY/);
    const bad = await client.callTool({ name: 'computer_run', arguments: { sessionId: session.sessionId, goal: 'Save', until: [] } });
    assert.equal(bad.isError, true);
    await call('computer_close', { sessionId: session.sessionId });
    assert.deepEqual((await call('computer_sessions')).sessions, []);
  } finally { await client.close(); await web.close(); await rm(dir, { recursive: true, force: true }); }
});

test('stdio live-check harness inherits externally configured credentials and model', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'flick-env-'));
  const previousKey = process.env.TYPESAFE_API_KEY;
  const previousModel = process.env.TYPESAFE_MODEL;
  process.env.TYPESAFE_API_KEY = 'synthetic-health-test-key';
  process.env.TYPESAFE_MODEL = 'synthetic-health-test-model';
  try {
    const { client, call } = await mcpClient(dir);
    try {
      const health = await call('computer_health');
      assert.equal(health.apiKeyConfigured, true);
      assert.equal(health.model, 'synthetic-health-test-model');
      assert.equal(JSON.stringify(health).includes('synthetic-health-test-key'), false);
    } finally { await client.close(); }
  } finally {
    if (previousKey === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = previousKey;
    if (previousModel === undefined) delete process.env.TYPESAFE_MODEL;
    else process.env.TYPESAFE_MODEL = previousModel;
    await rm(dir, { recursive: true, force: true });
  }
});
