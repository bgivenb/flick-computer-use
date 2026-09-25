import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { fixture } from './fixture.js';
import { BrowserDriver } from '../src/drivers/browser.js';
import { StaleObservationError, candidatesFor } from '../src/core/types.js';

const ocrImagePath = fileURLToPath(new URL('../.local/bin/flick-ocr-image', import.meta.url));
test('real browser: Jev can request local OCR and click a canvas-only label', { skip: process.platform !== 'darwin' || !existsSync(ocrImagePath) }, async t => {
  const web = await fixture(); const dir = await mkdtemp(join(tmpdir(), 'jev-ocr-test-'));
  t.after(async () => { await web.close(); await rm(dir, { recursive: true, force: true }); });
  const driver = await BrowserDriver.open({ url: web.url + '/canvas-ocr', headless: true, ocrImagePath }, dir);
  try {
    const signal = new AbortController().signal;
    const before = await driver.observe();
    assert.equal(before.elements.some(e => /OPEN PAINTED PANEL/.test(e.name)), false);
    assert.ok(candidatesFor(before, {}).scan_screen);
    const scanned = (await driver.act({ kind: 'scan_screen' }, before, signal))!;
    assert.equal(scanned.ocr?.used, true);
    const label = scanned.elements.find(e => e.source === 'ocr' && /OPEN PAINTED PANEL/.test(e.name));
    assert.ok(label, JSON.stringify(scanned.elements.filter(e => e.source === 'ocr').map(e => e.name)));
    assert.equal(candidatesFor(scanned, {}).scan_screen, undefined);
    await driver.act({ kind: 'click', elementId: label.id }, scanned, signal);
    assert.match((await driver.observe()).text, /Canvas panel opened/);
  } finally { await driver.close(); }
});

