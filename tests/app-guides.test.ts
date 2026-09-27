import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AppGuideStore, appGuideSchema, guideMatches, type AppGuide } from '../src/core/app-guides.js';
import { registerAppGuideTools } from '../src/app-guide-tools.js';

const documented = { id: 'editor', text: 'Observe the note body before writing.', status: 'documented' as const,
  provenance: { source: 'builtin' as const, reference: 'https://support.apple.com/guide/notes/' } };
function guide(overrides: Partial<AppGuide> = {}): AppGuide {
  return { schemaVersion: 1, id: 'notes', name: 'Notes', version: 1, match: { bundleIds: ['com.apple.Notes'] }, instructions: [documented], ...overrides };
}
const observation = { targetId: 'com.apple.Notes', elements: [], url: undefined };
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'flick-guides-'));
  const builtins = join(dir, 'builtin'); await mkdir(builtins);
  const store = new AppGuideStore({ builtinDir: builtins, localDir: join(dir, 'local') });
  return { dir, builtins, store, close: () => rm(dir, { recursive: true, force: true }) };
}

test('guides match exact apps, exact hosts, explicit subdomains and roles without lookalike sites', () => {
  assert.equal(guideMatches(guide(), observation), true);
  assert.equal(guideMatches(guide(), { ...observation, targetId: 'com.apple.Notes.fake' }), false);
  const web = guide({ match: { hosts: ['example.com', '*.example.org'] } });
  for (const url of ['https://example.com/page', 'https://app.example.org/page']) assert.equal(guideMatches(web, { ...observation, url }), true);
  for (const url of ['https://example.com.evil.org', 'https://notexample.com', 'https://example.org', 'https://example.com@evil.org/', 'file:///example.com']) {
    assert.equal(guideMatches(web, { ...observation, url }), false);
  }
  const forms = guide({ match: { roles: ['textbox'] } });
  assert.equal(guideMatches(forms, { elements: [{ id: 'field', role: 'textbox', name: 'Name', disabled: false, actions: ['fill'] }] }), true);
  assert.equal(guideMatches(forms, observation), false);
});

test('only relevant established instructions load within a bounded context', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.builtins, 'notes.json'), JSON.stringify(guide()));
    await writeFile(join(f.builtins, 'messages.json'), JSON.stringify(guide({ id: 'messages', match: { bundleIds: ['com.apple.MobileSMS'] } })));
    assert.deepEqual((await f.store.forObservation(observation)).map(item => item.id), ['notes']);
    const failure = await f.store.recordFailure(observation, { action: 'fill', reason: 'The target became stale', guidance: 'Observe the field again' });
    assert.ok(failure);
    const saved = await f.store.get(failure.guideId);
    assert.equal(saved?.instructions[0].status, 'suggested');
    assert.deepEqual((await f.store.forObservation(observation)).map(item => item.id), ['notes']);
    await f.store.recordRecovery(observation, { failureId: failure, action: 'fill', result: 'The field matches the expected content' });
    assert.equal((await f.store.get(failure.guideId))?.instructions[0].status, 'suggested');
    const lesson = (await f.store.get(failure.guideId))!;
    await f.store.upsert({ guide: { ...lesson, instructions: [{ ...lesson.instructions[0], text: 'Re-observe a stale field before filling it.', status: 'validated', outcome: 'success', provenance: { source: 'agent', evidence: 'Retrying with the newly observed element resulted in the expected exact field value.' } }] }, expectedVersion: lesson.version });
    assert.equal((await f.store.forObservation(observation)).length, 2);
    assert.equal((await stat(join(f.store.localDir, `${failure.guideId}.json`))).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(join(f.builtins, 'notes.json'), 'utf8')), guide());
  } finally { await f.close(); }
});

test('versioned local edits preserve builtin guidance and reject stale or unvalidated replacement', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.builtins, 'notes.json'), JSON.stringify(guide()));
    await assert.rejects(f.store.upsert({ expectedVersion: 1, guide: guide({ instructions: [{ ...documented, status: 'suggested', outcome: 'failure', provenance: { source: 'agent' } }] }) }), /cannot replace/);
    const changed = await f.store.upsert({ expectedVersion: 1, guide: guide({ instructions: [{ id: 'body-first', text: 'Click into the note body before using Paste.', status: 'validated', outcome: 'success', provenance: { source: 'agent', evidence: 'The pasted text appeared in the selected note body.' } }] }) });
    assert.equal(changed.version, 2);
    assert.equal(changed.instructions.length, 2);
    await assert.rejects(f.store.upsert({ expectedVersion: 1, guide: changed }), /version changed/);
    const reread = new AppGuideStore({ builtinDir: f.builtins, localDir: join(f.dir, 'local') });
    assert.deepEqual(await reread.get('notes'), changed);
  } finally { await f.close(); }
});

