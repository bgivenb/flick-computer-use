import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { StaleObservationError, type Action, type Driver, type Observation } from '../core/types.js';
import { desktopLock } from '../core/desktop-lock.js';

export class NativeBridge {
  private child: ChildProcessWithoutNullStreams;
  private pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  constructor(path: string) {
    if (process.platform !== 'darwin') throw new Error('Native desktop control currently supports macOS only.');
    if (!existsSync(path)) throw new Error('Native helper is missing. Run npm run build:native.');
    this.child = spawn(path, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stderr.resume();
    createInterface({ input: this.child.stdout }).on('line', line => {
      try {
        const message = JSON.parse(line);
        const entry = this.pending.get(message.id);
        if (!entry) return;
        this.pending.delete(message.id); clearTimeout(entry.timer);
        if (message.error) entry.reject(message.error === 'STALE_OBSERVATION' ? new StaleObservationError() : new Error(message.error));
        else entry.resolve(message.result);
      } catch { this.close(); }
    });
    this.child.on('error', () => this.fail('Could not start the native helper.'));
    this.child.on('exit', () => this.fail('Native helper exited.'));
  }
  request(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Native helper timed out.')); this.close(); }, 10000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, method, ...params }) + '\n', error => { if (error) this.fail('Native helper connection closed.'); });
    });
  }
  private fail(message: string) {
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(new Error(message)); }
    this.pending.clear();
  }
  close() { this.fail('Native helper stopped.'); this.child.stdin.end(); this.child.kill(); }
}
export class MacOSDriver implements Driver {
  readonly id = randomUUID();
  readonly kind = 'macos' as const;
  get label() { return this.bundleId; }
  private constructor(private bridge: NativeBridge, private bundleId: string, private release: () => void, private ocr: 'auto' | 'always' | 'off') {}
  static async open(bundleId: string, path: string, ocr: 'auto' | 'always' | 'off' = 'auto') {
    const driver = MacOSDriver.reserve(path, ocr);
    try { await driver.switchApp(bundleId); return driver; } catch (error) { await driver.close(); throw error; }
  }
  static reserve(path: string, ocr: 'auto' | 'always' | 'off' = 'auto') {
    const release = desktopLock();
    let bridge: NativeBridge | undefined;
    try { bridge = new NativeBridge(path); return new MacOSDriver(bridge, '', release, ocr); }
    catch (error) { bridge?.close(); release(); throw error; }
  }
  async observe(options?: { ocr?: 'auto' | 'always' | 'off' }): Promise<Observation> {
    const result = await this.bridge.request('observe', { ocr: options?.ocr ?? this.ocr });
    return { ...result, ocrAvailable: this.ocr !== 'off', id: randomUUID(), sessionId: this.id, kind: this.kind, capturedAt: Date.now() };
  }
  async act(action: Action, observation: Observation, signal: AbortSignal) {
    signal.throwIfAborted();
    if (observation.sessionId !== this.id) throw new StaleObservationError();
    if (action.kind === 'wait') { await delay(200, undefined, { signal }); return; }
    if (action.kind === 'scan_screen') return this.observe({ ocr: 'always' });
    if (action.kind === 'compose') throw new Error('Text composition runs in the task runner.');
    if (['wait_for_load', 'wait_for_change', 'wait_for_images', 'back', 'forward', 'refresh', 'scroll_top', 'scroll_bottom'].includes(action.kind))
      throw new Error('This action requires a browser session.');
    if (action.kind === 'switch' || action.kind === 'remember') throw new Error('Use a desktop session for app switching and memory.');
    if ('elementId' in action) {
      const element = observation.elements.find(e => e.id === action.elementId);
      if (!element || element.disabled || !element.actions.includes(action.kind as 'click' | 'fill' | 'select')) throw new Error('Unsupported action on the observed native control.');
    }
    // The helper checks only this action's target (or, for a key, the observed focus) against the live interface.
    await this.bridge.request('act', { action, revision: observation.revision, ...(observation.focusedId ? { focusedId: observation.focusedId } : {}) });
    signal.throwIfAborted();
    await delay(40, undefined, { signal });
  }
  async screenshot() { return Buffer.from((await this.bridge.request('screenshot')).png, 'base64'); }
  async switchApp(bundleId: string) {
    await this.bridge.request('connect', { bundleId, ocr: this.ocr });
    this.bundleId = bundleId;
  }
  async close() { this.bridge.close(); this.release(); }
}
