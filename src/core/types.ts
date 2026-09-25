import { z } from 'zod';

export const actionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('click'), elementId: z.string(), button: z.enum(['left', 'right', 'middle']).optional(), clickCount: z.number().int().min(1).max(2).optional() }),
  z.object({ kind: z.literal('fill'), elementId: z.string(), value: z.string().max(10000), submit: z.boolean().optional() }),
  z.object({ kind: z.literal('compose'), elementId: z.string() }),
  z.object({ kind: z.literal('select'), elementId: z.string(), value: z.string().max(1000) }),
  z.object({ kind: z.literal('scroll'), direction: z.enum(['up', 'down']) }),
  z.object({ kind: z.literal('scroll_top') }),
  z.object({ kind: z.literal('scroll_bottom') }),
  z.object({ kind: z.literal('press'), key: z.enum(['Enter', 'Tab', 'Escape', 'ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Backspace', 'a', 'c', 'n', 'o', 'v', 'f', 's', 'w']), modifiers: z.array(z.enum(['Meta', 'Shift', 'Alt', 'Control'])).max(4).optional() }),
  z.object({ kind: z.literal('wait') }),
  z.object({ kind: z.literal('wait_for_load') }),
  z.object({ kind: z.literal('wait_for_change') }),
  z.object({ kind: z.literal('wait_for_images') }),
  z.object({ kind: z.literal('scan_screen') }),
  z.object({ kind: z.literal('back') }),
  z.object({ kind: z.literal('forward') }),
  z.object({ kind: z.literal('refresh') }),
  z.object({ kind: z.literal('switch'), targetId: z.string() }),
  z.object({ kind: z.literal('remember'), elementId: z.string() }),
]);
export type Action = z.infer<typeof actionSchema>;
export const conditionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('clipboard_image'), afterChangeCount: z.number().int() }),
  z.object({ kind: z.literal('text'), text: z.string().min(1).max(1000) }),
  z.object({ kind: z.literal('url'), contains: z.string().min(1).max(2000) }),
  z.object({ kind: z.literal('field'), name: z.string().min(1), value: z.string().max(10000) }),
  z.object({ kind: z.literal('element'), name: z.string().min(1), role: z.string().optional() }),
  z.object({ kind: z.literal('element_absent'), name: z.string().min(1), role: z.string().optional() }),
  z.object({ kind: z.literal('checked'), name: z.string().min(1), checked: z.boolean() }),
  z.object({ kind: z.literal('target'), targetId: z.string().min(1) }),
  z.object({ kind: z.literal('field_from_memory'), name: z.string().min(1), source: z.string().min(1) }),
]);
export type Condition = z.infer<typeof conditionSchema>;
export const taskSchema = z.object({
  sessionId: z.string(),
  goal: z.string().min(1).max(6000),
  inputs: z.record(z.string().max(100), z.string().max(10000)).default({}),
  until: z.array(conditionSchema).min(1).max(12),
  maxSteps: z.number().int().min(1).max(100).default(25),
  timeoutMs: z.number().int().min(1000).max(300000).default(60000),
  minConfidence: z.number().min(0).max(1).default(0.55),
}).refine(v => Object.keys(v.inputs).length <= 20, 'Supply at most 20 input values');
export type TaskInput = z.infer<typeof taskSchema>;
export interface ElementInfo {
  id: string;
  role: string;
  name: string;
  value?: string;
  checked?: boolean;
  focused?: boolean;
  selected?: boolean;
  context?: string;
  disabled: boolean;
  actions: Array<'click' | 'fill' | 'select'>;
  source?: 'accessibility' | 'ocr';
  confidence?: number;
  clickVariants?: Array<'right' | 'double'>;
  bounds?: { x: number; y: number; width: number; height: number };
  image?: { url: string; width: number; height: number };
  options?: Array<{ value: string; label: string; selected: boolean; disabled: boolean }>;
  multiline?: boolean;
  inputType?: string;
  required?: boolean;
  min?: string;
  max?: string;
  modal?: boolean; // Part of the open menu or dialog.
}
export interface Observation {
  id: string;
  revision: string;
  sessionId: string;
  kind: 'browser' | 'macos' | 'desktop';
  targetId?: string;
  targets?: Array<{ id: string; name: string; kind: 'browser' | 'macos' }>;
  memory?: Array<{ key: string; value: string; source: string }>;
  title: string;
  url?: string;
  text: string;
  elements: ElementInfo[];
  truncated: boolean;
  capturedAt: number;
  ocr?: { used: boolean; durationMs?: number; reason?: string };
  ocrAvailable?: boolean;
  clipboard?: { changeCount: number; hasImage: boolean };
  focusedId?: string;
  modal?: { kind: 'menu' | 'dialog'; label?: string };
  challenge?: string;
  loading?: { document: 'loading' | 'interactive' | 'complete'; pendingImages: number };
  scroll?: { x: number; y: number; canScrollUp: boolean; canScrollDown: boolean };
}
export interface Driver {
  readonly id: string;
  readonly kind: 'browser' | 'macos' | 'desktop';
  readonly label: string;
  observe(options?: { ocr?: 'auto' | 'always' | 'off' }): Promise<Observation>;
  act(action: Action, observation: Observation, signal: AbortSignal): Promise<Observation | void>;
  screenshot(): Promise<Buffer>;
  focus?(): Promise<void>;
  copyImage?(elementId: string, observation: Observation): Promise<Buffer>;
  close(): Promise<void>;
}
export class StaleObservationError extends Error {
  constructor() { super('The interface changed before execution. Observe again.'); }
}
// A UI action can fail without ending the goal. The runner re-observes and lets Jev choose again.
// Keep the message independent of Playwright's raw error, which can contain typed values.
export class RecoverableActionError extends Error {
  constructor(readonly reason: string, readonly guidance: string) { super(`Browser action failed: ${reason}.`); }
}
export class BlockedError extends Error {}
export class TextHelperUnavailableError extends Error {
  constructor(message: string, readonly modelCalls = 1, readonly status?: number, readonly retryAfterMs?: number) { super(message); }
}
// description names the whole action for logs; label names only its target for a Choice option.
export type Candidate = { action: Action | 'blocked' | 'done'; description: string; label?: string };
export type Candidates = Record<string, Candidate>;
export interface DecisionTrace {
  requestChars: number; inputTokens?: number; model?: string; attempts: number;
  recoveries?: Array<{ operation: string; elementId: string }>;
  used: Array<{ question: string; choice: string; confidence: number; top: Array<[string, number]> }>;
}
export interface Decision { choice: string; confidence: number; probability: number; latencyMs: number; modelCalls?: number; trace?: DecisionTrace }
export interface DecisionContext { conditions: Array<{ condition: string; met: boolean }>; clipboard?: { hasImage: boolean; changedSinceStart: boolean } }
export interface Decider {
  factored?: boolean;
  decide(input: TaskInput, observation: Observation, candidates: Candidates,
    history: string[], signal: AbortSignal, context?: DecisionContext): Promise<Decision>;
}
export interface TextHelper {
  availableAt?(): number;
  compose(input: TaskInput, observation: Observation, field: ElementInfo, signal: AbortSignal): Promise<{ status: 'text' | 'need_input'; text: string; modelCalls?: number }>;
  repair(input: TaskInput, observation: Observation, history: string[], signal: AbortSignal): Promise<string>;
}
const roleNames: Record<string, string> = { AXLink: 'link', AXImage: 'image', AXStaticText: 'text', AXMenuItem: 'menu item', AXMenuBarItem: 'menu bar item',
  AXPopUpButton: 'pop-up button', AXMenuButton: 'menu button', AXCell: 'cell', AXRow: 'row', AXGroup: 'group', AXList: 'list', AXSearchField: 'search field' };
