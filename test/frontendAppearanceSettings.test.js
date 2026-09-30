const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../public/appearance'), 'utf8');

function element() {
  const attributes = new Map();
  const classes = new Set();
  const properties = new Map();
  const listeners = new Map();
  const pointers = new Set();
  return {
    dataset: {}, checked: false, hidden: false, value: '',
    addEventListener(type, callback) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(callback);
    },
    emit(type, event = {}) {
      for (const callback of listeners.get(type) || []) {
        callback({ target: this, preventDefault() {}, stopPropagation() {}, ...event });
      }
    },
    setAttribute(name, value) {
      attributes.set(name, String(value));
      if (name.startsWith('data-')) {
        this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = String(value);
      }
      if (name === 'hidden') this.hidden = true;
    },
    getAttribute: name => attributes.get(name) ?? null,
    removeAttribute(name) {
      attributes.delete(name);
      if (name.startsWith('data-')) {
        delete this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())];
      }
      if (name === 'hidden') this.hidden = false;
    },
    classList: {
      add: name => classes.add(name),
      remove: name => classes.delete(name),
      contains: name => classes.has(name),
      toggle(name, force = !classes.has(name)) {
        if (force) classes.add(name);
        else classes.delete(name);
        return force;
      }
    },
    style: {
      setProperty: (name, value) => properties.set(name, value),
      getPropertyValue: name => properties.get(name) || ''
    },
    closest: () => null,
    querySelector: () => null,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 30 }),
    setPointerCapture: id => pointers.add(id),
    hasPointerCapture: id => pointers.has(id),
    releasePointerCapture: id => pointers.delete(id)
  };
}

function harness({ user, token = 'test-token' } = {}) {
  const body = element();
  // Preference controls also run on the control panel, whose pointer effects
  // have a separate engine. Keep this harness focused on actual preference events.
  body.classList.add('control-panel');
  const ids = Object.fromEntries([
    'theme-stylesheet', 'appearance-button', 'appearance-panel',
    'appearance-classic-toggle', 'appearance-server-tile-controls'
  ].map(id => [id, element()]));
  const classic = ids['appearance-classic-toggle'];
  const switchEl = element();
  const slider = element();
  classic.closest = selector => selector === '.switch' ? switchEl : null;
  switchEl.querySelector = selector => selector === '.slider' ? slider : null;
  const radios = Object.fromEntries([
    ['appearance-color', ['system', 'light', 'dark']],
    ['appearance-server-tile', ['dynamic', 'still']]
  ].map(([name, values]) => [name, values.map(value => Object.assign(element(), { value }))]));
  const document = {
    body, getElementById: id => ids[id] || null,
    querySelectorAll: selector => radios[selector.match(/name="([^"]+)"/)?.[1]] || []
  };
  const requests = [];
  const timers = [];
  const window = { document };
  vm.runInNewContext(source, {
    window, document,
    localStorage: { getItem: key => key === 'token' ? token : null },
    fetch: async (url, options) => { requests.push({ url, ...options, payload: JSON.parse(options.body) }); return { ok: true }; },
    setTimeout: callback => timers.push(callback),
    console
  });
  window.Appearance.init({ user });
  return {
    body, classic, slider, ids, requests,
    mode: value => radios['appearance-server-tile'].find(radio => radio.value === value),
    color: value => radios['appearance-color'].find(radio => radio.value === value),
    controlsHidden: () => ids['appearance-server-tile-controls'].hidden || ids['appearance-server-tile-controls'].classList.contains('hidden'),
    select(name, value) {
      for (const radio of radios[name]) radio.checked = radio.value === value;
      radios[name].find(radio => radio.checked).emit('change');
    },
    theme(value) { classic.checked = value === 'flat'; classic.emit('change'); },
    flushTimers() { while (timers.length) timers.shift()(); }
  };
}

function assertRequest(h, expected) {
  const request = h.requests.at(-1);
  assert.equal(request.url, '/appearance');
  assert.equal(request.method, 'POST');
  assert.equal(request.headers.Authorization, 'Bearer test-token');
  assert.equal(request.headers['Content-Type'], 'application/json');
  assert.deepEqual(request.payload, expected);
}

