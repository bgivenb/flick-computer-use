import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserDriver } from '../src/drivers/browser.js';
import { copyObservedText, withCopyableText } from '../src/core/copy-text.js';
import { verify, type Driver, type Observation } from '../src/core/types.js';
import { expectedResult } from '../src/core/task-state.js';
import { fixture } from './fixture.js';

test('browser text is selected from the observation and copied verbatim', async () => {
  const web = await fixture();
  const dir = await mkdtemp(join(tmpdir(), 'flick-copy-test-'));
  let driver: BrowserDriver | undefined;
  try {
    driver = await BrowserDriver.open({ url: web.url, headless: true }, dir);
    const observation = withCopyableText(await driver.observe());
    const source = observation.elements.find(e => e.id.startsWith('read:line:') && e.value === 'Disposable controls for testing Jev. No external account.');
    assert.ok(source);
    let copied = '';
    const result = await copyObservedText(driver, observation, source, new AbortController().signal, async value => { copied = value; });
    assert.equal(copied, 'Disposable controls for testing Jev. No external account.');
    assert.equal(verify(observation, [{ kind: 'clipboard_text' }]).passed, false);
    assert.equal(verify(result, [{ kind: 'clipboard_text', contains: 'testing Jev' }]).passed, true);
  } finally {
    await driver?.close(); await web.close(); await rm(dir, { recursive: true, force: true });
  }
});

test('changed text is rejected before the clipboard writer runs', async () => {
  const before: Observation = { id: 'before', revision: '1', sessionId: 's', kind: 'browser', title: 'Page', url: 'https://example.test',
    text: 'Old value', elements: [], truncated: false, capturedAt: 0 };
  const view = withCopyableText(before);
  const source = view.elements.find(e => e.id.startsWith('read:line:'))!;
  const after = { ...before, id: 'after', revision: '2', text: 'New value' };
  const driver = { observe: async () => after } as Driver;
  let writes = 0;
  await assert.rejects(copyObservedText(driver, view, source, new AbortController().signal, async () => { writes++; }), /interface changed/);
  assert.equal(writes, 0);
});

test('copy feedback confirms identical clipboard text without requiring a counter change', async () => {
  const base: Observation = {id:'o',revision:'r',sessionId:'s',kind:'browser',title:'Page',
    text:'Exact source text',elements:[],truncated:false,capturedAt:0,
    clipboard:{changeCount:7,hasImage:false,copiedText:'Exact source text'}};
  const before=withCopyableText(base);
  const source=before.elements.find(e=>e.id==='read:page-text')!;
  const after=await copyObservedText({observe:async()=>base} as Driver,before,source,new AbortController().signal,async()=>{});
  const action={kind:'copy_text',elementId:source.id} as const;
  assert.equal(after.clipboard?.changeCount,7);
  assert.equal(expectedResult(action,before,after).status,'confirmed');
  assert.equal(expectedResult(action,before,{...after,clipboard:{changeCount:8,hasImage:false,copiedText:'Wrong text'}}).status,'uncertain');
  assert.equal(expectedResult(action,before,{...after,clipboard:undefined}).status,'uncertain');
});
