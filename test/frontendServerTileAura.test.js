const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const contour = require('../public/serverTileContour');

const auraSource = fs.readFileSync(require.resolve('../public/serverTileAura'), 'utf8');
const contourSource = fs.readFileSync(require.resolve('../public/serverTileContour'), 'utf8');

function random(seed) {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
}

function events() {
  const listeners = new Map();
  return {
    addEventListener(type, callback) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(callback);
    },
    removeEventListener(type, callback) { listeners.get(type)?.delete(callback); },
    emit(type, event = {}) {
      const detail = { target: this, type, ...event };
      for (const callback of listeners.get(type) || []) callback(detail);
      this[`on${type}`]?.(detail);
    }
  };
}

function element(tagName = 'div') {
  const attributes = new Map();
  const classes = new Set();
  return {
    ...events(), tagName, attributes, writes: [], children: [], dataset: {},
    isConnected: true, parentNode: null, textContent: '',
    style: {
      setProperty(name, value) { this[name] = value; },
      removeProperty(name) { delete this[name]; }
    }, geometryReads: 0,
    get parentElement() { return this.parentNode; },
    getBoundingClientRect() {
      this.geometryReads++;
      return this.rect || { left: 0, top: 0, width: this.clientWidth || 334, height: this.clientHeight || 510 };
    },
    classList: {
      add: name => classes.add(name),
      remove: name => classes.delete(name),
      contains: name => classes.has(name)
    },
    setAttribute(name, value) {
      attributes.set(name, String(value));
      this.writes.push([name, String(value)]);
    },
    getAttribute: name => attributes.get(name) ?? null,
    removeAttribute(name) {
      attributes.delete(name);
      this.writes.push([name, null]);
    },
    append(...children) {
      for (const child of children) {
        this.children.push(child);
        child.parentNode = this;
      }
    },
    remove() {
      if (this.parentNode) {
        const siblings = this.parentNode.children;
        siblings.splice(siblings.indexOf(this), 1);
      }
      this.parentNode = null;
      this.isConnected = false;
    }
  };
}

function descendants(node) {
  return [node, ...node.children.flatMap(descendants)];
}

function find(node, tagName) {
  return descendants(node).find(child => child.tagName === tagName);
}

function harness({ theme = 'glass', serverTileStyle, reduced = false, fine = true, hidden = false, observer = true, resizeObserver = false, cachedHalo = false, seed = 73 } = {}) {
  const body = element('body');
  body.dataset.uiTheme = theme;
  if (serverTileStyle !== undefined) body.dataset.serverTileStyle = serverTileStyle;
  const location = new URL('http://localhost:3000/servers?preview=glass#tiles');
  const document = {
    ...events(), body, hidden, location, baseURI: 'http://localhost:3000/',
    createElementNS: (_namespace, tagName) => element(tagName)
  };
  const motion = { ...events(), matches: reduced };
  const finePointer = { ...events(), matches: fine };
  const frames = new Map();
  const microtasks = [];
  const cancelled = [];
  const intersections = [];
  const resizes = [];
  const mutations = [];
  const halos = [];
  let nextFrame = 0;
  const window = {
    ...events(), document, location,
    getComputedStyle: node => ({ stopColor: node.getAttribute('stop-color'), fill: node.getAttribute('fill'), fontFamily: 'sans-serif' }),
    queueMicrotask: callback => microtasks.push(callback),
    matchMedia: query => query.includes('prefers-reduced-motion') ? motion : finePointer,
    requestAnimationFrame(callback) {
      const id = ++nextFrame;
      frames.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id) {
      cancelled.push(id);
      frames.delete(id);
    }
  };
  if (cachedHalo) window.ServerTileHalo = {
    isPreferred: () => true,
    create(visual, onReady) {
      const halo = {
        visual, onReady, enabled: false, updates: [], paths: [], disposed: false,
        setEnabled(value) { this.enabled = value; },
        update(snapshot) { this.updates.push(snapshot); },
        setPath(data) { this.paths.push(data); },
        destroy() { this.disposed = true; }
      };
      halos.push(halo);
      return halo;
    }
  };
  if (observer) {
    window.IntersectionObserver = class {
      constructor(callback) {
        this.callback = callback;
        this.observed = new Set();
        this.unobserved = [];
        intersections.push(this);
      }
      observe(node) { this.observed.add(node); }
      unobserve(node) { this.observed.delete(node); this.unobserved.push(node); }
    };
  }
  if (resizeObserver) {
    window.ResizeObserver = class {
      constructor(callback) {
        this.callback = callback;
        this.observed = new Set();
        this.unobserved = [];
        resizes.push(this);
      }
      observe(node) { this.observed.add(node); }
      unobserve(node) { this.observed.delete(node); this.unobserved.push(node); }
    };
  }
  const seededMath = Object.create(Math);
  seededMath.random = random(seed);
  const context = vm.createContext({
    window, document, URL, Math: seededMath,
    MutationObserver: class {
      constructor(callback) { this.callback = callback; mutations.push(this); }
      observe(target, options) { this.target = target; this.options = options; }
    }
  });
  vm.runInContext(contourSource, context);
  const contours = [];
  const createContour = window.ServerTileContour.create;
  window.ServerTileContour.create = (...args) => {
    const model = createContour(...args);
    const trace = { model, pointers: [], releases: 0, resets: 0, advances: [], pathTimes: [] };
    const wrapped = { ...model };
    for (const [method, record] of Object.entries({
      setPointer: values => trace.pointers.push(values),
      releasePointer: () => trace.releases++,
      resetInteraction: () => trace.resets++,
      advance: values => trace.advances.push(values[0]),
      path: values => trace.pathTimes.push(values[0])
    })) {
      wrapped[method] = (...values) => { record(values); return model[method](...values); };
    }
    contours.push(trace);
    return wrapped;
  };
  vm.runInContext(auraSource, context);
  return {
    window, document, body, motion, finePointer, frames, microtasks, cancelled, intersections, mutations, resizes, halos,
    create(dimensions = {}) {
      const visual = element();
      Object.assign(visual, dimensions);
      const wrapper = element();
      Object.assign(wrapper, dimensions);
      wrapper.append(visual);
      const api = window.ServerTileAura.create(visual);
      return { visual, wrapper, api, contour: contours.at(-1), surface: find(visual, 'svg'), path: find(visual, 'path'), image: find(visual, 'image') };
    },
    intersect(visual, isIntersecting) {
      for (const intersection of intersections) {
        intersection.callback([{ target: visual, isIntersecting }]);
      }
    },
    resize(visual, width, height) {
      visual.clientWidth = width;
      visual.clientHeight = height;
      if (visual.parentElement) {
        visual.parentElement.clientWidth = width;
        visual.parentElement.clientHeight = height;
      }
      for (const resize of resizes) resize.callback([{ target: visual }]);
    },
    frame(time) {
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback(time);
    },
    theme(value) {
      body.dataset.uiTheme = value;
      for (const mutation of mutations) mutation.callback([{ target: body, attributeName: 'data-ui-theme' }]);
    },
    tileStyle(value) {
      body.dataset.serverTileStyle = value;
      for (const mutation of mutations) mutation.callback([{ target: body, attributeName: 'data-server-tile-style' }]);
    },
    pointer(x, y, extra = {}) {
      document.emit('pointermove', { clientX: x, clientY: y, pointerType: 'mouse', buttons: 0, ...extra });
    }
  };
}

