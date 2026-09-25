import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, type Browser, type BrowserContext, type Frame, type Page, type ElementHandle } from 'playwright';
import { RecoverableActionError, StaleObservationError, type Action, type Driver, type ElementInfo, type Observation } from '../core/types.js';
import { snapshotScript } from './browser-snapshot.js';

export interface BrowserOptions { url: string; headless?: boolean; profile?: string; allowedOrigins?: string[]; browser?: 'chromium' | 'chrome'; connection?: 'dedicated' | 'existing-chrome'; recordVideoDir?: string }
type Reference = { frame: Frame; localId: string; epoch: string; imageUrl?: string };
function navigationOrigins(start: URL, allowedOrigins?: string[]) {
  if (!allowedOrigins?.length) return undefined;
  return new Set([start.origin, ...allowedOrigins.map(value => {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Allowed origins must use HTTP or HTTPS.');
    return parsed.origin;
  })]);
}
export class BrowserDriver implements Driver {
  private static existingChrome?: { endpoint: string; browser: Browser };
  private static openingChrome?: Promise<{ endpoint: string; browser: Browser }>;
  readonly id = randomUUID();
  readonly kind = 'browser' as const;
  readonly label: string;
  private references = new Map<string, Map<string, Reference>>();
  private ownedPages = new Set<Page>();
  private constructor(private context: BrowserContext, private page: Page, private origins: Set<string> | undefined, browser: string,
    private connectedBrowser?: Browser) {
    this.label = connectedBrowser ? 'Google Chrome (existing profile, task tab)' : `${browser === 'chrome' ? 'Google Chrome' : 'Chromium'} (dedicated automation profile)`;
    const adopt = (page: Page) => {
      this.ownedPages.add(page); this.page = page;
      page.setDefaultTimeout(1800);
      page.on('dialog', dialog => { void dialog.dismiss().catch(() => {}); });
      if (connectedBrowser) page.on('popup', adopt);
    };
    adopt(page);
    // A personal browser may open unrelated tabs while a task runs. Only adopt our own popups.
    if (!connectedBrowser) context.on('page', adopt);
  }
  static async open(options: BrowserOptions, dataDir: string) {
    const url = new URL(options.url);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Browser URL must use HTTP or HTTPS.');
    if (options.connection === 'existing-chrome') return this.connectExisting(options);
    const profile = options.profile ?? 'default';
    if (!/^[a-zA-Z0-9_-]{1,60}$/.test(profile)) throw new Error('Profile must contain 1–60 letters, numbers, underscores, or hyphens.');
    const profilePath = resolve(dataDir, 'browser-profiles', profile);
    await mkdir(profilePath, { recursive: true, mode: 0o700 });
    const origins = navigationOrigins(url, options.allowedOrigins);
    const context = await chromium.launchPersistentContext(profilePath, {
      channel: options.browser === 'chrome' ? 'chrome' : undefined,
      chromiumSandbox: true,
      headless: options.headless ?? false, viewport: { width: 1280, height: 900 },
      acceptDownloads: false, serviceWorkers: 'block',
      ...(options.recordVideoDir ? { recordVideo: { dir: options.recordVideoDir, size: { width: 1280, height: 900 } } } : {}),
    });
    try {
      if (origins) {
        // Explicit origin lists restrict document navigation, not image/API/CDN subresources.
        await context.route('**/*', route => {
          const request = route.request();
          if (request.isNavigationRequest() && !origins.has(new URL(request.url()).origin)) return route.abort('blockedbyclient');
          return route.continue();
        });
      }
      const page = context.pages()[0] ?? await context.newPage();
      await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 20000 });
      return new BrowserDriver(context, page, origins, options.browser ?? 'chromium');
    } catch (error) { await context.close(); throw error; }
  }
  private static async approvedChrome(endpoint: string) {
    const cached = this.existingChrome;
    if (cached?.endpoint === endpoint && cached.browser.isConnected()) return cached.browser;
    if (this.openingChrome) {
      const opening = await this.openingChrome;
      if (opening.endpoint === endpoint && opening.browser.isConnected()) return opening.browser;
    }
    const opening = (async () => {
      let browser: Browser;
      try { browser = await chromium.connectOverCDP(endpoint, { timeout: 120000 }); }
      catch (error) {
        const detail = error instanceof Error ? error.message : '';
        if (/403|forbidden|connection rejected/i.test(detail))
          throw new Error('Chrome rejected the debugging connection. Check Chrome for its remote-debugging Allow prompt, then retry. If no prompt appears, check chrome://inspect/#remote-debugging.');
        throw error;
      }
      const connected = { endpoint, browser };
      this.existingChrome = connected;
      browser.on('disconnected', () => { if (this.existingChrome === connected) this.existingChrome = undefined; });
      return connected;
    })();
    this.openingChrome = opening;
    try { return (await opening).browser; }
    finally { if (this.openingChrome === opening) this.openingChrome = undefined; }
  }
  static async disconnectExisting() {
    const browser = this.existingChrome?.browser;
    this.existingChrome = undefined;
    await browser?.close().catch(() => {});
  }
  private static async connectExisting(options: BrowserOptions) {
    if (options.recordVideoDir) throw new Error('Built-in video recording requires a dedicated browser. Record your screen for an existing-Chrome session.');
    if (process.platform !== 'darwin') throw new Error('Existing Chrome discovery currently supports macOS.');
    const url = new URL(options.url);
    const origins = navigationOrigins(url, options.allowedOrigins);
    let address: string;
    try { address = await readFile(resolve(homedir(), 'Library/Application Support/Google/Chrome/DevToolsActivePort'), 'utf8'); }
    catch { throw new Error('Enable remote debugging in your running Chrome at chrome://inspect/#remote-debugging, then connect again.'); }
    const [port, path] = address.trim().split(/\r?\n/);
    if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535 || !/^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(path))
      throw new Error('Chrome published an invalid local debugging endpoint.');
    // Chrome presents its own Allow dialog for a new connection. Reuse an approved
    // connection for later task tabs in this MCP process instead of asking every run.
    const browser = await this.approvedChrome(`ws://127.0.0.1:${port}${path}`);
    let page: Page | undefined;
    try {
      const context = browser.contexts()[0];
      if (!context) throw new Error('The connected Chrome did not expose a browser context.');
      page = await context.newPage();
      const driver = new BrowserDriver(context, page, origins, 'chrome', browser);
      if (origins) {
        // Scope an explicit restriction to this task's tab, never the user's whole browser context.
        await page.route('**/*', route => {
          const request = route.request();
          if (request.isNavigationRequest() && !origins.has(new URL(request.url()).origin)) return route.abort('blockedbyclient');
          return route.continue();
        });
      }
      await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 20000 });
      return driver;
    } catch (error) {
      await page?.close().catch(() => {});
      throw error;
    }
  }
  private assertOpen() {
    if (this.page.isClosed()) throw new Error('The browser tab was closed. Open a new session.');
    if (this.origins && !this.origins.has(new URL(this.page.url()).origin)) throw new Error('This page is outside the session’s explicitly allowed origins.');
  }
  async observe(): Promise<Observation> {
    this.assertOpen();
    const elements: ElementInfo[] = [];
    const texts: string[] = [];
    const revisions: unknown[] = [];
    const refs = new Map<string, Reference>();
    let truncated = false;
    let focusedId: string | undefined;
    const frames = this.page.frames();
    for (let index = 0; index < frames.length; index++) {
      const frame = frames[index];
      if (index > 0) {
        const element = await frame.frameElement().catch(() => null);
        const rect = await element?.boundingBox();
        const visible = await element?.isVisible();
        await element?.dispose();
        if (!visible || !rect || rect.width <= 0 || rect.height <= 0 || rect.y > 900 || rect.x > 1280 || rect.x + rect.width < 0 || rect.y + rect.height < 0) continue;
      }
      let snapshot: { epoch: string; text: string; elements: ElementInfo[]; truncated: boolean; scroll: number[]; focus: string[] };
      try { snapshot = await frame.evaluate(snapshotScript); }
      catch { truncated = true; continue; }
      revisions.push([index, snapshot.epoch, snapshot.scroll, snapshot.focus, snapshot.text, snapshot.elements]);
      texts.push(snapshot.text);
      truncated ||= snapshot.truncated;
      if (!focusedId && snapshot.focus[0] && snapshot.elements.some(e => e.id === snapshot.focus[0])) focusedId = `f${index}_${snapshot.focus[0]}`;
      for (const element of snapshot.elements) {
        const id = `f${index}_${element.id}`;
        refs.set(id, { frame, localId: element.id, epoch: snapshot.epoch, imageUrl: element.image?.url });
        const image = element.image ? { ...element.image, url: /^(data|blob):/.test(element.image.url) ? '[embedded image]' : element.image.url } : undefined;
        elements.push({ ...element, id, ...(image ? { image } : {}) });
      }
    }
    const url = this.page.url();
    const text = texts.join('\n').slice(0, 24000);
    const id = randomUUID();
    this.references.set(id, refs);
    while (this.references.size > 16) this.references.delete(this.references.keys().next().value!);
    return { id, revision: createHash('sha256').update(JSON.stringify([url, revisions])).digest('hex'),
      sessionId: this.id, kind: this.kind, title: await this.page.title(), url,
      text, elements, truncated: truncated || texts.join('\n').length > 24000, capturedAt: Date.now(),
      ...(focusedId ? { focusedId } : {}) };
  }
  async act(action: Action, observation: Observation, signal: AbortSignal) {
    signal.throwIfAborted();
    this.assertOpen();
    if (observation.sessionId !== this.id) throw new StaleObservationError();
    if (action.kind === 'wait') { await delay(200, undefined, { signal }); return; }
    if (action.kind === 'switch' || action.kind === 'remember') throw new Error('Use a desktop session for switching and memory.');
    // Unrelated page changes do not invalidate a decision: only the target's identity (or, for a key, the
    // observed focus) must still match. Playwright separately checks visibility, stability, and occlusion.
    const fresh = await this.observe();
    signal.throwIfAborted();
    if ('elementId' in action) {
      const before = observation.elements.find(e => e.id === action.elementId), now = fresh.elements.find(e => e.id === action.elementId);
      if (!before || !now || now.role !== before.role || now.name !== before.name) throw new StaleObservationError();
    } else if (action.kind === 'press' && observation.focusedId !== fresh.focusedId) throw new StaleObservationError();
    if (action.kind === 'scroll') {
      await this.page.mouse.move(900, 650);
      signal.throwIfAborted();
      await this.page.mouse.wheel(0, action.direction === 'down' ? 600 : -600);
    } else if (action.kind === 'press') {
      signal.throwIfAborted();
      await this.page.keyboard.press([...(action.modifiers ?? []), action.key].join('+'));
    } else {
      const target = observation.elements.find(e => e.id === action.elementId);
      const ref = this.references.get(observation.id)?.get(action.elementId);
      if (!ref || !target || target.disabled || !target.actions.includes(action.kind)) throw new Error('Action is not supported by that observed element.');
      if (action.kind === 'select' && !target.options?.some(o => o.value === action.value && !o.disabled)) throw new Error('Select value is not one of the observed options.');
      const handle = await ref.frame.evaluateHandle(({ id, epoch }) => {
        const state = (window as any).__jevLocalMcp;
        if (state?.epoch !== epoch) return null;
        const node = state.nodes.get(id);
        return node?.isConnected ? node : null;
      }, { id: ref.localId, epoch: ref.epoch });
      const element = handle.asElement() as ElementHandle<HTMLElement> | null;
      try {
        if (!element) throw new StaleObservationError();
        signal.throwIfAborted();
        // No force:true: Playwright must validate visibility, stability, and occlusion.
        if (action.kind === 'click') await element.click({ timeout: 1800, button: action.button, clickCount: action.clickCount });
        if (action.kind === 'fill') {
          await element.fill(action.value, { timeout: 1800 });
          if (action.submit) await element.press('Enter', { timeout: 1800 });
        }
        if (action.kind === 'select') await element.selectOption({ value: action.value }, { timeout: 1800 });
      } catch (error) {
        if (error instanceof StaleObservationError) throw error;
        // Playwright's detailed error can echo a filled value. Classify it without exposing raw text.
        const detail = error instanceof Error ? error.message : '';
        const [reason, guidance] = /intercepts pointer events|subtree intercepts/i.test(detail)
          ? ['another element covered the target', 'Inspect the current page for an overlay or another visible route to the goal.']
          : /not visible|outside of the viewport|not in viewport/i.test(detail)
            ? ['the target was not visible', 'Use the freshly visible controls; scrolling or waiting may reveal the target.']
            : /detached|not attached|not connected/i.test(detail)
              ? ['the target moved or disappeared', 'Reconsider the goal using the new page state.']
              : /timeout/i.test(detail)
                ? ['the target did not become actionable in time', 'The page may still be loading; inspect the new state and choose a working control.']
                : ['the page rejected the action', 'Check the current field or control state and choose another valid action.'];
        throw new RecoverableActionError(reason, guidance);
      } finally { await handle.dispose(); }
    }
    // Give DOM handlers a frame without a multi-second fixed sleep or network-idle wait.
    signal.throwIfAborted();
    await delay(40, undefined, { signal });
  }
  async screenshot() { this.assertOpen(); return this.page.screenshot({ type: 'png', timeout: 5000 }); }
  async focus() { this.assertOpen(); await this.page.bringToFront(); }
  async copyImage(elementId: string, observation: Observation) {
    this.assertOpen();
    const target = observation.elements.find(e => e.id === elementId);
    const ref = this.references.get(observation.id)?.get(elementId);
    if (observation.sessionId !== this.id || !target?.image || !ref) throw new Error('Choose an image ID from a fresh computer_inspect result.');
    const fresh = await this.observe();
    if (fresh.revision !== observation.revision) throw new StaleObservationError();
    const handle = await ref.frame.evaluateHandle(({ id, epoch, url }) => {
      const state = (window as any).__jevLocalMcp;
      const node = state?.epoch === epoch ? state.nodes.get(id) : null;
      return node?.isConnected && node.tagName === 'IMG' && (node.currentSrc || node.src) === url ? node : null;
    }, { id: ref.localId, epoch: ref.epoch, url: ref.imageUrl });
    try {
      const element = handle.asElement() as ElementHandle<HTMLElement> | null;
      if (!element) throw new StaleObservationError();
      return await element.screenshot({ type: 'png', timeout: 5000 });
    } finally { await handle.dispose(); }
  }
  async close() {
    if (!this.connectedBrowser) { await this.context.close(); return; }
    await Promise.allSettled([...this.ownedPages].map(page => page.close()));
    // The approved CDP connection is shared with later task tabs and ends on MCP shutdown.
  }
}
