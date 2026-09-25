import { createHash } from 'node:crypto';
import { describeElement, type Action, type Condition, type ElementInfo, type Observation } from './types.js';

const words = (text: string) => new Set(text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []);
const norm = (text: string) => text.replace(/\s+/g, ' ').trim().toLowerCase();
const center = (b: NonNullable<ElementInfo['bounds']>) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
const inside = (a?: ElementInfo['bounds'], b?: ElementInfo['bounds']) => {
  if (!a || !b) return false;
  const c = center(a);
  return c.x >= b.x && c.x <= b.x + b.width && c.y >= b.y && c.y <= b.y + b.height;
};

// One visible thing often appears as a button, its image, and its link with the same name. Offering all
// three splits Jev's probability mass, so nested or adjacent same-named controls become one target. The
// target kept is one whose own actions cover the other's, because drivers accept only an element's own actions;
// pointer variants (right-click, double-click) land at the same place and carry over.
export function mergeDuplicates(elements: ElementInfo[]) {
  const kept: ElementInfo[] = [];
  const covers = (a: ElementInfo, b: ElementInfo) => b.actions.every(action => a.actions.includes(action));
  for (const element of elements) {
    const name = norm(element.name);
    const previous = kept.at(-1);
    const index = name && name !== norm(element.role) && !element.actions.includes('fill') ? kept.findIndex(k => norm(k.name) === name &&
      k.source === element.source && !k.actions.includes('fill') && (covers(k, element) || covers(element, k)) &&
      (inside(element.bounds, k.bounds) || inside(k.bounds, element.bounds) || (!element.bounds && !k.bounds && k === previous))) : -1;
    if (index < 0) { kept.push({ ...element }); continue; }
    const twin = kept[index];
    const merged: ElementInfo = { ...(covers(twin, element) ? twin : element) };
    const variants = [...new Set([...(twin.clickVariants ?? []), ...(element.clickVariants ?? [])])];
    if (variants.length && merged.actions.includes('click')) merged.clickVariants = variants;
    merged.image ??= twin.image ?? element.image;
    merged.focused = twin.focused || element.focused;
    kept[index] = merged;
  }
  return kept;
}

// Jev's accuracy falls as unrelated state grows. Show the open menu or dialog alone when there is one;
// otherwise keep reading order but drop the least relevant controls first.
export function focusView(observation: Observation, hint: string, limit = 120): Observation {
  const layer = observation.modal ? observation.elements.filter(e => e.modal) : observation.elements;
  let elements = mergeDuplicates(layer);
  const merged = elements.length;
  if (elements.length > limit) {
    const goal = words(hint);
    const score = (e: ElementInfo) => (e.focused || e.id.startsWith('read:') ? 8 : 0) - (e.disabled ? 3 : 0) + (e.actions.length ? 2 : -2) + (e.actions.includes('fill') ? 1 : 0) +
      2 * Math.min(3, [...words(`${e.name} ${e.context ?? ''}`)].filter(w => goal.has(w)).length);
    elements = elements.map((e, index) => ({ e, index, s: score(e) })).sort((a, b) => b.s - a.s || a.index - b.index)
      .slice(0, limit).sort((a, b) => a.index - b.index).map(r => r.e);
  }
  return { ...observation, elements, truncated: observation.truncated || elements.length < merged };
}

export function describeCondition(condition: Condition, targets: Observation['targets'] = []) {
  switch (condition.kind) {
    case 'clipboard_image': return 'A new image has been copied to the clipboard since the task started.';
    case 'text': return `The interface shows the text ${JSON.stringify(condition.text)}.`;
    case 'url': return `The page address contains ${JSON.stringify(condition.contains)}.`;
    case 'field': return `The field ${JSON.stringify(condition.name)} contains ${JSON.stringify(condition.value)}.`;
    case 'element': return `A control named ${JSON.stringify(condition.name)}${condition.role ? ` (${condition.role})` : ''} is visible.`;
    case 'element_absent': return `No control named ${JSON.stringify(condition.name)} is visible.`;
    case 'checked': return `${JSON.stringify(condition.name)} is ${condition.checked ? 'checked' : 'unchecked'}.`;
    case 'target': return `The active app is ${JSON.stringify(targets.find(t => t.id === condition.targetId)?.name ?? condition.targetId)}.`;
    case 'field_from_memory': return `The field ${JSON.stringify(condition.name)} contains the value remembered from ${JSON.stringify(condition.source)}.`;
  }
}