function measureCadence({ displayRate, tileCount, interactingCount = 0, jitter = 0 }) {
  const h = harness();
  const tiles = Array.from({ length: tileCount }, (_, index) => h.create({
    rect: { left: index < interactingCount ? 0 : (index + 1) * 450, top: 0, width: 334, height: 510 }
  }));
  for (const tile of tiles) h.intersect(tile.visual, true);
  if (interactingCount) h.pointer(314, 255);
  h.frame(0);
  const paintTimes = tiles.map(() => []);
  const noise = random(123456789);
  // Two seconds of warmup remove initial phase alignment from the measurement.
  for (let frame = 1; frame <= displayRate * 6 + 1; frame++) {
    const now = frame * 1000 / displayRate + (noise() * 2 - 1) * jitter;
    for (const tile of tiles) tile.path.writes.length = 0;
    h.frame(now);
    assert.ok(tiles.reduce((sum, tile) => sum + tile.path.writes.length, 0) <= 1,
      `at most one contour paint per ${displayRate}Hz callback`);
    assert.equal(h.frames.size, 1, 'only one shared callback is pending');
    tiles.forEach((tile, index) => {
      if (tile.path.writes.length && now > 2000 && now <= 6000) paintTimes[index].push(now);
    });
  }
  tiles.forEach((tile, index) => assert.equal(tile.contour.model.isInteracting(), index < interactingCount));
  return paintTimes.map(times => {
    const gaps = times.slice(1).map((time, index) => time - times[index]).sort((a, b) => a - b);
    return { count: times.length, rate: times.length / 4, p95: gaps[Math.ceil(gaps.length * .95) - 1], max: gaps.at(-1) };
  });
}

test('aura updates the actual contour while artwork and tile geometry stay fixed', () => {
  const h = harness();
  const tile = h.create();
  tile.api.setArtwork('/thumbnail.png', 'Creative');
  const nodes = descendants(tile.visual);
  const geometry = nodes.map(node => [...node.attributes].filter(([name]) => name !== 'd'));
  const initial = tile.path.getAttribute('d');
  for (const node of nodes) node.writes.length = 0;

  h.intersect(tile.visual, true);
  h.frame(0);
  h.frame(80);
  const first = tile.path.getAttribute('d');
  assert.notEqual(first, initial, 'the contour itself evolves');
  h.frame(160);
  assert.notEqual(tile.path.getAttribute('d'), first, 'each animation step changes the uneven silhouette');
  assert.deepEqual(nodes.map(node => [...node.attributes].filter(([name]) => name !== 'd')), geometry);
  for (const node of nodes) {
    if (node !== tile.path) assert.deepEqual(node.writes, [], `${node.tagName} does not move or resize`);
  }
  assert.ok(tile.path.writes.every(([name]) => name === 'd'));
});

test('visible tiles share one frame loop and stagger their contour paints', () => {
  const h = harness();
  const tiles = [h.create(), h.create(), h.create()];
  assert.equal(h.frames.size, 0, 'wait for initial visibility observation');
  for (const tile of tiles) h.intersect(tile.visual, true);
  assert.equal(h.frames.size, 1, 'one scheduled callback serves all tiles');
  h.frame(0);
  for (const tile of tiles) tile.path.writes.length = 0;
  for (const time of [16, 32, 48, 64]) h.frame(time);
  assert.deepEqual(tiles.map(tile => tile.path.writes.length), [0, 0, 0]);
  h.frame(80);
  assert.deepEqual(tiles.map(tile => tile.path.writes.length), [1, 0, 0]);
  h.frame(96);
  assert.deepEqual(tiles.map(tile => tile.path.writes.length), [1, 1, 0]);
  h.frame(112);
  assert.deepEqual(tiles.map(tile => tile.path.writes.length), [1, 1, 1]);
  assert.equal(h.frames.size, 1);
  assert.equal(h.intersections.length, 1, 'tiles share the visibility observer');
  assert.equal(h.mutations.length, 1, 'tiles share the theme observer');
});

test('ambient contour pacing retains its phase and shares overloaded callbacks fairly', () => {
  for (const displayRate of [30, 60, 120]) {
    for (const tileCount of [3, 4, 8]) {
      for (const jitter of [0, .6]) {
        const metrics = measureCadence({ displayRate, tileCount, jitter });
        const target = Math.min(15, displayRate / tileCount);
        const counts = metrics.map(metric => metric.count);
        assert.ok(Math.max(...counts) - Math.min(...counts) <= 1, 'ambient tiles share capacity equally');
        for (const metric of metrics) {
          assert.ok(Math.abs(metric.rate - target) <= .25,
            `${displayRate}Hz/${tileCount} tiles/jitter ${jitter}: ${metric.rate} approaches ${target}`);
          assert.ok(metric.p95 <= Math.max(1000 / 15 + 2000 / displayRate, tileCount * 1000 / displayRate) + 1.3,
            'normal jitter and overloaded fairness have bounded update gaps');
        }
      }
    }
  }
});