test('real browser: form flow, stale observation rejection, and independent saved state', async t => {
  const web = await fixture(); const dir = await mkdtemp(join(tmpdir(), 'jev-test-'));
  t.after(async () => { await web.close(); await rm(dir, { recursive: true, force: true }); });
  const driver = await BrowserDriver.open({ url: web.url, headless: true }, dir);
  try {
    let observation = await driver.observe();
    assert.equal(observation.elements.some(e => e.name === 'Contact email'), false);
    await driver.act({ kind: 'click', elementId: observation.elements.find(e => e.name === 'Export settings')!.id }, observation, new AbortController().signal);
    const stale = observation; observation = await driver.observe();
    await assert.rejects(driver.act({ kind: 'click', elementId: stale.elements[0].id }, stale, new AbortController().signal), StaleObservationError);
    for (const action of [
      { kind: 'fill' as const, name: 'Contact email', value: 'demo@example.com' },
      { kind: 'select' as const, name: 'Export format', value: 'csv' },
      { kind: 'click' as const, name: 'Include column headers' },
      { kind: 'click' as const, name: 'Save settings' },
    ]) {
      const target = observation.elements.find(e => e.name === action.name);
      assert.ok(target, action.name);
      await driver.act({ ...action, elementId: target.id }, observation, new AbortController().signal);
      observation = await driver.observe();
    }
    assert.deepEqual(web.state(), { email: 'demo@example.com', format: 'csv', headers: true });
    assert.match(observation.text, /Export settings saved/);
    assert.ok((await driver.screenshot()).length > 1000);
  } finally { await driver.close(); }
});
test('real browser: a live-updating page does not invalidate an unchanged target, and a fill can submit', async t => {
  const web = await fixture(); const dir = await mkdtemp(join(tmpdir(), 'jev-test-'));
  t.after(async () => { await web.close(); await rm(dir, { recursive: true, force: true }); });
  const driver = await BrowserDriver.open({ url: web.url + '/live', headless: true }, dir);
  const signal = new AbortController().signal;
  try {
    const first = await driver.observe();
    await delay(100);
    assert.notEqual((await driver.observe()).revision, first.revision, 'the page must have changed since the decision');
    const field = first.elements.find(e => e.name === 'Search' && e.actions.includes('fill'))!;
    await driver.act({ kind: 'fill', elementId: field.id, value: 'Elvis Presley', submit: true }, first, signal);
    const submitted = await driver.observe();
    assert.match(submitted.text, /Submitted Elvis Presley/);
    await delay(100);
    await driver.act({ kind: 'click', elementId: submitted.elements.find(e => e.role === 'button' && e.name === 'Search')!.id }, submitted, signal);
    assert.match((await driver.observe()).text, /Searched Elvis Presley/);
  } finally { await driver.close(); }
});
test('real browser: shadow roots, frames, hidden inputs, and password redaction', async t => {
  const web = await fixture(); const dir = await mkdtemp(join(tmpdir(), 'jev-test-'));
  t.after(async () => { await web.close(); await rm(dir, { recursive: true, force: true }); });
  const driver = await BrowserDriver.open({ url: web.url + '/edges', headless: true }, dir);
  try {
    const o = await driver.observe();
    assert.ok(o.elements.some(e => e.name === 'Shadow action'));
    assert.ok(o.elements.some(e => e.name === 'Frame action'));
    assert.equal(o.elements.some(e => e.name === 'Hidden input'), false);
    assert.equal(JSON.stringify(o).includes('do-not-expose'), false);
    assert.deepEqual(o.elements.find(e => e.name === 'Password')?.actions, []);
    const image = o.elements.find(e => e.name === 'Test illustration');
    assert.ok(image?.image);
    assert.equal(image.image.url, '[embedded image]');
    assert.ok((await driver.copyImage(image.id, o)).length > 100);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(driver.act({ kind: 'fill', elementId: o.elements.find(e => e.name === 'Visible input')!.id, value: 'no' }, o, controller.signal));
    assert.equal((await driver.observe()).elements.find(e => e.name === 'Visible input')?.value, '');
  } finally { await driver.close(); }
});
test('real browser: clipped skip link is not offered as a clickable control', async t => {
  const web = await fixture(); const dir = await mkdtemp(join(tmpdir(), 'jev-test-'));
  t.after(async () => { await web.close(); await rm(dir, { recursive: true, force: true }); });
  const driver = await BrowserDriver.open({ url: web.url + '/clipped', headless: true }, dir);
  try {
    const observation = await driver.observe();
    assert.equal(observation.elements.find(e => e.name === 'Skip to main content')?.actions.includes('click'), false);
    assert.equal(observation.elements.find(e => e.name === 'Open results')?.actions.includes('click'), true);
  } finally { await driver.close(); }
});
test('real browser: default session follows links to another origin', async t => {
  const destination = await fixture(); const source = await fixture(destination.url);
  const dir = await mkdtemp(join(tmpdir(), 'jev-test-'));
  t.after(async () => { await source.close(); await destination.close(); await rm(dir, { recursive: true, force: true }); });
  const driver = await BrowserDriver.open({ url: source.url + '/outbound', headless: true }, dir);
  try {
    const before = await driver.observe();
    const link = before.elements.find(e => e.name === 'Open other site');
    assert.ok(link?.actions.includes('click'));
    await driver.act({ kind: 'click', elementId: link.id }, before, new AbortController().signal);
    const after = await driver.observe();
    assert.equal(after.url, destination.url + '/');
    assert.match(after.text, /Local automation lab/);
  } finally { await driver.close(); }
});
test('real browser: an explicit origin list still restricts navigation', async t => {
  const destination = await fixture(); const source = await fixture(destination.url);
  const dir = await mkdtemp(join(tmpdir(), 'jev-test-'));
  t.after(async () => { await source.close(); await destination.close(); await rm(dir, { recursive: true, force: true }); });
  const driver = await BrowserDriver.open({ url: source.url + '/outbound', headless: true,
    allowedOrigins: ['https://example.org'] }, dir);
  try {
    const before = await driver.observe();
    const link = before.elements.find(e => e.name === 'Open other site')!;
    await driver.act({ kind: 'click', elementId: link.id }, before, new AbortController().signal);
    await assert.rejects(driver.observe(), /outside the session’s explicitly allowed origins/);
  } finally { await driver.close(); }
});
test('real browser: Jev recovery actions wait for late content and images, then navigate history and refresh', async t => {
  const web = await fixture(); const dir = await mkdtemp(join(tmpdir(), 'jev-test-'));
  t.after(async () => { await web.close(); await rm(dir, { recursive: true, force: true }); });
  const driver = await BrowserDriver.open({ url: web.url + '/recovery', headless: true }, dir);
  const signal = new AbortController().signal;
  try {
    let observation = await driver.observe();
    assert.equal(observation.loading?.pendingImages, 1);
    assert.ok(candidatesFor(observation, {}).wait_for_load);
    assert.ok(candidatesFor(observation, {}).wait_for_change);
    assert.ok(candidatesFor(observation, {}).wait_for_images);
    observation = (await driver.act({ kind: 'wait_for_change' }, observation, signal))!;
    assert.ok(observation.text.includes('Results are ready') || observation.loading?.pendingImages === 0);
    observation = (await driver.act({ kind: 'wait_for_images' }, observation, signal))!;
    assert.equal(observation.loading?.pendingImages, 0);
    observation = (await driver.act({ kind: 'wait_for_load' }, observation, signal))!;
    assert.equal(observation.loading?.document, 'complete');
    assert.equal(observation.loading?.pendingImages, 0);
    assert.equal(candidatesFor(observation, {}).wait_for_load, undefined);
    assert.equal(candidatesFor(observation, {}).wait_for_images, undefined);
    const link = observation.elements.find(e => e.name === 'Next page')!;
    await driver.act({ kind: 'click', elementId: link.id }, observation, signal);
    observation = await driver.observe();
    assert.match(observation.text, /Next page arrived/);
    observation = (await driver.act({ kind: 'back' }, observation, signal))!;
    assert.equal(observation.url, web.url + '/recovery');
    observation = (await driver.act({ kind: 'forward' }, observation, signal))!;
    assert.equal(observation.url, web.url + '/recovery-next');
    observation = (await driver.act({ kind: 'refresh' }, observation, signal))!;
    assert.match(observation.text, /Next page arrived/);
  } finally { await driver.close(); }
});
test('real browser: jump to bottom and top exposes page position', async t => {
  const web = await fixture(); const dir = await mkdtemp(join(tmpdir(), 'jev-test-'));
  t.after(async () => { await web.close(); await rm(dir, { recursive: true, force: true }); });
  const driver = await BrowserDriver.open({ url: web.url + '/long-page', headless: true }, dir);
  const signal = new AbortController().signal;
  try {
    let observation = await driver.observe();
    assert.equal(observation.scroll?.canScrollDown, true);
    assert.ok(candidatesFor(observation, {}).scroll_bottom);
    observation = (await driver.act({ kind: 'scroll_bottom' }, observation, signal))!;
    assert.equal(observation.scroll?.canScrollUp, true);
    assert.equal(observation.scroll?.canScrollDown, false);
    assert.ok(candidatesFor(observation, {}).scroll_top);
    observation = (await driver.act({ kind: 'scroll_top' }, observation, signal))!;
    assert.equal(observation.scroll?.canScrollUp, false);
  } finally { await driver.close(); }
});
