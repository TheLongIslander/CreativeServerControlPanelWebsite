const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'textEffects.js'), 'utf8');

function events() {
  const listeners = new Map();
  return {
    addEventListener(type, callback) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(callback);
    },
    emit(type, event = {}) { for (const callback of listeners.get(type) || []) callback(event); },
    count(type) { return (listeners.get(type) || []).length; }
  };
}

function element(tag = 'span') {
  return {
    tag, nodeType: 1, parentElement: null, children: [], dataset: {}, attributes: {}, className: '',
    excluded: tag === 'button', display: 'inline', hidden: false,
    style: { setProperty(name, value) { this[name] = value; } },
    get isConnected() { return this.tag === 'body' || !!this.parentElement?.isConnected; },
    get textContent() { return this.children.map(node => node.textContent).join(''); },
    contains(node) { return this === node || this.children.some(child => child === node || child.contains?.(node)); },
    closest() { return this.excluded ? this : this.parentElement?.closest() || null; },
    setAttribute(name, value) { this.attributes[name] = value; },
    appendChild(node) {
      if (node.parentElement) node.parentElement.children.splice(node.parentElement.children.indexOf(node), 1);
      this.children.push(node);
      node.parentElement = this;
      return node;
    },
    insertBefore(node, reference) {
      this.children.splice(this.children.indexOf(reference), 0, node);
      node.parentElement = this;
    },
    remove() {
      this.parentElement?.children.splice(this.parentElement.children.indexOf(this), 1);
      this.parentElement = null;
    },
    getBoundingClientRect() { return this.rect || { left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 }; }
  };
}

function harness({ theme = 'glass', fine = true, reduced = false, support = true } = {}) {
  const body = element('body');
  body.dataset.uiTheme = theme;
  const document = {
    ...events(), body, hidden: false, documentElement: {},
    createElement: element,
    createRange() {
      return {
        setStart(node, start) { this.node = node; this.start = start; },
        setEnd(node, end) { this.node = node; this.end = end; },
        getBoundingClientRect() {
          const left = 20 + this.start * 10;
          const right = 20 + this.end * 10;
          return { left, right, top: 40, bottom: 60, width: right - left, height: 20 };
        }
      };
    },
    caretPositionFromPoint: () => ({ offsetNode: document.source, offset: document.offset || 1 }),
    elementFromPoint: () => document.hit,
    createTreeWalker: () => ({ nextNode: () => null })
  };
  const fineQuery = { ...events(), matches: fine };
  const reducedQuery = { ...events(), matches: reduced };
  const highlights = new Map();
  const callbacks = new Map();
  const observers = [];
  let nextFrame = 1;
  const selection = { isCollapsed: true };
  const window = {
    ...events(), document, CSS: support ? { highlights } : {}, Intl,
    Highlight: class { constructor(...ranges) { this.ranges = ranges; } },
    innerWidth: 800, innerHeight: 600,
    matchMedia: query => query.includes('prefers-reduced-motion') ? reducedQuery : fineQuery,
    requestAnimationFrame(callback) { const id = nextFrame++; callbacks.set(id, callback); return id; },
    cancelAnimationFrame(id) { callbacks.delete(id); },
    getSelection: () => selection,
    getComputedStyle: node => ({
      display: node.display, visibility: node.hidden ? 'hidden' : 'visible', fontSize: '16px',
      direction: 'ltr', textTransform: 'none', transform: node.transform || 'none',
      opacity: 1, overflowX: node.overflowX || 'visible', overflowY: 'visible', color: 'white'
    })
  };
  vm.runInNewContext(source, {
    window, document, performance: { now: () => 0 },
    MutationObserver: class {
      constructor(callback) { this.callback = callback; observers.push(this); }
      observe() { this.enabled = true; }
      disconnect() { this.enabled = false; }
    }
  });
  window.TextEffects.init();
  return {
    window, document, body, fineQuery, reducedQuery, highlights, selection,
    text(value, tag = 'span') {
      const parent = element(tag);
      const node = {
        nodeType: 3, data: value, parentElement: null,
        get textContent() { return this.data; },
        get isConnected() { return !!this.parentElement?.isConnected; }
      };
      parent.appendChild(node);
      body.appendChild(parent);
      return { node, parent };
    },
    move(node, overrides = {}) {
      document.source = node;
      document.hit = node.parentElement;
      document.emit('pointermove', { pointerType: 'mouse', buttons: 0, clientX: 35, clientY: 50, ...overrides });
      this.frame();
    },
    frame() {
      const current = [...callbacks.values()];
      callbacks.clear();
      current.forEach(callback => callback());
    },
    mutation(target) {
      for (const observer of observers) if (observer.enabled) observer.callback([{ target }]);
      this.frame();
    },
    overlay() { return body.children.find(node => node.className === 'glass-text-effects-overlay'); }
  };
}

