// This code runs in the browser. Node references stay in the page; model output
// can only name IDs from this observed table, never selectors or JavaScript.
export const snapshotScript = String.raw`(() => {
  const state = window.__jevLocalMcp ??= { nodes: new Map(), ids: new WeakMap(), next: 1, epoch: crypto.randomUUID() };
  const tidy = value => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 500);
  const visible = node => {
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
      && style.opacity !== '0' && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth
      && !node.closest('[inert],[aria-hidden="true"]');
  };
  // A control may have a normal rectangle while CSS clips or another element covers every
  // clickable point. Google search's unfocused "Skip to main content" link is one example.
  const pointerReachable = node => {
    const rect = node.getBoundingClientRect();
    const points = [[.5,.5],[.2,.2],[.8,.2],[.2,.8],[.8,.8]];
    const root = node.getRootNode();
    return points.some(([px, py]) => {
      const x = rect.left + rect.width * px, y = rect.top + rect.height * py;
      if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return false;
      const hit = root.elementFromPoint?.(x, y) || document.elementFromPoint(x, y);
      return hit === node || node.contains(hit);
    });
  };
  const roots = [document];
  const all = [];
  for (let index = 0; index < roots.length; index++) {
    for (const node of roots[index].querySelectorAll('*')) {
      if (node.shadowRoot) roots.push(node.shadowRoot);
      all.push(node);
    }
  }
  const elements = [];
  const text = [];
  let active = document.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  let count = 0;
  state.nodes.clear();
  for (const node of all) {
    if (!visible(node)) continue;
    if (/^(SCRIPT|STYLE|NOSCRIPT)$/.test(node.tagName)) continue;
    for (const child of node.childNodes) if (child.nodeType === Node.TEXT_NODE && tidy(child.textContent)) text.push(tidy(child.textContent));
    const role = node.getAttribute('role') || ({ IMG: 'img', BUTTON: 'button', A: 'link', INPUT: ['checkbox', 'radio'].includes(node.type) ? node.type : ['submit', 'button', 'reset'].includes(node.type) ? 'button' : 'textbox', TEXTAREA: 'textbox', SELECT: 'combobox', SUMMARY: 'button' }[node.tagName]) || (node.isContentEditable ? 'textbox' : '');
    const isEditable = (node.matches('input:not([type=button]):not([type=submit]):not([type=reset]):not([type=checkbox]):not([type=radio]):not([type=file]):not([type=hidden]),textarea') || node.isContentEditable) && !node.readOnly;
    const isSecret = node.type === 'password' || node.getAttribute('autocomplete') === 'one-time-code';
    const canClick = node.matches('button,a[href],summary,input[type=checkbox],input[type=radio],input[type=submit],input[type=button],input[type=reset]') || ['button','link','checkbox','radio','tab','menuitem','option','switch','combobox'].includes(role);
    if (!role && !isEditable && !canClick) continue;
    count++;
    if (elements.length >= 120) continue;
    let id = state.ids.get(node);
    if (!id) { id = 'e' + state.next++; state.ids.set(node, id); }
    state.nodes.set(id, node);
    const labelled = (node.getAttribute('aria-labelledby') || '').split(/\s+/).map(id => node.getRootNode().getElementById?.(id)?.textContent || '').join(' ');
    const labelText = Array.from(node.labels || []).map(label => { const copy = label.cloneNode(true); copy.querySelectorAll('input,select,textarea,button').forEach(child => child.remove()); return copy.textContent; }).join(' ');
    const name = tidy(node.getAttribute('aria-label') || labelled || labelText || node.getAttribute('alt') || node.getAttribute('placeholder') || node.getAttribute('title') || (node.tagName === 'INPUT' && ['submit','button'].includes(node.type) ? node.value : '') || (node.tagName === 'SELECT' ? node.getAttribute('name') : node.innerText) || node.querySelector('img[alt]')?.alt || node.getAttribute('name') || role);
    const disabled = Boolean(node.disabled || node.getAttribute('aria-disabled') === 'true');
    const actions = [];
    if (canClick && !isSecret && node.tagName !== 'SELECT' && pointerReachable(node)) actions.push('click');
    if (isEditable && !isSecret) actions.push('fill');
    if (node.tagName === 'SELECT') actions.push('select');
    const container = node.closest('fieldset,[role="dialog"],[role="row"],tr,section,form');
    const context = container && tidy(container.getAttribute('aria-label') || container.querySelector('legend,h1,h2,h3,[role="rowheader"],th')?.textContent);
    const element = { id, role: role || 'textbox', name, disabled, actions, focused: node === active,
      selected: node.getAttribute('aria-selected') === 'true', ...(context ? { context } : {}),
      bounds: (() => { const box = node.getBoundingClientRect(); return { x: box.x, y: box.y, width: box.width, height: box.height }; })(),
      ...(isEditable && (node.tagName === 'TEXTAREA' || node.isContentEditable) ? { multiline: true } : {}),
      ...(node.tagName === 'INPUT' ? { inputType: node.type } : {}),
      ...(node.required ? { required: true } : {}), ...(node.min ? { min: String(node.min) } : {}), ...(node.max ? { max: String(node.max) } : {}) };
    if (node.tagName === 'IMG' && node.complete && node.naturalWidth > 0) element.image = { url: node.currentSrc || node.src, width: node.naturalWidth, height: node.naturalHeight };
    if (isSecret) element.value = '[redacted]';
    else if ('value' in node && !['checkbox','radio','submit','button'].includes(node.type)) element.value = String(node.value).slice(0, 10000);
    else if (node.isContentEditable) element.value = node.innerText.slice(0, 10000);
    if (['checkbox','radio'].includes(node.type)) element.checked = node.checked;
    else if (node.hasAttribute('aria-checked')) element.checked = node.getAttribute('aria-checked') === 'true';
    if (node.tagName === 'SELECT') element.options = Array.from(node.options).slice(0, 100).map(o => ({ value: o.value, label: tidy(o.label), selected: o.selected, disabled: o.disabled }));
    elements.push(element);
  }
  const focus = active ? [state.ids.get(active) || '', active.tagName, active.getAttribute('role') || ''] : [];
  const scrolling = document.scrollingElement;
  return { epoch: state.epoch, title: document.title, text: text.join('\n').slice(0, 16000), elements, truncated: count > 120 || text.join('\n').length > 16000,
    loadState: document.readyState, pendingImages: all.filter(node => node.tagName === 'IMG' && !node.complete).length,
    scroll: [Math.round(scrollX), Math.round(scrollY), Math.max(0, (scrolling?.scrollHeight ?? 0) - innerHeight)], focus };
})()`;
