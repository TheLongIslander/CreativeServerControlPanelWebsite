const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'appearance.js'), 'utf8');
const neutral = {
  '--mx': '50%', '--my': '20%', '--pop': '0', '--tx': '0px', '--ty': '0px',
  '--sx': '0px', '--sy': '0px', '--skx': '0deg', '--sky': '0deg', '--scale': '1'
};

function events() {
  const listeners = new Map();
  return {
    addEventListener(type, callback) {
      const callbacks = listeners.get(type) || [];
      callbacks.push(callback);
      listeners.set(type, callbacks);
    },
    emit(type, event = {}) {
      for (const callback of listeners.get(type) || []) callback(event);
    }
  };
}

function target(profile) {
  const classes = new Set();
  const properties = new Map();
  const node = {
    dataset: profile ? { pointerProfile: profile } : {},
    isConnected: true,
    disabled: false,
    hiddenAncestor: false,
    ariaHiddenAncestor: null,
    visibility: 'visible',
    fontSize: '40px',
    children: [],
    rect: { left: 20, top: 40, width: 200, height: 100 },
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name)
    },
    style: {
      setProperty: (name, value) => properties.set(name, value),
      getPropertyValue: (name) => properties.get(name) || ''
    },
    setAttribute(name, value) {
      if (name === 'data-ui-theme') this.dataset.uiTheme = value;
    },
    removeAttribute() {},
    matches: () => node.disabled,
    closest(selector) {
      if (selector === '[aria-hidden="true"]') return node.ariaHiddenAncestor;
      return selector.startsWith('[data-no-pointer-lighting]')
        ? (node.hiddenAncestor ? node : null)
        : node;
    },
    querySelectorAll: (selector) => node.children.flatMap((child) => [
      ...(child.dataset.pointerSensor && selector.includes(`[data-pointer-sensor="${child.dataset.pointerSensor}"]`) ? [child] : []),
      ...child.querySelectorAll(selector)
    ]),
    querySelector: () => node.children.find((child) => child.dataset.pointerVisual !== undefined) || null,
    contains: (child) => node === child || node.children.some((entry) => entry.contains(child)),
    getClientRects: () => node.isConnected && !node.hiddenAncestor ? [node.rect] : [],
    getBoundingClientRect: () => node.rect
  };
  return node;
}

function nestedSurface(parent, rect = { left: 60, top: 90, width: 80, height: 40 }) {
  const sensor = target();
  const visual = target();
  sensor.dataset.pointerSensor = 'surface';
  sensor.rect = rect;
  visual.dataset.pointerVisual = '';
  sensor.children.push(visual);
  parent.children.push(sensor);
  return { sensor, visual };
}

function harness({ theme = 'glass', fine = true, reduced = false, controlPanel = false } = {}) {
  const body = target();
  if (controlPanel) body.classList.add('control-panel');
  const document = {
    ...events(), body, hidden: false,
    getElementById: (id) => id === 'theme-stylesheet'
      ? { getAttribute: () => '', setAttribute() {} } : null,
    querySelectorAll: () => [],
    elementFromPoint: () => document.hit
  };
  const fineQuery = { ...events(), matches: fine };
  const reducedQuery = { ...events(), matches: reduced };
  const window = {
    ...events(), document,
    matchMedia: (query) => query.includes('prefers-reduced-motion') ? reducedQuery : fineQuery,
    getComputedStyle: (node) => ({ visibility: node.visibility, fontSize: node.fontSize })
  };
  let notifyMutation = () => {};
  vm.runInNewContext(source, {
    window, document,
    MutationObserver: class {
      constructor(callback) { notifyMutation = callback; }
      observe() {}
    }
  });
  window.Appearance.init({ user: { uiTheme: theme } });
  return {
    document, window, body, fineQuery, reducedQuery,
    move(node, overrides = {}) {
      document.hit = node;
      document.emit('pointermove', { pointerType: 'mouse', buttons: 0, clientX: 120, clientY: 90, ...overrides });
    },
    mutation(records = []) { notifyMutation(records); }
  };
}

function assertReset(node) {
  assert.equal(node.classList.contains('is-lit'), false);
  for (const [name, value] of Object.entries(neutral)) {
    assert.equal(node.style.getPropertyValue(name), value, name);
  }
}

