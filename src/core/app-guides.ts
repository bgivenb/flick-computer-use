import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Observation } from './types.js';

const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/);
const host = z.string().max(253).regex(/^(?:\*\.)?[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/)
  .refine(value => !value.includes('..') && (!value.startsWith('*.') || value.slice(2).includes('.')), 'Use an exact hostname or an explicit *.domain.tld scope.');
export const guideInstructionSchema = z.object({
  id: slug,
  text: z.string().trim().min(1).max(600),
  status: z.enum(['documented', 'validated', 'suggested']),
  provenance: z.object({
    source: z.enum(['builtin', 'agent', 'user']),
    reference: z.string().max(500).optional(),
    evidence: z.string().max(600).optional(),
  }).strict(),
  outcome: z.enum(['success', 'failure']).optional(),
}).strict().refine(entry => entry.status !== 'validated' || Boolean(entry.provenance.evidence?.trim()), 'Validated instructions need observed evidence.')
  .refine(entry => entry.outcome !== 'failure' || entry.status === 'suggested', 'A failed interaction is an unvalidated suggestion.');
export const appGuideSchema = z.object({
  schemaVersion: z.literal(1), id: slug, name: z.string().trim().min(1).max(100), version: z.number().int().min(1),
  match: z.object({
    bundleIds: z.array(z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,199}$/)).max(12).optional(),
    hosts: z.array(host).max(12).optional(),
    roles: z.array(z.string().min(1).max(80)).max(12).optional(),
  }).strict().refine(match => [match.bundleIds, match.hosts, match.roles].some(items => items?.length), 'Supply at least one app, hostname, or control role.'),
  instructions: z.array(guideInstructionSchema).min(1).max(24),
}).strict().refine(guide => new Set(guide.instructions.map(entry => entry.id)).size === guide.instructions.length, 'Instruction IDs must be unique.');
export type AppGuide = z.infer<typeof appGuideSchema>;
export type GuideInstruction = z.infer<typeof guideInstructionSchema>;
export type GuideObservation = Pick<Observation, 'targetId' | 'url' | 'elements'>;
export interface AppGuideContext { id: string; name: string; version: number; instructions: string[] }
export interface GuideFailure { reason: string; guidance?: string; action?: string }
export interface GuideLessonId { guideId: string; instructionId: string }
function scrubLesson(value: string, limit: number): string {
  return value.replace(/(?:sk-|gsk_|csk-|apikey_)[a-zA-Z0-9_-]+/g, '[redacted]').replace(/https?:\/\/\S+/g, '[URL]').slice(0, limit);
}
const DEFAULT_BUILTINS = resolve(dirname(fileURLToPath(import.meta.url)), '../../app-guides');
const MAX_FILE_BYTES = 64000;

function hostname(url: string | undefined): string | undefined {
  try { const parsed = new URL(url || ''); return /^(https?:)$/.test(parsed.protocol) ? parsed.hostname.toLowerCase() : undefined; }
  catch { return undefined; }
}
export function guideMatches(guide: AppGuide, observation: GuideObservation): boolean {
  if (observation.targetId && guide.match.bundleIds?.includes(observation.targetId)) return true;
  const current = hostname(observation.url);
  if (current && guide.match.hosts?.some(scope => scope.startsWith('*.')
    ? current.endsWith(`.${scope.slice(2)}`) && current !== scope.slice(2) : current === scope)) return true;
  return Boolean(guide.match.roles?.some(role => observation.elements.some(element => element.role === role)));
}

