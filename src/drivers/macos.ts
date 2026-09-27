import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { RecoverableActionError, StaleObservationError, type Action, type Driver, type Observation } from '../core/types.js';
import { desktopLock } from '../core/desktop-lock.js';

function nativeActionError(error: unknown): Error {
  if (error instanceof StaleObservationError || error instanceof RecoverableActionError) return error;
  const failure = error instanceof Error ? error : new Error(String(error));
  const message = failure.message;
  if (/^STALE_OBSERVATION$|text under the click point no longer matches|Screen capture size does not match/i.test(message))
    return new StaleObservationError();
  // Permission, process, and protocol failures require a different owner or capability, not another click.
  if (/permission|must be handled manually|native helper|missing |unsupported key|unknown helper|invalid /i.test(message)) return failure;
  if (/Focus moved to another application|Another application is under the click point/i.test(message))
    return new RecoverableActionError('the target app no longer owns focus or the click location',
      'Reobserve the desktop and switch back to the intended app before choosing a fresh target. No input was sent.', 'wrong_surface');
  if (/The value was entered, but the field could not take focus to submit/i.test(message))
    return new RecoverableActionError('the value was entered but submission did not happen',
      'Inspect the current field value, focus that field, then submit once if still needed. Do not type the value again.', 'not_ready');
  if (/Could not focus the field/i.test(message))
    return new RecoverableActionError('the field did not accept keyboard focus',
      'Click the visible field, wait for its editor to become ready, and inspect focus before filling it again.', 'not_ready');
  if (/Multi-line text could not be set directly/i.test(message))
    return new RecoverableActionError('this editor could not confirm direct multiline filling',
      'Inspect the current text first. If it still needs filling, use the exact drafted text through clipboard paste into the focused editor, or choose another observed editing control.', 'unsupported_control');
  if (/control is disabled|did not finish launching|Could not activate target application/i.test(message))
    return new RecoverableActionError('the target app or control is not ready',
      'Wait for the interface to change, inspect any open dialog, and choose an enabled control before retrying.', 'not_ready');
  if (/click point is outside|window control is under the click point|Nothing accessible is under the click point/i.test(message))
    return new RecoverableActionError('the observed click location is no longer usable',
      'Inspect the current window and any covering dialog. Choose a fresh observed control or scan the screen before retrying.', 'occluded');
  if (/Accessibility press failed|Unsupported native action|Unsupported action on the observed native control/i.test(message))
    return new RecoverableActionError('the native control does not support that action',
      'Use another observed control, its menu, or a keyboard route. Scan the screen if Accessibility omitted the visible target.', 'unsupported_control');
  if (/No capturable window|No window area to capture|Screen capture failed|Screen capture could not be read|window is not on a connected display/i.test(message))
    return new RecoverableActionError('the current window could not be captured',
      'Bring the intended window into view and reobserve it, or continue using its Accessibility controls.', 'not_ready');
  return failure;
}

// Ignore observation IDs, capture times, and revision churn; wait for content or control availability.
function interfaceState(observation: Observation) {
  return JSON.stringify([observation.title, observation.text, observation.modal,
    observation.elements.map(e => [e.id, e.name, e.role, e.value, e.disabled, e.checked, e.selected, e.actions])]);
}