test('shared lighting gives anchored and surface cards restrained depth while preserving button feedback', () => {
  const h = harness();
  const button = target();
  const anchored = target('anchored');
  const surface = target('surface');
  h.move(button);
  assert.equal(button.style.getPropertyValue('--pop'), '1.000');
  assert.equal(button.style.getPropertyValue('--scale'), '1.030');
  h.move(anchored, { clientX: 170 });
  assertReset(button);
  assert.equal(anchored.classList.contains('is-lit'), true);
  assert.equal(anchored.style.getPropertyValue('--pop'), '0.390');
  assert.equal(anchored.style.getPropertyValue('--tx'), '0.68px');
  assert.equal(anchored.style.getPropertyValue('--sx'), '-1.56px');
  assert.equal(anchored.style.getPropertyValue('--sky'), '-0.13deg');
  assert.equal(anchored.style.getPropertyValue('transform'), '', 'the anchor never receives a transform');
  h.move(surface);
  assertReset(anchored);
  assert.equal(surface.style.getPropertyValue('--pop'), '0.720');
  assert.equal(surface.style.getPropertyValue('--scale'), '1.006');
});

function letterHeading() {
  const heading = target('surface');
  heading.rect = { left: 20, top: 40, width: 240, height: 48 };
  const wrapper = target();
  heading.children.push(wrapper);
  const letters = [50, 80, 170].map((left) => {
    const pair = nestedSurface(wrapper, { left, top: 40, width: 20, height: 48 });
    pair.sensor.dataset.pointerSensor = 'letter';
    pair.sensor.ariaHiddenAncestor = wrapper;
    pair.visual.ariaHiddenAncestor = wrapper;
    pair.visual.getBoundingClientRect = () => assert.fail('moving glyphs must not determine their hover region');
    return pair;
  });
  return { heading, wrapper, letters };
}

test('heading glyphs expand independently with a smooth proximity glow through their decorative wrapper', () => {
  const h = harness();
  const { heading, letters: [first, next, distant] } = letterHeading();
  h.move(heading, { clientX: 60, clientY: 64 });
  assert.equal(first.visual.classList.contains('is-lit'), true);
  assert.equal(first.visual.style.getPropertyValue('--pop'), '1.000');
  assert.equal(first.visual.style.getPropertyValue('--scale'), '1.070');
  assert.equal(next.visual.classList.contains('is-lit'), true, 'neighbor responds outside its glyph hitbox');
  assert.equal(next.visual.style.getPropertyValue('--pop'), '0.156');
  assert.equal(next.visual.style.getPropertyValue('--scale'), '1.011');
  assert.equal(distant.visual.classList.contains('is-lit'), false);
  assert.equal(first.sensor.style.getPropertyValue('--scale'), '', 'glyph sensor never moves');
  assert.equal(heading.style.getPropertyValue('transform'), '', 'heading layout remains stationary');
  h.mutation([{ target: heading, type: 'childList' }]);
  assert.equal(first.visual.classList.contains('is-lit'), true, 'decorative wrapper is not mistaken for a closed pane');

  h.move(heading, { clientX: 80, clientY: 64 });
  assert.equal(first.visual.style.getPropertyValue('--pop'), '0.500');
  assert.equal(first.visual.style.getPropertyValue('--tx'), '0.75px');
  assert.equal(first.visual.style.getPropertyValue('--sx'), '-1.00px');
  assert.equal(first.visual.style.getPropertyValue('--sky'), '-0.25deg');
  h.move(heading, { clientX: 99, clientY: 64 });
  assert.equal(first.visual.style.getPropertyValue('--pop'), '0.002', 'falloff approaches zero without a minimum brightness');
  assert.equal(first.visual.style.getPropertyValue('--scale'), '1.000');
  h.move(heading, { clientX: 100, clientY: 64 });
  assertReset(first.visual);
  assert.equal(next.visual.classList.contains('is-lit'), true);
});

test('glyph effects respect availability and cannot illuminate arbitrary aria-hidden surfaces', () => {
  const h = harness();
  const { heading, wrapper, letters: [first] } = letterHeading();
  first.sensor.dataset.pointerSensor = 'surface';
  h.move(heading, { clientX: 60, clientY: 64 });
  assert.equal(first.visual.classList.contains('is-lit'), false, 'decorative exception is limited to glyphs');
  first.sensor.dataset.pointerSensor = 'letter';
  h.move(heading, { clientX: 60, clientY: 64 });
  assert.equal(first.visual.classList.contains('is-lit'), true);
  const inaccessiblePane = target();
  wrapper.ariaHiddenAncestor = inaccessiblePane;
  heading.ariaHiddenAncestor = inaccessiblePane;
  h.mutation([{ target: inaccessiblePane, attributeName: 'aria-hidden' }]);
  assertReset(first.visual);
  assertReset(heading);

  for (const invalidate of [
    ({ heading }) => { heading.hiddenAncestor = true; },
    ({ sensor }) => { sensor.hiddenAncestor = true; },
    ({ visual }) => { visual.hiddenAncestor = true; },
    ({ visual }) => { visual.visibility = 'hidden'; },
    ({ sensor }) => { sensor.disabled = true; },
    ({ visual }) => { visual.isConnected = false; },
    ({ heading }) => { heading.children.length = 0; }
  ]) {
    const check = harness();
    const { heading, letters: [{ sensor, visual }] } = letterHeading();
    check.move(heading, { clientX: 60, clientY: 64 });
    invalidate({ heading, sensor, visual });
    check.mutation([{ target: sensor }]);
    assertReset(visual);
  }
});