export const roleName = (role: string) => roleNames[role] ?? (role.startsWith('AX') ? role.slice(2).replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase() : role);
export function describeElement(e: ElementInfo) {
  const unnamed = !e.name.trim() || e.name === e.role;
  const state = [e.focused && 'focused', e.selected && 'selected', e.checked !== undefined && (e.checked ? 'checked' : 'unchecked')].filter(Boolean);
  const value = e.value && e.value !== '[redacted]' && e.value !== e.name && e.value.length <= 120 ? ` with current value ${JSON.stringify(e.value)}` : '';
  return `${e.source === 'ocr' ? 'on-screen text' : roleName(e.role)}${unnamed ? ' (unlabeled)' : ` ${JSON.stringify(e.name.slice(0, 160))}`}${e.context ? ` in ${JSON.stringify(e.context.slice(0, 80))}` : ''}${state.length ? ` [${state.join(', ')}]` : ''}${value}`;
}

export function verify(observation: Observation, conditions: Condition[]) {
  const checks = conditions.map(condition => {
    let passed = false;
    switch (condition.kind) {
      case 'clipboard_image': passed = Boolean(observation.clipboard?.hasImage && observation.clipboard.changeCount > condition.afterChangeCount); break;
      case 'text': passed = observation.text.includes(condition.text); break;
      case 'url': passed = Boolean(observation.url?.includes(condition.contains)); break;
      case 'element': passed = observation.elements.some(e => e.name === condition.name && (!condition.role || e.role === condition.role)); break;
      case 'element_absent': passed = !observation.elements.some(e => e.name === condition.name && (!condition.role || e.role === condition.role)); break;
      case 'field': passed = observation.elements.some(e => e.name === condition.name && e.value === condition.value); break;
      case 'checked': passed = observation.elements.some(e => e.name === condition.name && e.checked === condition.checked); break;
      case 'target': passed = observation.targetId === condition.targetId; break;
      case 'field_from_memory': {
        const values = observation.memory?.filter(item => item.key === condition.source || item.source === condition.source) ?? [];
        passed = values.length === 1 && observation.elements.some(e => e.name === condition.name && e.value === values[0].value);
        break;
      }
    }
    // The initial app catalog is not an observation of a target interface.
    return { condition, passed: passed && !(observation.kind === 'desktop' && !observation.targetId) };
  });
  return { passed: checks.every(c => c.passed), checks };
}

