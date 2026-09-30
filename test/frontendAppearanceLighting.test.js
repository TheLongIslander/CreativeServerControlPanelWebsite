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

function styleDeclaration() {
  const properties = new Map();
  return {
    setProperty: (name, value) => properties.set(name, value),
    getPropertyValue: (name) => properties.get(name) || '',
    removeProperty: (name) => properties.delete(name),
    get cssText() { return [...properties].map(([name, value]) => `${name}: ${value};`).join(' '); },
    set cssText(value) {
      properties.clear();
      for (const declaration of value.split(';')) {
        const separator = declaration.indexOf(':');
        if (separator !== -1) properties.set(declaration.slice(0, separator).trim(), declaration.slice(separator + 1).trim());
      }
    }
  };
}

function target(profile) {
  const classes = new Set();
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
    style: styleDeclaration(),
    getAttribute(name) {
      if (name === 'class') return [...classes].join(' ');
      if (name === 'style') return this.style.cssText;
      return null;
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
    getClientRects: () => node.isConnected && !node.hiddenAncestor && node.style.getPropertyValue('display') !== 'none' ? [node.rect] : [],
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
    createElement: () => target(),
    getElementById: (id) => id === 'theme-stylesheet'
      ? { getAttribute: () => '', setAttribute() {} } : null,
    querySelectorAll: () => [],
    elementFromPoint: () => document.hit
  };
  const fineQuery = { ...events(), matches: fine };
  const reducedQuery = { ...events(), matches: reduced };
  const frames = new Map();
  let nextFrame = 0;
  const metrics = { styleReads: 0 };
  const flushFrame = () => {
    const callbacks = [...frames.values()];
    frames.clear();
    callbacks.forEach(callback => callback(16));
  };
  const window = {
    ...events(), document,
    matchMedia: (query) => query.includes('prefers-reduced-motion') ? reducedQuery : fineQuery,
    getComputedStyle: (node) => {
      metrics.styleReads++;
      return { visibility: node.style.getPropertyValue('visibility') || node.visibility, fontSize: node.fontSize };
    },
    requestAnimationFrame: (callback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    },
    cancelAnimationFrame: (id) => frames.delete(id)
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
    document, window, body, fineQuery, reducedQuery, metrics, flushFrame,
    get pendingFrames() { return frames.size; },
    queueMove(node, overrides = {}) {
      document.hit = node;
      document.emit('pointermove', { target: node, pointerType: 'mouse', buttons: 0, clientX: 120, clientY: 90, ...overrides });
    },
    move(node, overrides = {}) {
      this.queueMove(node, overrides);
      flushFrame();
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

test('pointer moves use only the latest sample once per frame and pointerdown stays immediate', () => {
  const h = harness();
  const card = target('anchored');
  h.queueMove(card, { clientX: 170 });
  h.queueMove(card, { clientX: 120 });
  assert.equal(h.pendingFrames, 1);
  assert.equal(h.metrics.styleReads, 0, 'queued samples do not force style reads');
  assert.equal(card.classList.contains('is-lit'), false);
  h.flushFrame();
  assert.equal(card.style.getPropertyValue('--pop'), '0.780', 'only the final sample is applied');
  assert.equal(h.pendingFrames, 0);

  h.queueMove(card, { clientX: 170 });
  h.document.emit('pointerdown', { target: card, pointerType: 'mouse', buttons: 1, clientX: 120, clientY: 90 });
  assert.equal(h.pendingFrames, 0, 'press cancels the older queued move');
  assert.equal(card.style.getPropertyValue('--pop'), '0.780');
  h.flushFrame();
  assert.equal(card.style.getPropertyValue('--pop'), '0.780');
});

test('queued moves cannot relight tiles after a context exit', () => {
  const exits = [
    h => h.document.emit('scroll'),
    h => h.window.emit('blur'),
    h => h.window.emit('pagehide'),
    h => h.document.emit('pointerleave'),
    h => h.document.emit('pointercancel'),
    h => h.document.emit('ui-pointer-lighting-reset'),
    h => h.document.emit('pointerup', { pointerType: 'touch' }),
    h => { h.document.hidden = true; h.document.emit('visibilitychange'); },
    h => { h.fineQuery.matches = false; h.fineQuery.emit('change'); },
    h => { h.reducedQuery.matches = true; h.reducedQuery.emit('change'); },
    h => { h.body.dataset.uiTheme = 'flat'; h.mutation([{ target: h.body, attributeName: 'data-ui-theme' }]); },
    (h, card) => { card.isConnected = false; h.mutation([{ target: card, type: 'childList' }]); }
  ];
  for (const exit of exits) {
    const h = harness();
    const { card, visual, power } = tileWithPower();
    h.move(power, { clientX: 120, clientY: 110 });
    h.queueMove(power, { clientX: 125, clientY: 115 });
    exit(h, card);
    assert.equal(h.pendingFrames, 0);
    h.flushFrame();
    for (const node of [card, visual, power]) assertReset(node);
  }
});

test('a removed or hidden initial pointer target cannot light a replacement from stale coordinates', () => {
  for (const notify of [false, true]) {
    const h = harness();
    const card = target('anchored');
    const replacement = target('anchored');
    h.queueMove(card);
    card.isConnected = false;
    h.document.hit = replacement;
    if (notify) h.mutation([{ target: card, type: 'childList' }]);
    h.flushFrame();
    assert.equal(card.classList.contains('is-lit'), false);
    assert.equal(replacement.classList.contains('is-lit'), false);
  }
  const h = harness();
  const card = target('anchored');
  h.queueMove(card);
  card.style.setProperty('visibility', 'hidden');
  h.mutation([{ target: card, type: 'attributes', attributeName: 'style', oldValue: '' }]);
  assert.equal(h.pendingFrames, 0);
  h.flushFrame();
  assert.equal(card.classList.contains('is-lit'), false);
});

test('lighting mutations avoid availability reads while external styles and classes still reset hidden surfaces', () => {
  for (const external of ['visibility', 'display', 'class']) {
    const h = harness();
    const card = target('anchored');
    const beforeStyle = card.getAttribute('style');
    const beforeClass = card.getAttribute('class');
    h.move(card);
    const reads = h.metrics.styleReads;
    const lightingRecords = [
      { target: card, type: 'attributes', attributeName: 'style', oldValue: beforeStyle },
      { target: card, type: 'attributes', attributeName: 'class', oldValue: beforeClass }
    ];
    h.mutation(lightingRecords);
    assert.equal(h.metrics.styleReads, reads, 'self-generated mutations do not flush computed styles');
    assert.equal(card.classList.contains('is-lit'), true);
    const attributeName = external === 'class' ? 'class' : 'style';
    const oldValue = card.getAttribute(attributeName);
    if (external === 'class') {
      card.classList.add('hidden');
      card.hiddenAncestor = true;
    } else card.style.setProperty(external, external === 'display' ? 'none' : 'hidden');
    // Include earlier self mutations in the same delivery: an external change
    // must still be detected when it shares an element/attribute with them.
    h.mutation([...lightingRecords, { target: card, type: 'attributes', attributeName, oldValue }]);
    assertReset(card);
  }
});

test('parent, nested sensor and power geometry are read before any lighting style writes', () => {
  const h = harness();
  const { card, sensor, visual, power } = tileWithPower();
  let writes = 0;
  for (const node of [card, sensor, visual, power]) {
    const measure = node.getBoundingClientRect;
    node.getBoundingClientRect = () => {
      assert.equal(writes, 0, 'geometry must precede style writes');
      return measure();
    };
    const setProperty = node.style.setProperty;
    node.style.setProperty = (...args) => { writes++; return setProperty(...args); };
  }
  h.move(power, { clientX: 120, clientY: 110 });
  assert.ok(writes > 0);
  for (const node of [card, visual, power]) assert.equal(node.classList.contains('is-lit'), true);
});

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

function tileWithPower() {
  const card = target('anchored');
  const { sensor, visual } = nestedSurface(card);
  const power = target('surface');
  power.rect = { left: 105, top: 95, width: 30, height: 30 };
  power.parentElement = { closest: () => card };
  visual.children.push(power);
  return { card, sensor, visual, power };
}

function pointerState(node) {
  return Object.keys(neutral).map(name => node.style.getPropertyValue(name));
}

test('nested power hover keeps both tiles moving gently without losing hover expansion', () => {
  const h = harness();
  const { card, visual, power } = tileWithPower();
  let previousCard;
  let previousMini;
  for (const point of [{ clientX: 115, clientY: 108 }, { clientX: 125, clientY: 115 }]) {
    h.move(card, point);
    const normal = [card, visual].map(node => ({
      tx: parseFloat(node.style.getPropertyValue('--tx')),
      ty: parseFloat(node.style.getPropertyValue('--ty')),
      tilt: parseFloat(node.style.getPropertyValue('--skx')),
      scale: node.style.getPropertyValue('--scale'),
      pop: node.style.getPropertyValue('--pop')
    }));
    h.move(power, point);
    [card, visual].forEach((node, index) => {
      assert.equal(node.classList.contains('is-lit'), true);
      assert.equal(node.style.getPropertyValue('--scale'), normal[index].scale, 'hovering the control must not shrink its parent');
      assert.equal(node.style.getPropertyValue('--pop'), normal[index].pop, 'lighting keeps following the pointer');
      for (const [property, key] of [['--tx', 'tx'], ['--ty', 'ty'], ['--skx', 'tilt']]) {
        assert.ok(Math.abs(parseFloat(node.style.getPropertyValue(property)) - normal[index][key] * .4) < .01,
          `${property} uses gentler parent motion`);
      }
    });
    assert.equal(power.classList.contains('is-lit'), true);
    if (previousCard) {
      assert.notDeepEqual(pointerState(card), previousCard, 'main tile continues responding over the button');
      assert.notDeepEqual(pointerState(visual), previousMini, 'mini tile continues responding over the button');
    }
    previousCard = pointerState(card);
    previousMini = pointerState(visual);
  }
  h.move(power, { clientX: 125, clientY: 115, buttons: 1 });
  assertReset(power);
  assert.deepEqual(pointerState(card), previousCard);
  assert.deepEqual(pointerState(visual), previousMini);
  h.move(power, { clientX: 125, clientY: 115 });
  power.disabled = true;
  h.mutation([{ target: power, attributeName: 'disabled' }]);
  assertReset(power);
  assert.deepEqual(pointerState(card), previousCard);
  assert.deepEqual(pointerState(visual), previousMini);
  h.move(card, { clientX: 125, clientY: 115 });
  assert.notDeepEqual(pointerState(card), previousCard, 'full movement returns outside the control');
  assert.notDeepEqual(pointerState(visual), previousMini);
  h.move(null);
  assertReset(card);
  assertReset(visual);
});

test('entering directly over a power control lights all layers and exit resets all layers', () => {
  for (const exit of [
    h => h.move(null),
    h => h.window.emit('blur'),
    h => h.document.emit('scroll'),
    h => { h.body.dataset.uiTheme = 'flat'; h.mutation([{ target: h.body, attributeName: 'data-ui-theme' }]); }
  ]) {
    const h = harness();
    const { card, visual, power } = tileWithPower();
    h.move(power, { clientX: 120, clientY: 110 });
    for (const node of [card, visual, power]) assert.equal(node.classList.contains('is-lit'), true);
    exit(h);
    for (const node of [card, visual, power]) assertReset(node);
  }
});