async function regularJson(path: string): Promise<unknown> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error('Guide must be a regular JSON file smaller than 64 KB.');
    return JSON.parse(await handle.readFile('utf8'));
  } finally { await handle.close(); }
}
async function directory(path: string, create = false): Promise<boolean> {
  if (create) await mkdir(path, { recursive: true, mode: 0o700 });
  try { const stat = await lstat(path); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Guide storage must be a real directory, not a symbolic link.'); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
function mergeGuide(builtin: AppGuide | undefined, local: AppGuide): AppGuide {
  if (!builtin) return local;
  const entries = new Map(builtin.instructions.map(entry => [entry.id, entry]));
  for (const entry of local.instructions) {
    const previous = entries.get(entry.id);
    // A failure report can never suppress established instructions, even in hand-edited files.
    if (entry.status === 'suggested' && previous && previous.status !== 'suggested') continue;
    entries.set(entry.id, entry);
  }
  return { ...local, instructions: [...entries.values()].slice(0, 24) };
}

/** User-owned learning stays under localDir. Only matched, established guidance enters model state. */
export class AppGuideStore {
  readonly builtinDir: string;
  readonly localDir: string;
  private builtinCache?: Promise<Map<string, AppGuide>>;
  private localCache = new Map<string, AppGuide>();
  private localStamp = -1;
  private mutation: Promise<unknown> = Promise.resolve();
  constructor(options: { builtinDir?: string; localDir: string }) {
    this.builtinDir = resolve(options.builtinDir || DEFAULT_BUILTINS);
    this.localDir = resolve(options.localDir, 'app-guides');
  }
  private async readDirectory(path: string): Promise<Map<string, AppGuide>> {
    const result = new Map<string, AppGuide>();
    if (!await directory(path)) return result;
    for (const name of (await readdir(path)).sort()) {
      if (!/^[a-z0-9][a-z0-9-]{0,79}\.json$/.test(name)) continue;
      try {
        const guide = appGuideSchema.parse(await regularJson(join(path, name)));
        if (`${guide.id}.json` === name) result.set(guide.id, guide);
      } catch { /* A malformed or linked guide does not break computer use or get loaded. */ }
    }
    return result;
  }
  private async all(): Promise<Map<string, AppGuide>> {
    this.builtinCache ??= this.readDirectory(this.builtinDir);
    const builtin = await this.builtinCache;
    const exists = await directory(this.localDir);
    const stamp = exists ? (await lstat(this.localDir)).mtimeMs : 0;
    if (stamp !== this.localStamp) {
      this.localCache = exists ? await this.readDirectory(this.localDir) : new Map();
      this.localStamp = stamp;
    }
    const guides = new Map(builtin);
    for (const [id, local] of this.localCache) guides.set(id, mergeGuide(builtin.get(id), local));
    return guides;
  }
  async list(): Promise<Array<{ id: string; name: string; version: number; match: AppGuide['match']; suggestions: number }>> {
    return [...(await this.all()).values()].map(guide => ({ id: guide.id, name: guide.name, version: guide.version,
      match: guide.match, suggestions: guide.instructions.filter(entry => entry.status === 'suggested').length }));
  }
  async get(id: string): Promise<AppGuide | undefined> { return (await this.all()).get(slug.parse(id)); }
  async forObservation(observation: GuideObservation): Promise<AppGuideContext[]> {
    const matched = [...(await this.all()).values()].filter(guide => guideMatches(guide, observation));
    // App/site-specific guidance takes precedence over generic control-role guidance.
    matched.sort((a, b) => Number(Boolean(b.match.bundleIds?.length || b.match.hosts?.length)) - Number(Boolean(a.match.bundleIds?.length || a.match.hosts?.length)));
    const context: AppGuideContext[] = [];
    let remaining = 3000;
    for (const guide of matched) {
      const instructions: string[] = [];
      for (const entry of guide.instructions) {
        if (entry.status === 'suggested' || entry.outcome === 'failure') continue;
        if (entry.text.length > remaining) continue;
        instructions.push(entry.text); remaining -= entry.text.length;
        if (instructions.length >= 6) break;
      }
      if (instructions.length) context.push({ id: guide.id, name: guide.name, version: guide.version, instructions });
      if (context.length >= 3 || remaining < 100) break;
    }
    return context;
  }
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = this.mutation.then(work);
    this.mutation = result.catch(() => undefined);
    return result;
  }
  async upsert(input: { guide: AppGuide; expectedVersion: number }): Promise<AppGuide> {
    return this.serialize(() => this.update(input));
  }
  private async update(input: { guide: AppGuide; expectedVersion: number }): Promise<AppGuide> {
    const guide = appGuideSchema.parse(input.guide);
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) throw new Error('expectedVersion must be the current version, or 0 for a new guide.');
    // Re-read before every mutation so another MCP process's completed edits are visible.
    this.localStamp = -1;
    const previous = await this.get(guide.id);
    if ((previous?.version || 0) !== input.expectedVersion) throw new Error('Guide version changed. Read the guide again before updating.');
    for (const entry of guide.instructions) {
      const prior = previous?.instructions.find(item => item.id === entry.id);
      const unchanged = prior && JSON.stringify(prior) === JSON.stringify(entry);
      if (unchanged) continue;
      if (entry.provenance.source === 'builtin' || entry.status === 'documented') throw new Error('Local updates must be agent/user suggestions or evidence-backed validated instructions.');
      if (prior && prior.status !== 'suggested' && entry.status === 'suggested') throw new Error('Record the failed interaction under a new instruction ID; it cannot replace established guidance.');
    }
    // Merge rather than deleting instructions omitted by a partial edit.
    const entries = new Map(previous?.instructions.map(entry => [entry.id, entry]) || []);
    for (const entry of guide.instructions) entries.set(entry.id, entry);
    const saved = appGuideSchema.parse({ ...guide, version: input.expectedVersion + 1, instructions: [...entries.values()] });
    await directory(dirname(this.localDir), true);
    await directory(this.localDir, true);
    const destination = join(this.localDir, `${saved.id}.json`);
    try { if ((await lstat(destination)).isSymbolicLink()) throw new Error('Guide files cannot be symbolic links.'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const temporary = join(this.localDir, `.${saved.id}.${randomUUID()}.tmp`);
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(saved, null, 2)}\n`); await handle.close();
      await rename(temporary, destination);
    } catch (error) { await handle.close().catch(() => undefined); await unlink(temporary).catch(() => undefined); throw error; }
    this.localStamp = -1;
    return saved;
  }
  async recordFailure(observation: GuideObservation, failure: GuideFailure): Promise<GuideLessonId | undefined> {
    return this.serialize(() => this.saveFailure(observation, failure));
  }
  private async saveFailure(observation: GuideObservation, failure: GuideFailure): Promise<GuideLessonId | undefined> {
    const currentHost = hostname(observation.url);
    const match: AppGuide['match'] = currentHost ? { hosts: [currentHost] }
      : observation.targetId && /^[a-zA-Z0-9][a-zA-Z0-9.-]{0,199}$/.test(observation.targetId) ? { bundleIds: [observation.targetId] } : {};
    if (!match.hosts && !match.bundleIds) return;
    const scope = currentHost || observation.targetId!;
    const id = `learned-${scope.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 50)}-${createHash('sha256').update(scope).digest('hex').slice(0, 8)}`;
    const old = await this.get(id);
    if ((old?.instructions.length || 0) >= 24) return;
    const clean = (value: string) => scrubLesson(value, 250);
    const text = `Observed failure${failure.action ? ` during ${clean(failure.action)}` : ''}: ${clean(failure.reason)}. ${failure.guidance ? `Possible recovery: ${clean(failure.guidance)}` : 'Inspect the current interface and establish a successful recovery before validating this lesson.'}`.slice(0, 600);
    const duplicate = old?.instructions.find(entry => entry.text === text);
    if (duplicate) return { guideId: id, instructionId: duplicate.id };
    const instructionId = `failure-${randomUUID().slice(0, 8)}`;
    await this.update({ expectedVersion: old?.version || 0, guide: {
      schemaVersion: 1, id, name: `Local lessons: ${scope}`.slice(0, 100), version: old?.version || 1,
      match, instructions: [{ id: instructionId, text, status: 'suggested', outcome: 'failure',
        provenance: { source: 'agent', evidence: 'Recorded from a failed interaction. Recovery has not been validated.' } }],
    } });
    return { guideId: id, instructionId };
  }
  async recordRecovery(observation: GuideObservation, recovery: { failureId: GuideLessonId; action?: string; result: string }): Promise<void> {
    return this.serialize(() => this.saveRecovery(observation, recovery));
  }
  private async saveRecovery(_observation: GuideObservation, recovery: { failureId: GuideLessonId; action?: string; result: string }): Promise<void> {
    const guide = await this.get(recovery.failureId.guideId);
    const entry = guide?.instructions.find(item => item.id === recovery.failureId.instructionId);
    if (!guide || !entry || entry.status !== 'suggested') return;
    const evidence = `Observed a later recovery${recovery.action ? ` using ${scrubLesson(recovery.action, 80)}` : ''}: ${scrubLesson(recovery.result, 350)}. Host review is still required before treating this as general guidance.`;
    await this.update({ expectedVersion: guide.version, guide: { ...guide, instructions: [{ ...entry, provenance: { ...entry.provenance, evidence: evidence.slice(0, 600) } }] } });
  }
}
