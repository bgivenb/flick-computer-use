import { copyFile, mkdir, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createInterface } from 'node:readline/promises';
import { workspace, verifyWorkspace } from '../demo/workspace.js';
import { mcpClient } from '../tests/mcp-client.js';
import { loadConfig } from '../src/config.js';

const args = process.argv.slice(2);
const existing = args.includes('--existing-chrome');
const headless = args.includes('--headless');
const hold = args.includes('--hold');
const record = args.includes('--record');
const runs = Number(args.find(a => a.startsWith('--runs='))?.split('=')[1] ?? 1);
const countdown = Number(args.find(a => a.startsWith('--countdown='))?.split('=')[1] ?? (headless ? 0 : 4));
// Several unfinished form fields are equally valid next steps. This disposable demo uses an explicit
// lower threshold, with every saved field independently checked. Production defaults stay unchanged.
const minConfidence = Number(args.find(a => a.startsWith('--min-confidence='))?.split('=')[1] ?? 0.35);
if (!Number.isInteger(runs) || runs < 1 || runs > 20) throw new Error('Use --runs=1 through --runs=20.');
if (!Number.isInteger(countdown) || countdown < 0 || countdown > 30) throw new Error('Use --countdown=0 through --countdown=30.');
if (existing && headless) throw new Error('Existing Chrome is visible; omit --headless.');
if (existing && record) throw new Error('Use screen recording with existing Chrome, or omit --existing-chrome for built-in video recording.');
if (!Number.isFinite(minConfidence) || minConfidence < 0 || minConfidence > 1) throw new Error('Use --min-confidence between 0 and 1.');
const config = loadConfig();
const batchId = new Date().toISOString().replace(/[:.]/g, '-');
const archivePath = resolve(config.localDir, 'demo', `batch-${batchId}.json`);
const oldVideos = new Set(await readdir(resolve(config.localDir, 'recordings')).catch(() => []));
if (!config.apiKey) throw new Error('Set TYPESAFE_API_KEY in .env.local first. See .env.example.');
const web = await workspace();
const { client, call } = await mcpClient(config.localDir);
const reports: Array<Record<string, any>> = [];
let sessionId: string | undefined;
let activeTask: string | undefined;
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  if (activeTask) {
    await call('computer_cancel', { taskId: activeTask }).catch(() => {});
    await call('computer_status', { taskId: activeTask, waitMs: 20000 }).catch(() => {});
  }
  if (sessionId) await call('computer_close', { sessionId }).catch(() => {});
  await client.close(); await web.close();
}
process.once('SIGINT', () => { void close().finally(() => process.exit(130)); });
process.once('SIGTERM', () => { void close().finally(() => process.exit(143)); });
try {
  console.log(`\nFLICK / DISPATCH\n${web.url}\n`);
  console.log(existing ? 'Using your existing Chrome profile. Click Allow if Chrome asks.' : `Using a ${headless ? 'headless' : 'visible'} disposable Chromium profile.`);
  const opened = await call('computer_open', { url: web.url, headless, recordVideo: record,
    ...(existing ? { connection: 'existing-chrome', browser: 'chrome' } : { profile: 'dispatch-demo' }) });
  sessionId = opened.sessionId;
  for (let trial = 0; trial < runs; trial++) {
    web.reset(trial);
    await delay(200); // Fixture reset/connection setup is outside measured task time.
    const target = web.target();
    console.log(`Run ${trial + 1}/${runs}: ${target.goal}`);
    for (let remaining = countdown; remaining > 0; remaining--) {
      web.publish({ status: 'countdown', countdown: remaining }); await delay(1000);
    }
    const task = await call('computer_run', { sessionId,
      goal: target.goal, inputs: target.inputs,
      until: [
        { kind: 'text', text: `Task created: ${target.title}` },
        { kind: 'text', text: 'Export settings saved' },
        { kind: 'field', name: 'Export email', value: target.email },
        { kind: 'field', name: 'File format', value: 'csv' },
        { kind: 'checked', name: 'Include column headers', checked: true },
      ], maxSteps: 28, timeoutMs: 60000, minConfidence,
    });
    activeTask = task.id;
    web.publish({ status: 'running', startedAt: task.startedAt, steps: 0, events: [], interventions: 0 });
    let result: any, shown = 0;
    do {
      result = await call('computer_status', { taskId: task.id, waitMs: 0 });
      web.publish({ status: result.status, startedAt: result.startedAt, metrics: result.metrics, steps: result.steps, events: result.events });
      for (const event of result.events.slice(shown)) console.log(`  ${String(event.step).padStart(2, '0')}  ${event.action}`);
      shown = result.events.length;
      if (result.status === 'running') await delay(70);
    } while (result.status === 'running');
    activeTask = undefined;
    const saved = await fetch(`${web.url}/state`).then(r => r.json());
    const checks = verifyWorkspace(saved, target);
    const independentlyVerified = Object.values(checks).every(Boolean);
    const passed = result.status === 'succeeded' && independentlyVerified;
    web.publish({ status: passed ? 'verified' : result.status === 'succeeded' ? 'failed' : result.status,
      reason: result.reason, verification: { passed, checks: Object.keys(checks).length }, metrics: result.metrics });
    const report = { trial: trial + 1, scenario: trial % 3, testedAt: new Date().toISOString(),
      connection: existing ? 'existing-chrome' : 'dedicated', app: 'Dispatch local synthetic productivity workspace',
      task: target.goal, status: result.status, passed, independentlyVerified, checks, hostInterventions: 0,
      minConfidence, metrics: result.metrics, events: result.events, trace: result.trace, reason: result.reason };
    reports.push(report);
    await mkdir(resolve(config.localDir, 'demo'), { recursive: true });
    await writeFile(resolve(config.localDir, 'demo', 'latest.json'), JSON.stringify(reports, null, 2), { mode: 0o600 });
    await writeFile(archivePath, JSON.stringify(reports, null, 2), { mode: 0o600 });
    await delay(100); // Allow the presentation to paint the independently verified outcome.
    const screenshot = await call('computer_screenshot', { sessionId });
    const png = screenshot.content?.find((item: any) => item.type === 'image');
    if (png) await writeFile(resolve(config.localDir, 'demo', `run-${trial + 1}.png`), Buffer.from(png.data, 'base64'));
    console.log(`  ${passed ? 'PASS' : 'FAIL'} · ${(result.metrics.elapsedMs / 1000).toFixed(3)} s · ${result.steps} actions · ${result.metrics.modelCalls} Jev calls · 0 host interventions\n`);
    if (!passed) { process.exitCode = 1; break; }
    if (!headless && trial < runs - 1) await delay(2000);
  }
  const times = reports.filter(r => r.passed).map(r => r.metrics.elapsedMs).sort((a, b) => a - b);
  const median = times.length ? (times[Math.floor((times.length - 1) / 2)] + times[Math.floor(times.length / 2)]) / 2 : null;
  console.log(JSON.stringify({ completed: reports.length, passed: times.length, medianSuccessfulMs: median,
    minSuccessfulMs: times[0] ?? null, maxSuccessfulMs: times.at(-1) ?? null,
    note: 'Local synthetic app. Task timing excludes connection, countdown, fixture reset, and post-run independent verification.',
    report: archivePath }, null, 2));
  if (hold) {
    console.log('\nResult left open for screenshots or recording. Press Enter to close the task tab.');
    const input = createInterface({ input: process.stdin, output: process.stdout });
    await input.question(''); input.close();
  } else if (!headless) await delay(5000);
} finally {
  await close();
  if (record) {
    const files = (await readdir(resolve(config.localDir, 'recordings')).catch(() => [])).filter(name => name.endsWith('.webm') && !oldVideos.has(name));
    if (files.length === 1) {
      const output = resolve(config.localDir, 'demo', 'dispatch-demo.webm');
      await mkdir(resolve(config.localDir, 'demo'), { recursive: true });
      await copyFile(resolve(config.localDir, 'recordings', files[0]), output);
      console.log(`Uncut video: ${output}`);
    }
  }
}
