import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scenario, verifyWorkspace, workspace, type WorkspaceState } from '../demo/workspace.js';

test('demo verification checks every saved task and export value and rejects duplicate writes', () => {
  const target = scenario();
  const { title, project, owner, priority, due, notes, notify, email, format, headers } = target;
  const state: WorkspaceState = { tasks: [{ title, project, owner, priority, due, notes, notify }], export: { email, format, headers } };
  assert.ok(Object.values(verifyWorkspace(state, target)).every(Boolean));
  for (const key of ['title', 'project', 'owner', 'priority', 'due', 'notes'] as const) {
    const wrong = structuredClone(state); wrong.tasks[0][key] = 'wrong';
    assert.equal(verifyWorkspace(wrong, target)[`task.${key}`], false);
  }
  const unchecked = structuredClone(state); unchecked.tasks[0].notify = false;
  assert.equal(verifyWorkspace(unchecked, target)['task.notify'], false);
  const wrongExport = structuredClone(state); wrongExport.export!.format = 'json';
  assert.equal(verifyWorkspace(wrongExport, target)['export.format'], false);
  const duplicate = structuredClone(state); duplicate.tasks.push({ ...duplicate.tasks[0] });
  assert.equal(verifyWorkspace(duplicate, target)['task.count'], false);
});

test('demo app stores browser form submissions independently of the agent and resets between scenarios', async () => {
  const web = await workspace();
  try {
    const target = web.target();
    const { title, project, owner, priority, due, notes, notify } = target;
    const saved = await fetch(web.url + '/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: web.url },
      body: JSON.stringify({ title, project, owner, priority, due, notes, notify }) });
    assert.equal(saved.status, 200);
    assert.equal(web.state().tasks[0].title, title);
    web.reset(1);
    assert.equal(web.state().tasks.length, 0);
    assert.notEqual(web.target().title, title);
    const denied = await fetch(web.url + '/tasks', { method: 'POST', headers: { Origin: 'https://example.com' }, body: '{}' });
    assert.equal(denied.status, 403);
  } finally { await web.close(); }
});