test('Classic, reduced motion, hidden documents and offscreen tiles schedule no animation', () => {
  for (const options of [{ theme: 'flat' }, { reduced: true }, { hidden: true }, {}]) {
    const h = harness(options);
    const tile = h.create();
    const initial = tile.path.getAttribute('d');
    if (Object.keys(options).length) h.intersect(tile.visual, true);
    assert.equal(h.frames.size, 0, JSON.stringify(options));
    h.frame(0);
    h.frame(4000);
    assert.equal(tile.path.getAttribute('d'), initial);
  }
});

test('Still mode starts no animation or pointer work, while missing mode remains compatible with Dynamic', () => {
  const h = harness({ serverTileStyle: 'still' });
  const tile = h.create();
  const initial = tile.path.getAttribute('d');
  h.intersect(tile.visual, true);
  assert.equal(h.frames.size, 0);
  h.pointer(314, 255);
  h.frame(0);
  h.frame(10000);
  assert.equal(tile.path.getAttribute('d'), initial);
  assert.equal(tile.contour.pointers.length, 0);
  assert.equal(tile.contour.advances.length, 0);
  assert.equal(tile.wrapper.geometryReads, 0);
  assert.equal(tile.contour.model.isInteracting(), false);
  assert.ok(h.mutations[0].options.attributeFilter.includes('data-server-tile-style'));

  for (const options of [{}, { serverTileStyle: 'dynamic' }]) {
    const dynamic = harness(options);
    const active = dynamic.create();
    const before = active.path.getAttribute('d');
    dynamic.intersect(active.visual, true);
    assert.equal(dynamic.frames.size, 1);
    dynamic.frame(0);
    dynamic.frame(80);
    assert.notEqual(active.path.getAttribute('d'), before);
  }
});

test('switching to Still clears the spring and pending input, then Dynamic resumes without catching up paused time', () => {
  const h = harness({ serverTileStyle: 'dynamic' });
  const tile = h.create();
  const ambient = contour.create(random(73));
  h.intersect(tile.visual, true);
  h.frame(0);
  h.pointer(314, 255);
  for (let time = 40; time <= 200; time += 40) h.frame(time);
  assert.equal(tile.contour.model.isInteracting(), true);
  h.pointer(314, 270);
  const samples = tile.contour.pointers.length;
  const resets = tile.contour.resets;
  h.tileStyle('still');
  assert.equal(h.frames.size, 0);
  assert.ok(h.cancelled.length > 0);
  assert.ok(tile.contour.resets > resets);
  assert.equal(tile.contour.model.isInteracting(), false);
  const phase = tile.contour.pathTimes.at(-1);
  const pausedPath = tile.path.getAttribute('d');
  assert.equal(pausedPath, ambient.path(phase), 'Still removes the temporary interaction deformation');
  const writes = tile.path.writes.length;
  const advances = tile.contour.advances.length;
  h.pointer(314, 280);
  h.frame(10000);
  assert.equal(tile.path.writes.length, writes);
  assert.equal(tile.contour.advances.length, advances);
  assert.equal(tile.contour.pointers.length, samples);

  h.tileStyle('dynamic');
  assert.equal(h.frames.size, 1);
  h.frame(20000);
  assert.equal(tile.path.getAttribute('d'), pausedPath, 'the first resumed frame keeps the paused phase');
  h.frame(20080);
  assert.equal(tile.path.getAttribute('d'), ambient.path(phase + .08));
  assert.equal(tile.contour.model.isInteracting(), false);
  assert.equal(tile.contour.pointers.length, samples, 'resuming cannot reuse a queued or Still-mode pointer sample');
});

test('Classic and Still independently gate the aura loop across preference changes', () => {
  const h = harness({ serverTileStyle: 'still' });
  const tile = h.create();
  h.intersect(tile.visual, true);
  h.theme('flat');
  h.theme('glass');
  assert.equal(h.frames.size, 0, 'returning to Glass retains Still');
  h.theme('flat');
  h.tileStyle('dynamic');
  assert.equal(h.frames.size, 0, 'Dynamic cannot animate while Classic is selected');
  h.theme('glass');
  assert.equal(h.frames.size, 1);
});

test('theme and reduced motion changes pause and resume without accumulating hidden time', () => {
  const h = harness({ theme: 'flat' });
  const tile = h.create();
  h.intersect(tile.visual, true);
  assert.equal(h.frames.size, 0);
  assert.equal(h.mutations[0].target, h.body);
  assert.ok(h.mutations[0].options.attributeFilter.includes('data-ui-theme'));
  h.theme('glass');
  assert.equal(h.frames.size, 1);
  h.frame(0);
  h.frame(80);
  const animated = tile.path.getAttribute('d');

  for (const [pause, resume] of [
    [() => h.theme('flat'), () => h.theme('glass')],
    [() => { h.motion.matches = true; h.motion.emit('change'); },
      () => { h.motion.matches = false; h.motion.emit('change'); }]
  ]) {
    pause();
    assert.equal(h.frames.size, 0);
    resume();
    assert.equal(h.frames.size, 1);
    h.frame(10000);
    assert.equal(tile.path.getAttribute('d'), animated, 'first resumed frame does not jump through paused time');
  }
  h.frame(10080);
  assert.notEqual(tile.path.getAttribute('d'), animated);
  assert.ok(h.cancelled.length >= 2);
});