test('guide writes reject traversal, symlinks, and invalid lesson provenance', async () => {
  const f = await fixture();
  try {
    const local = guide({ instructions: [{ ...documented, status: 'validated', provenance: { source: 'agent', evidence: 'Observed exact expected note content after filling.' } }] });
    await assert.rejects(f.store.upsert({ expectedVersion: 0, guide: { ...local, id: '../escape' } }));
    await assert.rejects(f.store.upsert({ expectedVersion: 0, guide: guide() }), /Local updates/);
    assert.equal(appGuideSchema.safeParse({ ...local, instructions: [{ ...local.instructions[0], provenance: { source: 'agent' } }] }).success, false);
    assert.equal(appGuideSchema.safeParse({ ...local, instructions: [{ ...local.instructions[0], outcome: 'failure' }] }).success, false);
    const external = join(f.dir, 'outside.json'); await writeFile(external, 'untouched');
    await mkdir(f.store.localDir, { recursive: true });
    await symlink(external, join(f.store.localDir, 'notes.json'));
    await assert.rejects(f.store.upsert({ expectedVersion: 0, guide: local }), /symbolic links/);
    assert.equal(await readFile(external, 'utf8'), 'untouched');
    assert.deepEqual(await f.store.list(), []);
  } finally { await f.close(); }
});

test('failure lessons stay local and omit page content, paths, query parameters, and credentials', async () => {
  const f = await fixture();
  try {
    const lesson = await f.store.recordFailure({ url: 'https://example.com/private?token=secret', elements: [] }, {
      action: 'fill', reason: 'Failed at https://example.com/private?token=secret with sk-exampletestkey',
    });
    const saved = await readFile(join(f.store.localDir, `${lesson!.guideId}.json`), 'utf8');
    assert.equal(saved.includes('token=secret'), false);
    assert.equal(saved.includes('sk-exampletestkey'), false);
    assert.equal(saved.includes('https://example.com/private'), false);
    assert.equal((await f.store.forObservation({ url: 'https://example.com', elements: [] })).length, 0);
    assert.equal((await f.store.list()).length, 1);
  } finally { await f.close(); }
});

test('guide MCP tools expose reading and evidence-backed local updates', async () => {
  const f = await fixture();
  try {
    const handlers = new Map<string, (args: any) => Promise<any>>();
    registerAppGuideTools({ registerTool(name: string, _config: unknown, handler: (args: any) => Promise<any>) { handlers.set(name, handler); } } as any, f.store);
    assert.equal(handlers.size, 2);
    const value = guide({ instructions: [{ id: 'draft', text: 'Use the observed editor.', status: 'suggested', provenance: { source: 'user' } }] });
    const update = await handlers.get('computer_guide_update')!({ guide: value, expectedVersion: 0 });
    assert.equal(JSON.parse(update.content[0].text).savedLocally, true);
    const read = await handlers.get('computer_guide_read')!({ id: 'notes' });
    assert.equal(JSON.parse(read.content[0].text).guide.instructions[0].status, 'suggested');
    const missing = await handlers.get('computer_guide_read')!({ id: 'absent' });
    assert.equal(missing.isError, true);
  } finally { await f.close(); }
});

test('bundled library conforms and keeps per-observation context small', async () => {
  const f = await fixture();
  try {
    const store = new AppGuideStore({ localDir: join(f.dir, 'local') });
    const catalog = await store.list(); assert.ok(catalog.length >= 8);
    for (const item of catalog) assert.ok(appGuideSchema.safeParse(await store.get(item.id)).success);
    const context = await store.forObservation({ targetId: 'com.google.Chrome', url: 'https://www.linkedin.com/feed/',
      elements: [{ id: 'f1', role: 'textbox', name: 'Composer', disabled: false, actions: ['fill'] }] });
    assert.ok(context.length >= 1 && context.length <= 3);
    assert.ok(context.reduce((sum, item) => sum + item.instructions.join('').length, 0) <= 3000);
  } finally { await f.close(); }
});

test('Gmail guidance loads only on Gmail and includes recipient and draft recovery', async () => {
  const dir=await mkdtemp(join(tmpdir(),'flick-gmail-guide-'));
  try {
    const store=new AppGuideStore({builtinDir:resolve('app-guides'),localDir:join(dir,'local')});
    const loaded=await store.forObservation({url:'https://mail.google.com/mail/u/0/#drafts',elements:[]});
    const gmail=loaded.find(g=>g.id==='gmail');
    assert.ok(gmail);
    assert.equal(gmail.instructions.length,6);
    assert.match(gmail.instructions.join('\n'),/To recipients/);
    assert.match(gmail.instructions.join('\n'),/unsent-draft/);
    assert.equal((await store.forObservation({url:'https://mail.google.com.evil.test/',elements:[]})).some(g=>g.id==='gmail'),false);
  } finally {await rm(dir,{recursive:true,force:true});}
});
