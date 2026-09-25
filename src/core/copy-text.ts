import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { StaleObservationError, type Driver, type ElementInfo, type Observation } from './types.js';

export const wantsTextCopy = (goal: string) => /\b(copy|copied|clipboard|paste|transfer|grab)\b/i.test(goal);

// Read-only choices are exposed only for goals that need text transfer, keeping ordinary
// computer-use decisions small. IDs are derived from observed text, never model-written.
export function withCopyableText(observation: Observation): Observation {
  const seen = new Set<string>();
  const lines: ElementInfo[] = [];
  for (const raw of observation.text.split(/\n+/)) {
    const value = raw.trim();
    if (value.length < 2 || value.length > 2000 || seen.has(value)) continue;
    seen.add(value);
    lines.push({ id: `read:line:${createHash('sha256').update(value).digest('hex').slice(0, 16)}`,
      role: 'text', name: value.slice(0, 160), value, disabled: false, actions: [] });
    if (lines.length >= 30) break;
  }
  if (observation.text.trim()) lines.unshift({ id: 'read:page-text', role: 'document', name: 'All visible page text',
    value: observation.text.slice(0, 10000), disabled: false, actions: [] });
  const existing = new Set(observation.elements.map(e => e.id));
  return { ...observation, elements: [...observation.elements, ...lines.filter(e => !existing.has(e.id))] };
}

export function unchangedCopyText(source: ElementInfo, fresh: Observation) {
  const value = source.value;
  if (!value?.trim() || value === '[redacted]' || value.length > 10000) throw new Error('Choose an observed nonempty text target.');
  if (source.id === 'read:page-text' && fresh.text.slice(0, 10000) === value) return value;
  if (source.id.startsWith('read:line:') && fresh.text.split(/\n+/).some(line => line.trim() === value)) return value;
  const current = fresh.elements.find(e => e.id === source.id && e.role === source.role && e.name === source.name);
  if (current?.value === value && current.value !== '[redacted]') return value;
  throw new StaleObservationError();
}

async function clipboardCommand(command: string, input: string | undefined, signal: AbortSignal) {
  const child = spawn(command, [], { stdio: ['pipe', 'pipe', 'ignore'], signal });
  const output: Buffer[] = [];
  child.stdout.on('data', chunk => output.push(Buffer.from(chunk)));
  if (input === undefined) child.stdin.end();
  else child.stdin.end(input);
  const code = await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => resolve(code ?? -1));
  });
  signal.throwIfAborted();
  if (code !== 0) throw new Error('The macOS clipboard command failed.');
  return Buffer.concat(output).toString('utf8');
}

export async function writeClipboardText(value: string, signal: AbortSignal) {
  if (process.platform !== 'darwin') throw new Error('Copying text to the system clipboard currently requires macOS.');
  signal.throwIfAborted();
  await clipboardCommand('pbcopy', value, signal);
  const copied = await clipboardCommand('pbpaste', undefined, signal);
  if (copied !== value) throw new Error('The clipboard did not retain the selected text.');
}

export async function copyObservedText(driver: Driver, observation: Observation, source: ElementInfo, signal: AbortSignal,
  write: (value: string, signal: AbortSignal) => Promise<void> = writeClipboardText) {
  if (!observation.elements.some(e => e.id === source.id && e.value === source.value))
    throw new Error('Choose a text target from the current observation.');
  const fresh = await driver.observe();
  signal.throwIfAborted();
  if (fresh.sessionId !== observation.sessionId || fresh.url !== observation.url || fresh.title !== observation.title)
    throw new StaleObservationError();
  const value = unchangedCopyText(source, fresh);
  await write(value, signal);
  return { ...fresh, clipboard: { changeCount: fresh.clipboard?.changeCount ?? 0,
    hasImage: false, copiedText: value } };
}