// Progress ignores incidental churn (animations, timestamps, geometry): only navigation, the open layer,
// focus, form state, and the clipboard count as the task's state.
export function progressDigest(o: Observation) {
  const state = o.elements.filter(e => e.actions.includes('fill') || e.checked !== undefined || e.selected).map(e => [e.id, e.value, e.checked, e.selected]);
  return createHash('sha256').update(JSON.stringify([o.targetId, o.url, o.title, o.modal, o.focusedId, o.clipboard?.changeCount,
    o.loading?.document, o.loading?.pendingImages, o.scroll?.y, state])).digest('hex').slice(0, 16);
}

const shortUrl = (url: string) => { try { const u = new URL(url); return `${u.host}${u.pathname}`.slice(0, 100); } catch { return url.slice(0, 100); } };
export function describeEffect(before: Observation, after: Observation, action: Action) {
  const notes: string[] = [];
  if (before.targetId !== after.targetId) notes.push(`now in ${after.targetId ?? 'no app'}`);
  if (after.url && before.url !== after.url) notes.push(`the address changed to ${shortUrl(after.url)}`);
  else if (before.title !== after.title) notes.push(`the window title changed to ${JSON.stringify(after.title.slice(0, 80))}`);
  if (!before.modal && after.modal) notes.push(after.modal.kind === 'menu' ? `a menu opened with ${after.elements.filter(e => e.modal).length} items` : `a dialog opened${after.modal.label ? ` (${JSON.stringify(after.modal.label)})` : ''}`);
  else if (before.modal && !after.modal) notes.push(`the ${before.modal.kind} closed`);
  const id = 'elementId' in action ? action.elementId : undefined;
  const prior = id ? before.elements.find(e => e.id === id) : undefined;
  const now = id ? after.elements.find(e => e.id === id) : undefined;
  if (action.kind === 'fill' && !(action.submit && notes.length)) notes.push(!now ? 'the field is no longer visible' : now.value === action.value ? 'the field holds the value' : `the field holds ${JSON.stringify((now.value ?? '').slice(0, 60))}`);
  else if (prior && now && prior.checked !== now.checked) notes.push(`it is now ${now.checked ? 'checked' : 'unchecked'}`);
  else if (prior && now && prior.value !== now.value && now.value !== undefined) notes.push(`its value is now ${JSON.stringify(now.value.slice(0, 60))}`);
  if (after.focusedId && before.focusedId !== after.focusedId) {
    const focused = after.elements.find(e => e.id === after.focusedId);
    if (focused) notes.push(`focus moved to ${describeElement(focused)}`);
  }
  const copying = action.kind === 'press' && action.key === 'c' && action.modifiers?.includes('Meta');
  if (before.clipboard && after.clipboard && before.clipboard.changeCount !== after.clipboard.changeCount) notes.push(after.clipboard.hasImage ? 'an image was copied to the clipboard' : 'the clipboard changed');
  else if (copying) notes.push('the clipboard did not change');
  if (before.loading?.document !== after.loading?.document && after.loading) notes.push(`the document is ${after.loading.document}`);
  if (before.loading && after.loading && before.loading.pendingImages !== after.loading.pendingImages)
    notes.push(`${after.loading.pendingImages} images are still loading`);
  if (before.scroll && after.scroll && before.scroll.y !== after.scroll.y)
    notes.push(`scrolled to page position ${after.scroll.y}`);
  if (!notes.length) {
    const was = new Set(before.elements.map(e => e.id)), is = new Set(after.elements.map(e => e.id));
    const added = [...is].filter(k => !was.has(k)).length, removed = [...was].filter(k => !is.has(k)).length;
    if (added || removed) notes.push(`${added} controls appeared and ${removed} disappeared`);
    else if (before.text !== after.text) notes.push('some text changed');
  }
  return notes.length ? notes.join('; ') : 'no visible effect';
}