test('document visibility and page lifecycle suspend and resume active auras', () => {
  const h = harness();
  const tile = h.create();
  h.intersect(tile.visual, true);
  h.frame(0);
  h.frame(80);
  const before = tile.path.getAttribute('d');
  h.document.hidden = true;
  h.document.emit('visibilitychange');
  assert.equal(h.frames.size, 0);
  h.document.hidden = false;
  h.document.emit('visibilitychange');
  assert.equal(h.frames.size, 1);
  h.frame(20000);
  assert.equal(tile.path.getAttribute('d'), before);
  h.window.emit('pagehide');
  assert.equal(h.frames.size, 0);
  h.document.emit('visibilitychange');
  h.theme('glass');
  assert.equal(h.frames.size, 0, 'other events cannot resume a suspended page');
  h.window.emit('pageshow');
  assert.equal(h.frames.size, 1);
  h.frame(30000);
  assert.equal(tile.path.getAttribute('d'), before);
  h.frame(30080);
  assert.notEqual(tile.path.getAttribute('d'), before);
});

test('offscreen tiles stop updating while visible peers continue, then stop the loop when all leave', () => {
  const h = harness();
  const first = h.create();
  const second = h.create();
  h.intersect(first.visual, true);
  h.intersect(second.visual, true);
  h.frame(0);
  h.frame(80);
  const firstPath = first.path.getAttribute('d');
  const secondPath = second.path.getAttribute('d');
  h.intersect(first.visual, false);
  h.frame(160);
  assert.equal(first.path.getAttribute('d'), firstPath);
  assert.notEqual(second.path.getAttribute('d'), secondPath);
  h.intersect(second.visual, false);
  assert.equal(h.frames.size, 0);
  h.intersect(first.visual, true);
  assert.equal(h.frames.size, 1);
  h.frame(5000);
  h.frame(5080);
  assert.notEqual(first.path.getAttribute('d'), firstPath);
  first.visual.isConnected = false;
  h.frame(5160);
  assert.equal(h.frames.size, 0, 'detached visuals cannot keep the loop running');
});

test('an offscreen tile resumes its own contour phase while a visible peer keeps animating', () => {
  const h = harness({ seed: 19 });
  const expected = contour.create(random(19));
  const paused = h.create();
  const peer = h.create();
  h.intersect(paused.visual, true);
  h.intersect(peer.visual, true);
  h.frame(0);
  h.frame(80);
  const beforePause = paused.path.getAttribute('d');
  const peerBefore = peer.path.getAttribute('d');
  assert.equal(beforePause, expected.path(.08));
  h.intersect(paused.visual, false);
  for (let time = 160; time <= 12080; time += 80) h.frame(time);
  assert.equal(paused.path.getAttribute('d'), beforePause);
  assert.notEqual(peer.path.getAttribute('d'), peerBefore, 'the shared loop keeps running for the peer');
  h.intersect(paused.visual, true);
  h.frame(12120);
  assert.equal(paused.path.getAttribute('d'), beforePause, 'resume still respects the contour paint interval');
  h.frame(12160);
  assert.equal(paused.path.getAttribute('d'), expected.path(.16),
    'resume advances only visible time from the paused shape, not through the peer elapsed time');
  h.frame(12200);
  h.frame(12240);
  assert.equal(paused.path.getAttribute('d'), expected.path(.24));
});