export class NativeBridge {
  private child: ChildProcessWithoutNullStreams;
  private pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout;
    started: boolean; interrupt: () => void; cleanup: () => void }>();
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
        // The helper resets its interrupt flag before this acknowledgement. An abort that
        // happened while the request was queued must be delivered after that reset.
        if (message.event === 'started') { entry.started = true; entry.interrupt(); return; }
        this.pending.delete(message.id); clearTimeout(entry.timer); entry.cleanup();
        if (message.error) entry.reject(message.error === 'STALE_OBSERVATION' ? new StaleObservationError() : new Error(message.error));
        else entry.resolve(message.result);
      } catch { this.close(); }
    });
    this.child.on('error', () => this.fail('Could not start the native helper.'));
    this.child.on('exit', () => this.fail('Native helper exited.'));
  }
  request(method: string, params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<any> {
    signal?.throwIfAborted();
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      let interrupted = false;
      const interrupt = () => {
        if (!signal?.aborted || interrupted || !this.pending.get(id)?.started || !['act', 'connect'].includes(method)) return;
        interrupted = true;
        this.child.kill('SIGUSR1');
      };
      const cleanup = () => signal?.removeEventListener('abort', interrupt);
      const timer = setTimeout(() => { this.pending.delete(id); cleanup(); reject(new Error('Native helper timed out.')); this.close(); }, 10000);
      // Do not settle at abort: keep ownership until the helper has released any held
      // key/button and acknowledged interruption (or exited).
      this.pending.set(id, { resolve: value => signal?.aborted ? reject(signal.reason) : resolve(value),
        reject: error => reject(signal?.aborted ? signal.reason : error), timer, started: false, interrupt, cleanup });
      signal?.addEventListener('abort', interrupt, { once: true });
      this.child.stdin.write(JSON.stringify({ id, method, ...params }) + '\n', error => { if (error) this.fail('Native helper connection closed.'); });
    });
  }
  private fail(message: string) {
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.cleanup(); entry.reject(new Error(message)); }
    this.pending.clear();
  }
  close() { this.fail('Native helper stopped.'); this.child.stdin.end(); this.child.kill(); }
}
export class MacOSDriver implements Driver {
  readonly id = randomUUID();
  readonly kind = 'macos' as const;
  readonly userActivityScope = 'desktop' as const;
  private connectionUncertain = false;
  get label() { return this.bundleId; }
  private constructor(private bridge: NativeBridge, private bundleId: string, private release: () => void, private ocr: 'auto' | 'always' | 'off') {}
  static async open(bundleId: string, path: string, ocr: 'auto' | 'always' | 'off' = 'auto', signal?: AbortSignal) {
    signal?.throwIfAborted();
    const driver = MacOSDriver.reserve(path, ocr);
    try { await driver.switchApp(bundleId, signal); return driver; } catch (error) { await driver.close(); throw error; }
  }
  static reserve(path: string, ocr: 'auto' | 'always' | 'off' = 'auto') {
    const release = desktopLock();
    let bridge: NativeBridge | undefined;
    try { bridge = new NativeBridge(path); return new MacOSDriver(bridge, '', release, ocr); }
    catch (error) { bridge?.close(); release(); throw error; }
  }
  async observe(options?: { ocr?: 'auto' | 'always' | 'off' }): Promise<Observation> {
    const result = await this.bridge.request('observe', { ocr: options?.ocr ?? this.ocr });
    // A cancelled connect may have activated its app before its response was
    // discarded. Only the helper's fresh observation can resolve that identity.
    const observedBundleId = typeof result.targetId === 'string' && result.targetId ? result.targetId : undefined;
    if (this.connectionUncertain && !observedBundleId)
      throw new Error('The native app connection changed during interruption. Reconnect the intended app before continuing; the helper did not report its current app.');
    if (observedBundleId) this.bundleId = observedBundleId;
    this.connectionUncertain = false;
    return { ...result, targetId: this.bundleId, ocrAvailable: this.ocr !== 'off', id: randomUUID(), sessionId: this.id, kind: this.kind, capturedAt: Date.now() };
  }
  async act(action: Action, observation: Observation, signal: AbortSignal) {
    signal.throwIfAborted();
    if (this.connectionUncertain || observation.sessionId !== this.id || (observation.targetId && observation.targetId !== this.bundleId)) throw new StaleObservationError();
    try {
      if (action.kind === 'wait') { await delay(200, undefined, { signal }); return; }
      if (action.kind === 'wait_for_change') return await this.waitForChange(observation, signal);
      if (action.kind === 'scan_screen') {
        const result = await this.observe({ ocr: 'always' });
        signal.throwIfAborted();
        return result;
      }
      if (action.kind === 'compose') throw new Error('Text composition runs in the task runner.');
      if (action.kind === 'wait_for_load' || action.kind === 'wait_for_images')
        throw new RecoverableActionError('native Accessibility cannot report browser document or image loading',
          'Choose wait_for_change to wait for visible native content, or use a browser session for page resource loading.', 'unsupported_control');
      if (['back', 'forward', 'refresh', 'scroll_top', 'scroll_bottom'].includes(action.kind))
        throw new RecoverableActionError('this navigation action requires a browser session',
          'Choose an observed native navigation control, menu item, or scroll action for this app.', 'unsupported_control');
      if (action.kind === 'switch' || action.kind === 'remember') throw new Error('Use a desktop session for app switching and memory.');
      if ('elementId' in action) {
        const element = observation.elements.find(e => e.id === action.elementId);
        if (!element) throw new StaleObservationError();
        if (element.disabled) throw new Error('The control is disabled.');
        if (!element.actions.includes(action.kind as 'click' | 'fill' | 'select')) throw new Error('Unsupported action on the observed native control.');
      }
      // The helper checks only this action's target (or, for a key, the observed focus) against the live interface.
      await this.bridge.request('act', { action, revision: observation.revision, ...(observation.focusedId ? { focusedId: observation.focusedId } : {}) }, signal);
      signal.throwIfAborted();
      await delay(40, undefined, { signal });
    } catch (error) {
      signal.throwIfAborted();
      throw nativeActionError(error);
    }
  }
  private async waitForChange(observation: Observation, signal: AbortSignal): Promise<Observation> {
    const before = interfaceState(observation), deadline = Date.now() + 3000;
    while (true) {
      signal.throwIfAborted();
      const current = await this.observe();
      signal.throwIfAborted();
      if (interfaceState(current) !== before || Date.now() >= deadline) return current;
      await delay(Math.min(150, deadline - Date.now()), undefined, { signal });
    }
  }
  async screenshot() { return Buffer.from((await this.bridge.request('screenshot')).png, 'base64'); }
  async switchApp(bundleId: string, signal?: AbortSignal) {
    let dispatched = false;
    try {
      signal?.throwIfAborted();
      dispatched = true;
      await this.bridge.request('connect', { bundleId, ocr: this.ocr }, signal);
      signal?.throwIfAborted();
      this.bundleId = bundleId;
      this.connectionUncertain = false;
    } catch (error) {
      if (dispatched) this.connectionUncertain = true;
      signal?.throwIfAborted(); throw nativeActionError(error);
    }
  }
  async close() { this.bridge.close(); this.release(); }
}