test('appearance defaults older accounts to Dynamic without writing preferences on load', () => {
  for (const user of [undefined, {}, { uiTheme: 'glass', colorScheme: 'system' }]) {
    const h = harness({ user });
    assert.equal(h.body.dataset.uiTheme, 'glass');
    assert.equal(h.body.dataset.serverTileStyle, 'dynamic');
    assert.equal(h.mode('dynamic').checked, true);
    assert.equal(h.mode('still').checked, false);
    assert.equal(h.controlsHidden(), false);
    assert.equal(h.requests.length, 0);
  }
});

test('saved Still preference restores in Glass and remains selected but hidden in Classic', () => {
  for (const uiTheme of ['glass', 'flat']) {
    const h = harness({ user: { uiTheme, colorScheme: 'dark', serverTileStyle: 'still' } });
    assert.equal(h.body.dataset.serverTileStyle, 'still');
    assert.equal(h.body.dataset.colorScheme, 'dark');
    assert.equal(h.mode('still').checked, true);
    assert.equal(h.mode('dynamic').checked, false);
    assert.equal(h.controlsHidden(), uiTheme === 'flat');
    assert.equal(h.requests.length, 0);
  }
});

test('tile mode changes update the page and persist the complete appearance state', () => {
  const h = harness({ user: { uiTheme: 'glass', colorScheme: 'light' } });
  for (const serverTileStyle of ['still', 'dynamic']) {
    h.select('appearance-server-tile', serverTileStyle);
    assert.equal(h.body.dataset.serverTileStyle, serverTileStyle);
    assertRequest(h, { uiTheme: 'glass', colorScheme: 'light', serverTileStyle });
  }
  assert.equal(h.requests.length, 2);
  h.mode('still').emit('change');
  assert.equal(h.requests.length, 2, 'an unchecked radio does not change or save the selected mode');
});

test('theme and color changes preserve Still across Classic and back to Glass', () => {
  const h = harness({ user: { uiTheme: 'glass', colorScheme: 'dark', serverTileStyle: 'still' } });
  h.theme('flat');
  assert.equal(h.controlsHidden(), true);
  assert.equal(h.mode('still').checked, true);
  assertRequest(h, { uiTheme: 'flat', colorScheme: 'dark', serverTileStyle: 'still' });
  h.select('appearance-color', 'light');
  assert.equal(h.body.dataset.colorScheme, 'light');
  assertRequest(h, { uiTheme: 'flat', colorScheme: 'light', serverTileStyle: 'still' });
  h.theme('glass');
  assert.equal(h.controlsHidden(), false);
  assert.equal(h.body.dataset.serverTileStyle, 'still');
  assert.equal(h.mode('still').checked, true);
  assertRequest(h, { uiTheme: 'glass', colorScheme: 'light', serverTileStyle: 'still' });
  h.select('appearance-color', 'system');
  assert.equal(h.body.dataset.colorScheme, undefined);
  assertRequest(h, { uiTheme: 'glass', colorScheme: 'system', serverTileStyle: 'still' });
});

test('clicking and dragging the custom theme switch also preserve the selected tile mode', () => {
  const h = harness({ user: { uiTheme: 'glass', colorScheme: 'dark', serverTileStyle: 'still' } });
  h.slider.emit('pointerdown', { pointerId: 1, clientX: 20 });
  h.slider.emit('pointerup', { pointerId: 1, clientX: 20 });
  assert.equal(h.body.dataset.uiTheme, 'flat');
  assert.equal(h.controlsHidden(), true);
  assertRequest(h, { uiTheme: 'flat', colorScheme: 'dark', serverTileStyle: 'still' });
  h.flushTimers();
  h.slider.emit('pointerdown', { pointerId: 2, clientX: 80 });
  h.slider.emit('pointermove', { pointerId: 2, clientX: 10 });
  h.slider.emit('pointerup', { pointerId: 2, clientX: 10 });
  assert.equal(h.body.dataset.uiTheme, 'glass');
  assert.equal(h.controlsHidden(), false);
  assert.equal(h.mode('still').checked, true);
  assertRequest(h, { uiTheme: 'glass', colorScheme: 'dark', serverTileStyle: 'still' });
});

test('unsigned appearance changes still apply locally without a persistence request', () => {
  const h = harness({ token: null });
  h.select('appearance-server-tile', 'still');
  assert.equal(h.body.dataset.serverTileStyle, 'still');
  assert.equal(h.mode('still').checked, true);
  assert.equal(h.requests.length, 0);
});