test('responsive fitting fills the Still footprint without resizing controls or stretching artwork', () => {
  const h = harness({ resizeObserver: true });
  const tile = h.create({ clientWidth: 668, clientHeight: 255 });
  const peer = h.create();
  const background = find(tile.surface, 'rect');
  const mask = find(tile.surface, 'mask');
  const outline = tile.path.parentNode;
  const initialPath = tile.path.getAttribute('d');
  assert.equal(h.resizes.length, 1, 'all tiles share one resize observer');
  assert.equal(h.resizes[0].observed.has(tile.visual), true);
  assert.equal(h.resizes[0].observed.has(peer.visual), true);
  function assertFits(slotWidth, slotHeight) {
    const [, , width, height] = tile.surface.getAttribute('viewBox').split(' ').map(Number);
    const left = parseFloat(tile.visual.style['--tile-art-left']);
    const top = parseFloat(tile.visual.style['--tile-art-top']);
    const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} ~= ${expected}`);
    // The contour's nominal edges, rather than its transparent drawing bounds,
    // must coincide with the stationary layout box after every resize.
    close(left + 46 * width / 334, 0);
    close(left + 288 * width / 334, slotWidth);
    close(top + 46 * height / 510, 0);
    close(top + 464 * height / 510, slotHeight);
    assert.equal(tile.visual.clientWidth, slotWidth);
    assert.equal(tile.visual.clientHeight, slotHeight);
    assert.equal(parseFloat(tile.visual.style['--tile-art-width']), width);
    assert.equal(parseFloat(tile.visual.style['--tile-art-height']), height);
    assert.equal(outline.getAttribute('transform'), `scale(${width / 334} ${height / 510})`);
    assert.equal(tile.image.getAttribute('preserveAspectRatio'), 'xMidYMid slice');
    for (const node of [background, tile.image, mask]) {
      assert.equal(Number(node.getAttribute('width')), width);
      assert.equal(Number(node.getAttribute('height')), height);
    }
    close(Number(find(tile.surface, 'text').getAttribute('x')) + left, slotWidth / 2);
    close(Number(find(tile.surface, 'text').getAttribute('y')) + top, 154);
  }
  assertFits(668, 255);
  h.resize(tile.visual, 501, 1020);
  assertFits(501, 1020);
  assert.equal(tile.path.getAttribute('d'), initialPath, 'resize preserves the current contour phase');

  tile.api.destroy();
  assert.equal(h.resizes[0].observed.has(tile.visual), false);
  assert.equal(h.resizes[0].observed.has(peer.visual), true);
  assert.deepEqual(h.resizes[0].unobserved, [tile.visual]);
  const writesAfterDestroy = tile.surface.writes.length;
  h.resize(tile.visual, 200, 300);
  assert.equal(tile.surface.writes.length, writesAfterDestroy, 'late resize notifications ignore destroyed tiles');
  h.resize(peer.visual, 200, 300);
  assert.equal(Number(peer.image.getAttribute('width')), 200 * 334 / 242, 'remaining tiles still respond to resizing');
  peer.api.destroy();
  assert.equal(h.resizes[0].observed.size, 0);
});

test('destroy removes its surface, unobserves the tile and cancels the last scheduled frame', () => {
  const h = harness();
  const first = h.create();
  const second = h.create();
  h.intersect(first.visual, true);
  h.intersect(second.visual, true);
  assert.equal(first.visual.classList.contains('has-live-aura'), true);
  first.api.destroy();
  assert.equal(first.visual.children.length, 0);
  assert.equal(first.visual.classList.contains('has-live-aura'), false);
  assert.equal(h.intersections[0].observed.has(first.visual), false);
  assert.equal(h.frames.size, 1, 'remaining visible tile still animates');
  second.api.destroy();
  assert.equal(h.frames.size, 0);
  assert.equal(second.visual.children.length, 0);
  assert.deepEqual(h.intersections[0].unobserved, [first.visual, second.visual]);
  assert.ok(h.cancelled.length > 0);
  h.intersect(first.visual, true);
  h.theme('glass');
  h.window.emit('pageshow');
  assert.equal(h.frames.size, 0, 'late observer and lifecycle events cannot resurrect destroyed records');
});

test('artwork swaps and failure fallback clear the source without reloading unchanged URLs', () => {
  const h = harness();
  const tile = h.create();
  const initial = find(tile.visual, 'text');
  tile.api.setArtwork('/first.png', 'creative');
  assert.equal(tile.image.getAttribute('href'), '/first.png');
  assert.equal(initial.textContent, 'C');
  tile.image.writes.length = 0;
  tile.api.setArtwork('/first.png', 'farm');
  assert.deepEqual(tile.image.writes, [], 'label refreshes must not reload the image');
  assert.equal(initial.textContent, 'F');
  tile.api.setArtwork('/second.png', 'Second');
  assert.equal(tile.image.getAttribute('href'), '/second.png');
  tile.api.setArtwork(null, 'Fallback');
  assert.equal(tile.image.getAttribute('href'), null, 'clear stale artwork after its thumbnail fails');
  assert.equal(initial.textContent, 'F');
  tile.api.setArtwork('/second.png', 'Recovered');
  assert.equal(tile.image.getAttribute('href'), '/second.png', 'a cleared URL can be loaded again');
});

test('SVG references resolve within their own tile despite the overview base URL', () => {
  const h = harness();
  const tiles = [h.create(), h.create()];
  const allIds = new Set();
  for (const tile of tiles) {
    const nodes = descendants(tile.surface);
    const ids = new Set(nodes.map(node => node.getAttribute('id')).filter(Boolean));
    for (const id of ids) {
      assert.equal(allIds.has(id), false, 'each tile owns unique definitions');
      allIds.add(id);
    }
    let references = 0;
    for (const node of nodes) {
      for (const [name, value] of node.attributes) {
        const url = value.startsWith('url(')
          ? JSON.parse(value.slice(4, -1))
          : node.tagName === 'use' && name === 'href' ? value : null;
        if (!url) continue;
        const resolved = new URL(url, h.document.baseURI);
        assert.equal(resolved.pathname, '/servers', 'references target this document, not <base href="/">');
        assert.equal(resolved.search, '?preview=glass');
        assert.ok(ids.has(resolved.hash.slice(1)), 'references cannot point into another tile');
        references++;
      }
    }
    assert.ok(references >= 5, 'artwork, mask and filters are all checked');
  }
});

test('glow and crisp artwork reuse one masked source', () => {
  const h = harness();
  const tile = h.create();
  const nodes = descendants(tile.surface);
  const sources = nodes.filter(node => node.tagName === 'use');
  assert.equal(sources.length, 1, 'the artwork is drawn and masked only once');
  assert.ok(sources[0].parentNode.getAttribute('mask'));
  const masks = nodes.filter(node => node.getAttribute('mask'));
  assert.equal(masks.length, 1);
  const merge = find(tile.surface, 'feMerge');
  assert.equal(merge.children.length, 2);
  assert.equal(merge.children[0].getAttribute('in'), null, 'the glow is painted first');
  assert.equal(merge.children[1].getAttribute('in'), 'SourceGraphic', 'the original masked artwork overlays the glow');
});

test('cached canvases replace SVG only after ready and share the scheduled contour without rebuilding artwork', () => {
  const h = harness({ cachedHalo: true });
  const tile = h.create();
  tile.api.setArtwork('/first.png', 'Creative');
  const foreground = tile.surface.children[1];
  const originalFilter = foreground.getAttribute('filter');
  const halo = h.halos[0];
  assert.equal(halo.enabled, false, 'do not rasterize before visibility is known');
  h.intersect(tile.visual, true);
  const snapshot = halo.updates.at(-1);
  assert.equal(snapshot.source, '/first.png');
  assert.equal(snapshot.label, 'C');
  assert.equal(snapshot.path, tile.path.getAttribute('d'));
  assert.equal(halo.paths.at(-1), snapshot.path, 'initial foreground starts at the resting contour');
  halo.onReady(true);
  assert.equal(foreground.getAttribute('filter'), null);
  assert.equal(tile.surface.dataset.auraRenderer, 'cached-halo');
  assert.equal(tile.surface.style.display, 'none', 'ready canvas avoids live SVG filter painting');
  assert.equal(tile.surface.dataset.auraForeground, 'canvas');
  assert.ok(foreground.children[0].getAttribute('mask'), 'SVG fallback retains its feathered mask');
  const updates = halo.updates.length;
  h.frame(0);
  h.pointer(314, 255);
  for (let time = 20; time <= 600; time += 20) h.frame(time);
  assert.notEqual(tile.path.getAttribute('d'), snapshot.path, 'only foreground follows the pointer');
  assert.equal(halo.paths.at(-1), tile.path.getAttribute('d'), 'canvas follows the same scheduled path');
  assert.equal(halo.updates.length, updates, 'animation never invalidates cached artwork or halo');
  halo.onReady(false);
  assert.equal(foreground.getAttribute('filter'), originalFilter, 'retain working SVG if rasterization fails');
  assert.equal(tile.surface.style.display, '', 'a failed cache makes the SVG visible again');
  assert.equal(tile.surface.dataset.auraForeground, 'svg');
});

test('halo invalidation follows size, artwork, final fallback colors and visibility without defeating reduced motion', () => {
  const h = harness({ cachedHalo: true, resizeObserver: true, reduced: true });
  const tile = h.create();
  const halo = h.halos[0];
  h.intersect(tile.visual, true);
  assert.equal(halo.enabled, true, 'static halo still renders under reduced motion');
  assert.equal(h.frames.size, 0);
  tile.api.setArtwork(null, 'Fallback');
  h.resize(tile.visual, 240, 540);
  assert.equal(halo.updates.at(-1).width, 240 * 334 / 242);
  assert.equal(halo.updates.at(-1).height, 540 * 510 / 418);
  assert.equal(halo.updates.at(-1).initialY, Number(find(tile.surface, 'text').getAttribute('y')),
    'cached and live fallback initials remain aligned inside the expanded surface');
  const tint = find(tile.surface, 'stop');
  tint.setAttribute('stop-color', '#66558d');
  tile.api.refreshAppearance();
  assert.equal(halo.updates.at(-1).tint, '#66558d', 'final tile order can change fallback palette');
  tile.api.setArtwork('/new.png', 'New');
  assert.equal(halo.updates.at(-1).source, '/new.png');
  tile.api.setArtwork(null, 'Error');
  assert.equal(halo.updates.at(-1).source, null);
  assert.equal(halo.updates.at(-1).label, 'E');
  h.tileStyle('still');
  assert.equal(halo.enabled, false);
  h.tileStyle('dynamic');
  assert.equal(halo.enabled, true);
  h.intersect(tile.visual, false);
  assert.equal(halo.enabled, false);
  h.intersect(tile.visual, true);
  h.document.hidden = true;
  h.document.emit('visibilitychange');
  assert.equal(halo.enabled, false);
  tile.api.destroy();
  assert.equal(halo.disposed, true);
});

test('aura can animate without IntersectionObserver and stays stopped under reduced motion', () => {
  for (const reduced of [false, true]) {
    const h = harness({ observer: false, reduced });
    const tile = h.create();
    assert.equal(h.frames.size, reduced ? 0 : 1);
    tile.api.destroy();
    assert.equal(h.frames.size, 0);
  }
});

test('without IntersectionObserver the frame loop starts after a detached tile mounts', () => {
  const h = harness({ observer: false });
  const visual = element();
  visual.isConnected = false;
  const api = h.window.ServerTileAura.create(visual);
  assert.equal(h.frames.size, 0);
  visual.isConnected = true;
  h.microtasks.splice(0).forEach(callback => callback());
  assert.equal(h.frames.size, 1);
  api.destroy();
  assert.equal(h.frames.size, 0);
});

test('a nearby mouse pulls the rendered edge and moving far away releases a settling ripple', () => {
  const h = harness();
  const tile = h.create();
  const ambient = contour.create(random(73));
  h.intersect(tile.visual, true);
  h.frame(0);
  h.pointer(314, 255);
  for (let time = 20; time <= 600; time += 20) h.frame(time);
  assert.equal(tile.contour.model.isInteracting(), true);
  assert.notEqual(tile.path.getAttribute('d'), ambient.path(tile.contour.pathTimes.at(-1)),
    'the existing masked artwork visibly follows the edge pull');

  h.pointer(1000, 1000);
  h.frame(620);
  assert.equal(tile.contour.model.isInteracting(), true, 'release retains spring energy instead of resetting abruptly');
  for (let time = 640; time <= 800; time += 20) h.frame(time);
  assert.notEqual(tile.path.getAttribute('d'), ambient.path(tile.contour.pathTimes.at(-1)),
    'the ripple remains visible after the mouse leaves the attraction range');
  for (let time = 820; time <= 10000; time += 20) h.frame(time);
  assert.equal(tile.contour.model.isInteracting(), false, 'the release eventually settles');
  assert.equal(tile.path.getAttribute('d'), ambient.path(tile.contour.pathTimes.at(-1)),
    'settling restores the original ambient contour exactly');
});

test('pointer events coalesce into one geometry read and latest sample on the shared frame', () => {
  const h = harness();
  const tile = h.create();
  h.intersect(tile.visual, true);
  h.frame(0);
  const writes = tile.path.writes.length;
  const advances = tile.contour.advances.length;
  for (let index = 0; index < 200; index++) h.pointer(314, 100 + index);
  assert.equal(tile.wrapper.geometryReads, 0, 'a high-polling mouse cannot force layout in the event handler');
  assert.equal(tile.contour.pointers.length, 0);
  assert.equal(tile.contour.advances.length, advances);
  assert.equal(tile.path.writes.length, writes);
  assert.equal(h.frames.size, 1, 'pointer input reuses the existing animation loop');
  h.frame(40);
  assert.deepEqual(tile.contour.pointers, [[46 + 314 * 242 / 334, 46 + 299 * 418 / 510]]);
  assert.equal(tile.wrapper.geometryReads, 1);
  assert.equal(tile.visual.geometryReads, 0, 'the moving visual is never used as the hitbox');
  h.frame(80);
  assert.equal(tile.wrapper.geometryReads, 1, 'a stationary pointer does not repeatedly measure layout');
});

test('edge hit testing uses the stationary wrapper and maps responsive sizes to contour coordinates', () => {
  const h = harness({ resizeObserver: true });
  const tile = h.create({ clientWidth: 668, clientHeight: 255 });
  tile.wrapper.rect = { left: 100, top: 200, width: 668, height: 255 };
  tile.visual.rect = { left: 117, top: 215, width: 700, height: 280 };
  h.intersect(tile.visual, true);
  h.pointer(728, 327.5);
  h.frame(0);
  assert.deepEqual(tile.contour.pointers.at(-1), [46 + 628 * 242 / 668, 255]);
  assert.equal(tile.contour.model.isInteracting(), true);
  assert.equal(tile.visual.geometryReads, 0);

  tile.wrapper.rect = { left: 100, top: 200, width: 1002, height: 510 };
  h.resize(tile.visual, 1002, 510);
  h.frame(40);
  assert.deepEqual(tile.contour.pointers.at(-1), [46 + 628 * 242 / 1002, 46 + 127.5 * 418 / 510],
    'a resize rechecks a stationary pointer against the new layout');
  assert.equal(tile.wrapper.geometryReads, 2);

  tile.wrapper.rect = { left: 100, top: 200, width: 0, height: 0 };
  h.pointer(728, 327.5);
  h.frame(80);
  assert.equal(tile.contour.pointers.length, 2, 'zero-sized layout cannot supply invalid contour coordinates');
  assert.ok(tile.contour.releases > 0);
});

test('touch, pen, pressed buttons, coarse pointers, Classic and reduced motion cannot pull an edge', () => {
  for (const [options, event] of [
    [{}, { pointerType: 'touch' }],
    [{}, { pointerType: 'pen' }],
    [{}, { buttons: 1 }],
    [{ fine: false }, {}],
    [{ theme: 'flat' }, {}],
    [{ reduced: true }, {}]
  ]) {
    const h = harness(options);
    const tile = h.create();
    h.intersect(tile.visual, true);
    h.frame(0);
    h.pointer(314, 255, event);
    for (let time = 40; time <= 400; time += 40) h.frame(time);
    assert.equal(tile.contour.pointers.length, 0, JSON.stringify({ options, event }));
    assert.equal(tile.wrapper.geometryReads, 0);
    assert.equal(tile.contour.model.isInteracting(), false);
  }
});

test('pointer leave and pointer down release an existing pull without teleporting the contour', () => {
  for (const type of ['pointerleave', 'pointerdown']) {
    const h = harness();
    const tile = h.create();
    h.intersect(tile.visual, true);
    h.frame(0);
    h.pointer(314, 255);
    for (let time = 40; time <= 400; time += 40) h.frame(time);
    const path = tile.path.getAttribute('d');
    h.document.emit(type);
    assert.equal(tile.path.getAttribute('d'), path);
    assert.equal(tile.contour.model.isInteracting(), true, `${type} releases into the ripple`);
    for (let time = 440; time <= 10000; time += 40) h.frame(time);
    assert.equal(tile.contour.model.isInteracting(), false);
  }
});

test('layout and lifecycle resets clear the spring and pending pointer samples', () => {
  const cases = [
    ['scroll', h => h.document.emit('scroll')],
    ['blur', h => h.window.emit('blur')],
    ['resize', h => h.window.emit('resize')],
    ['pointercancel', h => h.document.emit('pointercancel')],
    ['lighting reset', h => h.document.emit('ui-pointer-lighting-reset')],
    ['hidden', h => { h.document.hidden = true; h.document.emit('visibilitychange'); },
      h => { h.document.hidden = false; h.document.emit('visibilitychange'); }],
    ['offscreen', (h, tile) => h.intersect(tile.visual, false), (h, tile) => h.intersect(tile.visual, true)],
    ['Classic', h => h.theme('flat'), h => h.theme('glass')],
    ['Still', h => h.tileStyle('still'), h => h.tileStyle('dynamic')],
    ['reduced motion', h => { h.motion.matches = true; h.motion.emit('change'); },
      h => { h.motion.matches = false; h.motion.emit('change'); }],
    ['coarse pointer', h => { h.finePointer.matches = false; h.finePointer.emit('change'); },
      h => { h.finePointer.matches = true; h.finePointer.emit('change'); }],
    ['pagehide', h => h.window.emit('pagehide'), h => h.window.emit('pageshow')]
  ];
  for (const [name, reset, resume] of cases) {
    const h = harness();
    const tile = h.create();
    const ambient = contour.create(random(73));
    h.intersect(tile.visual, true);
    h.frame(0);
    h.pointer(314, 255);
    for (let time = 40; time <= 200; time += 40) h.frame(time);
    assert.equal(tile.contour.model.isInteracting(), true, name);
    h.pointer(314, 270); // An unconsumed sample must not resurrect the old pull.
    const samples = tile.contour.pointers.length;
    reset(h, tile);
    assert.equal(tile.contour.model.isInteracting(), false, name);
    assert.equal(tile.path.getAttribute('d'), ambient.path(tile.contour.pathTimes.at(-1)), name);
    resume?.(h, tile);
    h.frame(240);
    h.frame(280);
    assert.equal(tile.contour.model.isInteracting(), false, `${name} cannot restore stale interaction`);
    assert.equal(tile.contour.pointers.length, samples, `${name} discards queued pointer input`);
  }
});

test('destroyed and offscreen tiles receive no pointer or spring work while their peers remain active', () => {
  const h = harness();
  const removed = h.create();
  const offscreen = h.create();
  const peer = h.create();
  for (const tile of [removed, offscreen, peer]) h.intersect(tile.visual, true);
  h.frame(0);
  h.pointer(314, 255);
  h.frame(40);
  removed.api.destroy();
  h.intersect(offscreen.visual, false);
  const snapshots = [removed, offscreen].map(tile => ({
    pointers: tile.contour.pointers.length, advances: tile.contour.advances.length,
    writes: tile.path.writes.length, reads: tile.wrapper.geometryReads
  }));
  h.pointer(314, 280);
  for (let time = 80; time <= 400; time += 40) h.frame(time);
  [removed, offscreen].forEach((tile, index) => {
    assert.equal(tile.contour.model.isInteracting(), false);
    assert.deepEqual({
      pointers: tile.contour.pointers.length, advances: tile.contour.advances.length,
      writes: tile.path.writes.length, reads: tile.wrapper.geometryReads
    }, snapshots[index]);
  });
  assert.equal(peer.contour.model.isInteracting(), true);
  assert.equal(h.frames.size, 1);
  h.intersect(offscreen.visual, true);
  h.frame(440);
  assert.equal(offscreen.contour.model.isInteracting(), false, 'returning on screen does not reuse an old pointer');
});

test('one interacting edge reaches 30Hz at 60/120Hz while two ambient peers retain 15Hz', () => {
  for (const displayRate of [60, 120]) {
    for (const jitter of [0, .6]) {
      const metrics = measureCadence({ displayRate, tileCount: 3, interactingCount: 1, jitter });
      metrics.forEach((metric, index) => {
        const target = index ? 15 : 30;
        assert.ok(Math.abs(metric.rate - target) <= .25,
          `${displayRate}Hz/jitter ${jitter}: ${index ? 'ambient' : 'active'} ${metric.rate} approaches ${target}`);
        assert.ok(metric.p95 <= 1000 / target + (index ? 2000 : 1000) / displayRate + 1.3,
          'the mean rate cannot hide long gaps in contour updates');
      });
    }
  }
});

test('overload reserves interaction capacity and a fair ambient share without starving either class', () => {
  for (const displayRate of [30, 60, 120]) {
    for (const interactingCount of [1, 3]) {
      const tileCount = 8;
      const ambientCount = tileCount - interactingCount;
      const metrics = measureCadence({ displayRate, tileCount, interactingCount, jitter: .6 });
      const activeBudget = Math.min(30 * interactingCount, displayRate * 2 / 3);
      const ambientBudget = displayRate - activeBudget;
      for (const [group, budget, count] of [
        [metrics.slice(0, interactingCount), activeBudget, interactingCount],
        [metrics.slice(interactingCount), ambientBudget, ambientCount]
      ]) {
        const counts = group.map(metric => metric.count);
        assert.ok(Math.max(...counts) - Math.min(...counts) <= 1, 'oldest-painted tiles rotate within each class');
        for (const metric of group) {
          assert.ok(Math.abs(metric.rate - budget / count) <= .25,
            `${displayRate}Hz/${interactingCount} active: ${metric.rate} approaches share ${budget / count}`);
          assert.ok(metric.max <= Math.max(1000 / 30 + 1000 / displayRate, count * 3000 / displayRate) + 1.3,
            `${displayRate}Hz/${interactingCount} active: maximum wait ${metric.max} stays bounded under overload`);
        }
      }
    }
  }
});

test('settling edges retain interaction priority until their spring comes to rest', () => {
  const h = harness();
  const tiles = Array.from({ length: 4 }, (_, index) => h.create({
    rect: { left: index * 450, top: 0, width: 334, height: 510 }
  }));
  for (const tile of tiles) h.intersect(tile.visual, true);
  h.pointer(314, 255);
  h.frame(0);
  for (let frame = 1; frame <= 120; frame++) h.frame(frame * 1000 / 60);
  h.document.emit('pointerleave');
  const counts = tiles.map(() => 0);
  for (let frame = 121; frame <= 180; frame++) {
    for (const tile of tiles) tile.path.writes.length = 0;
    h.frame(frame * 1000 / 60);
    tiles.forEach((tile, index) => { counts[index] += tile.path.writes.length; });
    assert.equal(tiles[0].contour.model.isInteracting(), true, 'spring energy keeps the faster cadence during release');
  }
  assert.deepEqual(counts, [30, 10, 10, 10]);
  for (let frame = 181; frame <= 720; frame++) h.frame(frame * 1000 / 60);
  assert.equal(tiles[0].contour.model.isInteracting(), false);
});

test('long callback stalls discard overdue work and resume without a catch-up burst', () => {
  const h = harness();
  const tiles = Array.from({ length: 8 }, () => h.create());
  for (const tile of tiles) h.intersect(tile.visual, true);
  h.pointer(314, 255);
  h.frame(0);
  for (let frame = 1; frame <= 120; frame++) h.frame(frame * 1000 / 60);
  const paths = tiles.map(tile => tile.path.getAttribute('d'));
  for (const tile of tiles.slice(1)) tile.api.destroy();
  const remaining = tiles[0];
  remaining.path.writes.length = 0;
  h.frame(10000);
  assert.equal(remaining.path.writes.length, 0, 'the stalled frame starts a fresh phase');
  assert.equal(remaining.path.getAttribute('d'), paths[0]);
  assert.equal(remaining.contour.advances.at(-1), 0, 'physics does not catch up through the stall');
  h.frame(10000 + 1000 / 60);
  assert.equal(remaining.path.writes.length, 0);
  h.frame(10000 + 2000 / 60);
  assert.equal(remaining.path.writes.length, 1);
  h.frame(10050);
  assert.equal(remaining.path.writes.length, 1, 'overloaded peers left no extra debt to paint on the next callback');
  h.frame(10000 + 4000 / 60);
  assert.equal(remaining.path.writes.length, 2);
});

test('offscreen ambient tiles clear overdue paint credit while visible peers keep running', () => {
  const h = harness();
  const tiles = Array.from({ length: 8 }, () => h.create());
  for (const tile of tiles) h.intersect(tile.visual, true);
  h.frame(0);
  for (let frame = 1; frame <= 120; frame++) h.frame(frame * 1000 / 60);
  const paused = tiles.at(-1);
  h.intersect(paused.visual, false);
  const before = paused.path.getAttribute('d');
  for (let frame = 121; frame <= 240; frame++) h.frame(frame * 1000 / 60);
  for (const tile of tiles.slice(0, -1)) tile.api.destroy();
  h.intersect(paused.visual, true);
  h.frame(10000);
  h.frame(10050);
  assert.equal(paused.path.getAttribute('d'), before, 'hidden time and pre-hide overload credit are discarded');
  h.frame(10080);
  assert.notEqual(paused.path.getAttribute('d'), before);
});