test('text lighting preserves original accessible text and nodes with bounded decorative graphemes', () => {
  const h = harness();
  const { node, parent } = h.text('Creative 👩‍💻 Café');
  const original = h.body.textContent;
  h.move(node);
  const overlay = h.overlay();
  assert.ok(overlay);
  assert.equal(overlay.attributes['aria-hidden'], 'true');
  assert.equal(overlay.textContent, '', 'generated decorations never duplicate document text');
  assert.equal(h.body.textContent, original);
  assert.equal(parent.children[0], node, 'normal source Text nodes remain untouched');
  assert.ok(overlay.children.length <= 16);
  assert.ok(overlay.children.some(glyph => glyph.dataset.text === '👩‍💻'), 'ZWJ emoji remains a grapheme');
  assert.ok(overlay.children.some(glyph => glyph.dataset.text === 'é'), 'combining accent stays with its letter');
  assert.ok(h.highlights.get('glass-text-effects-active').ranges.length);
  const expanded = overlay.children.filter(glyph => !glyph.hidden).map(glyph => Number(glyph.style['--text-scale']));
  assert.ok(expanded.some(scale => scale > 1));
  assert.ok(expanded.every(scale => scale <= 1.07));
  h.window.TextEffects.init();
  assert.equal(h.document.count('pointermove'), 1, 'init is idempotent');
});

test('direct flex text receives only one wrapper while keeping the source Text node', () => {
  const h = harness();
  const { node, parent } = h.text('Stopped');
  parent.display = 'inline-flex';
  h.move(node);
  const wrapper = node.parentElement;
  assert.equal(wrapper.className, 'glass-text-effects-source');
  assert.equal(parent.children[0], wrapper);
  assert.equal(wrapper.children[0], node);
  assert.equal(parent.textContent, 'Stopped');
  h.move(node);
  assert.equal(node.parentElement, wrapper);
});

test('Glassy, fine-pointer and reduced-motion gates leave other modes and buttons untouched', () => {
  for (const options of [{ theme: 'flat' }, { fine: false }, { reduced: true }, { support: false }]) {
    const h = harness(options);
    const { node } = h.text('Creative');
    h.move(node);
    assert.equal(h.overlay(), undefined);
    assert.equal(h.highlights.size, 0);
  }
  for (const overrides of [{ pointerType: 'touch' }, { pointerType: 'pen' }, { buttons: 1 }]) {
    const h = harness();
    const { node } = h.text('Creative');
    h.move(node, overrides);
    assert.equal(h.overlay(), undefined);
  }
  const h = harness();
  const { node, parent } = h.text('Manage account', 'button');
  h.move(node);
  assert.equal(h.overlay(), undefined);
  assert.equal(parent.children[0], node);
  const cursive = h.text('مرحبا');
  h.move(cursive.node);
  assert.equal(h.overlay(), undefined, 'contextual shaping uses its static finish');
});

test('selection, scrolling, theme changes and source removal clear overlays and highlights together', () => {
  const exits = [
    h => h.document.emit('pointerdown'),
    h => h.document.emit('scroll'),
    h => h.document.emit('ui-pointer-lighting-reset'),
    h => h.window.emit('blur'),
    h => h.window.emit('resize'),
    h => { h.selection.isCollapsed = false; h.document.emit('selectionchange'); },
    h => { h.fineQuery.matches = false; h.fineQuery.emit('change'); },
    h => { h.reducedQuery.matches = true; h.reducedQuery.emit('change'); },
    h => { h.body.dataset.uiTheme = 'flat'; h.mutation(h.body); },
    (h, node) => { node.parentElement.remove(); h.mutation(h.body); },
    (h, node) => { node.data = 'Changed status'; h.mutation(node); },
    (h, node) => { node.parentElement.hidden = true; h.mutation(node.parentElement); }
  ];
  for (const exit of exits) {
    const h = harness();
    const { node } = h.text('Creative');
    h.move(node);
    assert.ok(h.overlay());
    exit(h, node);
    assert.equal(h.overlay(), undefined);
    assert.equal(h.highlights.size, 0);
  }
});

test('occluded and clipped glyphs retain their original rendering instead of escaping their container', () => {
  const h = harness();
  const { node, parent } = h.text('Creative');
  h.move(node);
  h.document.hit = element('dialog');
  h.frame();
  assert.equal(h.overlay(), undefined, 'occluding dialog resets visible decorations');
  parent.overflowX = 'hidden';
  parent.rect = { left: 0, top: 0, right: 32, bottom: 100, width: 32, height: 100 };
  h.move(node);
  const ranges = h.highlights.get('glass-text-effects-active').ranges;
  assert.ok(ranges.every(range => range.getBoundingClientRect().right <= 32));
  assert.equal(h.body.textContent, 'Creative');
});