test('glyphs remain still in Classic, reduced motion, coarse/touch input and during text selection', () => {
  for (const options of [{ theme: 'flat' }, { fine: false }, { reduced: true }]) {
    const h = harness(options);
    const { heading, letters: [{ visual }] } = letterHeading();
    h.move(heading, { clientX: 60, clientY: 64 });
    assert.equal(visual.classList.contains('is-lit'), false);
    assert.equal(visual.style.getPropertyValue('--scale'), '');
  }
  for (const exit of [
    (h, heading) => h.move(heading, { clientX: 60, clientY: 64, buttons: 1 }),
    (h, heading) => h.move(heading, { clientX: 60, clientY: 64, pointerType: 'touch' }),
    (h, heading) => h.move(heading, { clientX: 60, clientY: 64, pointerType: 'pen' }),
    (h) => h.document.emit('scroll'),
    (h) => h.window.emit('blur'),
    (h) => h.document.emit('pointerleave'),
    (h) => h.document.emit('ui-pointer-lighting-reset'),
    (h) => { h.reducedQuery.matches = true; h.reducedQuery.emit('change'); },
    (h) => { h.fineQuery.matches = false; h.fineQuery.emit('change'); },
    (h) => { h.document.hidden = true; h.document.emit('visibilitychange'); },
    (h) => {
      h.body.dataset.uiTheme = 'flat';
      h.mutation([{ target: h.body, attributeName: 'data-ui-theme' }]);
    }
  ]) {
    const h = harness();
    const { heading, letters: [{ visual }] } = letterHeading();
    h.move(heading, { clientX: 60, clientY: 64 });
    exit(h, heading);
    assertReset(visual);
    assertReset(heading);
  }
});

test('Classic, coarse pointers, reduced motion, touch, pen and disabled controls receive no lighting', () => {
  for (const options of [{ theme: 'flat' }, { fine: false }, { reduced: true }]) {
    const h = harness(options);
    const card = target('anchored');
    h.move(card);
    assert.equal(card.classList.contains('is-lit'), false);
    assert.equal(card.style.getPropertyValue('--pop'), '');
  }
  const h = harness();
  for (const pointerType of ['touch', 'pen']) {
    const card = target('anchored');
    h.move(card, { pointerType });
    assert.equal(card.classList.contains('is-lit'), false);
  }
  const disabled = target();
  disabled.disabled = true;
  h.move(disabled);
  assert.equal(disabled.classList.contains('is-lit'), false);
});

test('all context exit paths restore every pointer variable', () => {
  const triggers = [
    (h) => h.document.emit('scroll'),
    (h) => h.window.emit('blur'),
    (h) => h.window.emit('pagehide'),
    (h) => h.document.emit('pointerleave'),
    (h) => h.document.emit('pointercancel'),
    (h) => h.document.emit('ui-pointer-lighting-reset'),
    (h) => { h.document.hidden = true; h.document.emit('visibilitychange'); },
    (h) => { h.fineQuery.matches = false; h.fineQuery.emit('change'); },
    (h) => { h.reducedQuery.matches = true; h.reducedQuery.emit('change'); },
    (h) => {
      h.body.dataset.uiTheme = 'flat';
      h.mutation([{ target: h.body, attributeName: 'data-ui-theme' }]);
    }
  ];
  for (const trigger of triggers) {
    const h = harness();
    const card = target('anchored');
    const { visual } = nestedSurface(card);
    h.move(card, { clientX: 100, clientY: 110 });
    assert.equal(visual.classList.contains('is-lit'), true);
    trigger(h);
    assertReset(card);
    assertReset(visual);
  }
});

test('live content updates preserve lighting while pane closure, disable and removal reset it', () => {
  for (const invalidate of [
    (card) => { card.hiddenAncestor = true; },
    (card) => { card.visibility = 'hidden'; },
    (card) => { card.disabled = true; },
    (card) => { card.isConnected = false; }
  ]) {
    const h = harness();
    const card = target('anchored');
    h.move(card);
    h.mutation([{ target: card, type: 'childList' }]);
    assert.equal(card.classList.contains('is-lit'), true);
    invalidate(card);
    h.mutation([{ target: card }]);
    assertReset(card);
  }
});

test('dragging input shells or surfaces cancels motion, and the control panel retains its own engine', () => {
  for (const profile of ['surface', 'input-shell']) {
    const h = harness();
    const card = target(profile);
    h.move(card);
    h.move(card, { buttons: 1 });
    assertReset(card);
  }
  const h = harness({ controlPanel: true });
  const button = target();
  h.move(button);
  assert.equal(button.classList.contains('is-lit'), false);
});