// Keys name the operation and its observed target (click:e12, fill:e5:0), so every option refers to an
// element in the same observation Jev receives.
export function candidatesFor(observation: Observation, inputs: Record<string, string>, options: { factored?: boolean; canCompose?: boolean } = {}): Candidates {
  const candidates: Candidates = {
    blocked: { action: 'blocked', description: 'Cannot proceed with the supplied values and available controls; return to the assistant.' },
    done: { action: 'done', description: 'The requested outcome is already visible. Code will independently verify it.' },
    wait: { action: { kind: 'wait' }, description: 'Wait briefly for an interface update that is still loading.' },
    scroll_down: { action: { kind: 'scroll', direction: 'down' }, description: 'Scroll down to reveal more controls.' },
    scroll_up: { action: { kind: 'scroll', direction: 'up' }, description: 'Scroll up to reveal earlier controls.' },
    enter: { action: { kind: 'press', key: 'Enter' }, description: 'Press Enter to confirm the focused control or form.' },
    tab: { action: { kind: 'press', key: 'Tab' }, description: 'Press Tab to move to the next control.' },
    escape: { action: { kind: 'press', key: 'Escape' }, description: 'Press Escape to dismiss the active menu or dialog.' },
  };
  if (observation.kind === 'desktop' && !observation.targetId) {
    for (const key of ['scroll_down', 'scroll_up', 'enter', 'tab', 'escape', 'wait']) delete candidates[key];
  }
  if (observation.ocrAvailable && !observation.ocr?.used)
    candidates.scan_screen = { action: { kind: 'scan_screen' }, description: 'Read rendered text from a local screenshot when visible page content or controls are missing from the ordinary observation.' };
  const inBrowser = observation.kind === 'browser' || (observation.kind === 'desktop' && Boolean(observation.url));
  if (inBrowser && !observation.modal) {
    candidates.wait_for_change = { action: { kind: 'wait_for_change' }, description: 'Wait up to 3 seconds for visible content or resources to update.' };
    if (observation.loading?.pendingImages)
      candidates.wait_for_images = { action: { kind: 'wait_for_images' }, description: 'Wait up to 3 seconds for currently loading page images.' };
    if (observation.loading?.document !== 'complete')
      candidates.wait_for_load = { action: { kind: 'wait_for_load' }, description: 'Wait up to 3 seconds for the current page document to finish loading.' };
    candidates.back = { action: { kind: 'back' }, description: 'Go back to the previous page in this task tab.' };
    candidates.forward = { action: { kind: 'forward' }, description: 'Go forward to the next page in this task tab.' };
    candidates.refresh = { action: { kind: 'refresh' }, description: 'Refresh the current page and observe it again.' };
    if (observation.scroll?.canScrollUp)
      candidates.scroll_top = { action: { kind: 'scroll_top' }, description: 'Jump to the top of the current page.' };
    if (observation.scroll?.canScrollDown)
      candidates.scroll_bottom = { action: { kind: 'scroll_bottom' }, description: 'Jump to the bottom of the current page.' };
  }
  if (observation.modal) for (const key of ['scroll_down', 'scroll_up', 'enter', 'tab']) delete candidates[key];
  else if (observation.kind === 'macos' || (observation.kind === 'desktop' && observation.targetId && !observation.url)) {
    for (const [key, verb] of [['n', 'create a new item'], ['o', 'open an item'], ['f', 'find text'], ['s', 'save the current document']] as const)
      candidates[`shortcut_${key}`] = { action: { kind: 'press', key, modifiers: ['Meta'] }, description: `Press Command-${key.toUpperCase()} to ${verb} in the focused app` };
    candidates.paste = { action: { kind: 'press', key: 'v', modifiers: ['Meta'] }, description: 'Press Command-V to paste the clipboard into the focused control' };
    candidates.copy = { action: { kind: 'press', key: 'c', modifiers: ['Meta'] }, description: 'Press Command-C to copy the current selection' };
    candidates.select_all = { action: { kind: 'press', key: 'a', modifiers: ['Meta'] }, description: 'Press Command-A to select everything in the focused control' };
  }
  const add = (key: string, action: Action, description: string, label?: string) => { candidates[key] = { action, description, label }; };
  const values = Object.entries(inputs);
  for (const element of observation.elements) {
    if (element.disabled) continue;
    const label = describeElement(element);
    const target = `${label} (${element.id})`;
    if (element.actions.includes('click')) add(`click:${element.id}`, { kind: 'click', elementId: element.id }, `Click ${target}`, label);
    if (element.actions.includes('click') && element.clickVariants?.includes('right')) add(`right:${element.id}`, { kind: 'click', elementId: element.id, button: 'right' }, `Right-click ${target} to open its context menu`, label);
    if (element.actions.includes('click') && element.clickVariants?.includes('double')) add(`double:${element.id}`, { kind: 'click', elementId: element.id, clickCount: 2 }, `Double-click ${target}`, label);
    if (element.actions.includes('fill')) values.forEach(([name, value], index) => {
      if (element.value !== value) add(`fill:${element.id}:${index}`, { kind: 'fill', elementId: element.id, value }, `Fill ${target} using supplied input ${JSON.stringify(name)}`, label);
      if (!element.multiline) add(`submit:${element.id}:${index}`, { kind: 'fill', elementId: element.id, value, submit: true }, `Fill ${target} using supplied input ${JSON.stringify(name)} and press Enter`, label);
    });
    if (element.actions.includes('fill') && options.canCompose)
      add(`compose:${element.id}`, { kind: 'compose', elementId: element.id }, `Use the fast text model to write and fill ${target} for the current goal`, label);
    if (element.actions.includes('select')) (element.options ?? []).forEach((option, index) => {
      if (!option.disabled && !option.selected) add(`select:${element.id}:${index}`, { kind: 'select', elementId: element.id, value: option.value }, `Select ${JSON.stringify(option.label)} in ${target}`, `${JSON.stringify(option.label)} in ${label}`);
    });
    if (observation.kind === 'desktop' && element.value && element.value !== '[redacted]' &&
      !observation.memory?.some(item => item.value === element.value))
      add(`remember:${element.id}`, { kind: 'remember', elementId: element.id }, `Remember the exact text from ${target} for use in another app or field`, label);
  }
  for (const target of observation.targets ?? []) {
    if (target.id !== observation.targetId) add(`switch:${target.id}`, { kind: 'switch', targetId: target.id }, `Switch to ${JSON.stringify(target.name)} (${target.kind})`);
  }
  if (Object.keys(candidates).length > 255 && !options.factored) {
    throw new BlockedError('More than 255 candidate actions. Narrow the supplied inputs or use inspect and act for a specific step.');
  }
  return candidates;
}
