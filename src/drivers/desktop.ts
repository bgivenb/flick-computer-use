import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import { BrowserDriver, type BrowserOptions } from './browser.js';
import { MacOSDriver } from './macos.js';
import { StaleObservationError, type Action, type Driver, type Observation } from '../core/types.js';

export const targetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('macos'), bundleId: z.string().min(1).max(200), name: z.string().min(1).max(120).optional() }),
  z.object({ kind: z.literal('browser'), name: z.string().min(1).max(120), url: z.string().url(),
    profile: z.string().regex(/^[a-zA-Z0-9_-]{1,60}$/).optional(), headless: z.boolean().default(false),
    connection: z.enum(['dedicated', 'existing-chrome']).default('dedicated'),
    browser: z.enum(['chromium', 'chrome']).default('chrome'), allowedOrigins: z.array(z.string().url()).max(30).default([]) }),
]);
export type DesktopTarget = z.infer<typeof targetSchema>;
type Target = DesktopTarget & { id: string; name: string };
type Fact = { key: string; value: string; source: string };
export interface DesktopFactory {
  native(): Driver & { switchApp(bundleId: string): Promise<void> };
  browser(options: BrowserOptions): Promise<Driver>;
}

export class DesktopDriver implements Driver {
  readonly id = randomUUID();
  readonly kind = 'desktop' as const;
  readonly label = 'Autonomous desktop';
  readonly targets: Target[];
  private native?: ReturnType<DesktopFactory['native']>;
  private browsers = new Map<string, Driver>();
  private active?: { target: Target; driver: Driver };
  private observed = new Map<string, Observation>();
  private facts: Fact[] = [];
  constructor(targets: DesktopTarget[], private factory: DesktopFactory) {
    this.targets = targets.map((t, index) => ({ ...t, id: t.kind === 'macos' ? t.bundleId : `browser:${index}`, name: t.name ?? (t.kind === 'macos' ? t.bundleId : 'Browser') }));
    if (new Set(this.targets.map(t => t.id)).size !== this.targets.length) throw new Error('Desktop targets must be unique.');
    // Reserve once. Switching apps and browser work cannot release ownership halfway through a goal.
    if (targets.some(t => t.kind === 'macos')) this.native = factory.native();
  }
  static open(targets: DesktopTarget[], config: { nativePath: string; localDir: string; ocrImagePath?: string }, ocr: 'auto' | 'always' | 'off') {
    return new DesktopDriver(targets, { native: () => MacOSDriver.reserve(config.nativePath, ocr),
      browser: options => BrowserDriver.open({ ...options, ocrImagePath: config.ocrImagePath }, config.localDir) });
  }
  async observe(options?: { ocr?: 'auto' | 'always' | 'off' }): Promise<Observation> {
    const raw = this.active ? await this.active.driver.observe(options) : undefined;
    return this.wrap(raw);
  }
  private wrap(raw?: Observation): Observation {
    const id = randomUUID();
    if (raw) { this.observed.set(id, raw); while (this.observed.size > 32) this.observed.delete(this.observed.keys().next().value!); }
    const elements = [...(raw?.elements ?? [])];
    if (raw?.text.trim()) elements.push({ id: 'read:visible-text', name: 'Visible text', role: 'document', value: raw.text.slice(0, 10000),
      disabled: false, actions: [] });
    return { ...raw, id, sessionId: this.id, kind: 'desktop', title: raw?.title ?? 'Choose an app for the goal',
      text: raw?.text ?? '', elements, targetId: this.active?.target.id,
      targets: this.targets.map(({ id, kind, name }) => ({ id, kind, name })), memory: structuredClone(this.facts),
      revision: createHash('sha256').update(JSON.stringify([this.active?.target.id, raw?.revision, this.facts])).digest('hex'),
      truncated: raw?.truncated ?? false, capturedAt: Date.now() };
  }
  async act(action: Action, observation: Observation, signal: AbortSignal): Promise<Observation | void> {
    signal.throwIfAborted();
    if (observation.sessionId !== this.id || observation.targetId !== this.active?.target.id) throw new StaleObservationError();
    if (action.kind === 'switch') {
      const target = this.targets.find(t => t.id === action.targetId);
      if (!target || !observation.targets?.some(t => t.id === target.id)) throw new Error('App switching needs an observed target.');
      if (target.kind === 'macos') {
        await this.native!.switchApp(target.bundleId);
        this.active = { target, driver: this.native! };
      } else {
        let driver = this.browsers.get(target.id);
        if (!driver) {
          driver = await this.factory.browser({ ...target, profile: target.profile ?? `desktop-${this.id.slice(0, 8)}-${this.targets.indexOf(target)}` });
          this.browsers.set(target.id, driver);
        }
        signal.throwIfAborted();
        await driver.focus?.();
        this.active = { target, driver };
      }
      signal.throwIfAborted();
      return;
    }
    const raw = this.observed.get(observation.id);
    if (!this.active || !raw) throw new StaleObservationError();
    if (action.kind === 'remember') {
      const element = observation.elements.find(e => e.id === action.elementId);
      if (!element?.value || element.value === '[redacted]') throw new Error('Only observed, readable text can be remembered.');
      const fresh = await this.active.driver.observe();
      signal.throwIfAborted();
      const current = action.elementId === 'read:visible-text' ? fresh.text.slice(0, 10000) : fresh.elements.find(e => e.id === element.id && e.name === element.name && e.role === element.role)?.value;
      if (fresh.title !== raw.title || current !== element.value) throw new StaleObservationError();
      if (!this.facts.some(f => f.value === current)) {
        if (this.facts.length >= 12) throw new Error('Task memory is full. Return the collected facts before starting another task.');
        this.facts.push({ key: `m${this.facts.length + 1}`, value: current, source: `${this.active.target.name} / ${element.name}` });
      }
      return this.wrap(fresh);
    }
    if ('elementId' in action && action.elementId.startsWith('read:')) throw new Error('Read-only text is not an input target.');
    const result = await this.active.driver.act(action, raw, signal);
    if (result) return this.wrap(result);
  }
  async screenshot() {
    if (!this.active) throw new Error('Choose an app before requesting a screenshot.');
    return this.active.driver.screenshot();
  }
  async close() {
    await Promise.allSettled([this.native?.close(), ...[...this.browsers.values()].map(driver => driver.close())]);
    this.active = undefined; this.observed.clear(); this.facts = [];
  }
}