test('nested surfaces have independent local feedback without taking lighting from their parent', () => {
  const h = harness();
  const card = target('anchored');
  const { sensor, visual } = nestedSurface(card);
  const other = nestedSurface(card, { left: 150, top: 90, width: 50, height: 30 });

  h.move(card, { clientX: 100, clientY: 110 });
  assert.equal(card.classList.contains('is-lit'), true);
  assert.equal(visual.classList.contains('is-lit'), true);
  assert.equal(visual.style.getPropertyValue('--mx'), '40px');
  assert.equal(visual.style.getPropertyValue('--my'), '20px');
  assert.equal(visual.style.getPropertyValue('--pop'), '0.720');
  assert.equal(visual.style.getPropertyValue('--tx'), '0.00px');
  assert.notEqual(card.style.getPropertyValue('--tx'), visual.style.getPropertyValue('--tx'));
  assert.equal(other.visual.classList.contains('is-lit'), false);
  assert.equal(other.visual.style.getPropertyValue('--pop'), '');
  assert.equal(sensor.style.getPropertyValue('--tx'), '', 'the sensor stays still');
  h.mutation([{ target: card, type: 'childList' }]);
  assert.equal(visual.classList.contains('is-lit'), true, 'live updates preserve both layers');

  h.move(card, { clientX: 45, clientY: 70 });
  assertReset(visual);
  assert.equal(card.classList.contains('is-lit'), true, 'leaving the mini tile preserves parent feedback');
  h.move(card, { clientX: 100, clientY: 110 });
  h.move(card, { clientX: 100, clientY: 110, buttons: 1 });
  assertReset(visual);
  assert.equal(card.classList.contains('is-lit'), true, 'pressing only cancels the nested surface');
  h.move(card, { clientX: 100, clientY: 110 });
  h.move(null);
  assertReset(visual);
  assertReset(card);
});

test('nested lighting measures its stable sensor and converts parent scale into local coordinates', () => {
  const h = harness();
  const card = target('anchored');
  const { sensor, visual } = nestedSurface(card, { left: 60, top: 70, width: 120, height: 60 });
  sensor.clientWidth = 80;
  sensor.clientHeight = 40;
  visual.getBoundingClientRect = () => assert.fail('the moving visual must never be measured');
  h.move(card, { clientX: 150, clientY: 85 });
  assert.equal(visual.style.getPropertyValue('--mx'), '60px');
  assert.equal(visual.style.getPropertyValue('--my'), '10px');
  assert.equal(visual.style.getPropertyValue('--tx'), '0.37px');
  assert.equal(visual.style.getPropertyValue('--ty'), '-0.37px');
  assert.equal(visual.style.getPropertyValue('--skx'), '-0.07deg');
  assert.equal(visual.style.getPropertyValue('--scale'), '1.002');
  assert.equal(sensor.classList.contains('is-lit'), false);
});

test('nested surfaces stay idle in unavailable contexts and reset independently when removed or hidden', () => {
  for (const options of [{ theme: 'flat' }, { fine: false }, { reduced: true }]) {
    const h = harness(options);
    const card = target('anchored');
    const { visual } = nestedSurface(card);
    h.move(card, { clientX: 100, clientY: 110 });
    assert.equal(visual.classList.contains('is-lit'), false);
    assert.equal(visual.style.getPropertyValue('--pop'), '');
  }
  for (const invalidate of [
    ({ sensor }) => { sensor.hiddenAncestor = true; },
    ({ sensor }) => { sensor.visibility = 'hidden'; },
    ({ sensor }) => { sensor.disabled = true; },
    ({ sensor }) => { sensor.isConnected = false; },
    ({ visual }) => { visual.hiddenAncestor = true; },
    ({ visual }) => { visual.visibility = 'hidden'; },
    ({ visual }) => { visual.disabled = true; },
    ({ visual }) => { visual.isConnected = false; },
    ({ sensor }) => { sensor.children.length = 0; },
    ({ card }) => { card.children.length = 0; }
  ]) {
    const h = harness();
    const card = target('anchored');
    const { sensor, visual } = nestedSurface(card);
    h.move(card, { clientX: 100, clientY: 110 });
    invalidate({ card, sensor, visual });
    h.mutation([{ target: sensor }]);
    assertReset(visual);
    assert.equal(card.classList.contains('is-lit'), true);
  }
  for (const pointerType of ['touch', 'pen']) {
    const h = harness();
    const card = target('anchored');
    const { visual } = nestedSurface(card);
    h.move(card, { clientX: 100, clientY: 110 });
    h.move(card, { clientX: 100, clientY: 110, pointerType });
    assertReset(visual);
    assertReset(card);
  }
});
