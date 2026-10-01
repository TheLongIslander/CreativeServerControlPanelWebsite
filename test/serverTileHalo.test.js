const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const safari = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Safari/605.1.15';
const chrome = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

function node(tagName) {
  const attributes = new Map();
  const classes = new Set();
  return {
    tagName, style: {}, dataset: {}, children: [], parentNode: null,
    isConnected: true, width: 0, height: 0,
    classList: { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name) },
    setAttribute(name, value) { attributes.set(name, String(value)); },
    getAttribute(name) { return attributes.get(name) ?? null; },
    removeAttribute(name) { attributes.delete(name); },
    append(...children) { for (const child of children) { this.children.push(child); child.parentNode = this; } },
    remove() {
      if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1);
      this.parentNode = null;
      this.isConnected = false;
    }
  };
}

function harness({ userAgent = safari, vendor = 'Apple Computer, Inc.', contextAvailable = true, exportFailure = false, pathAvailable = true, maskFailure = false } = {}) {
  const images = [];
  const canvases = [];
  const timers = new Map();
  const paths = [];
  let nextTimer = 0;
  class MockImage {
    constructor() {
      this.listeners = new Map();
      this.complete = false;
      this.naturalWidth = 0;
      this.naturalHeight = 0;
      this.width = 0;
      this.height = 0;
    }
    addEventListener(type, listener) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(listener);
    }
    removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
    set src(value) { this.source = value; if (value) images.push(this); }
    get src() { return this.source; }
    removeAttribute(name) { if (name === 'src') this.source = ''; }
    emit(type) {
      const event = { type, target: this };
      for (const listener of this.listeners.get(type) || []) listener(event);
      this[`on${type}`]?.(event);
    }
    load(width = 640, height = 480) {
      this.complete = true;
      this.width = this.naturalWidth = width;
      this.height = this.naturalHeight = height;
      this.emit('load');
    }
    fail() { this.emit('error'); }
  }
  const document = {
    hidden: false,
    createElement(tagName) {
      const result = node(tagName);
      if (tagName === 'canvas') {
        const context = {
          draws: [], drawModes: [], clears: [], fills: [], text: [], gradients: [], paths: [], pixels: [], stack: [], globalCompositeOperation: 'source-over',
          drawImage(...args) { this.draws.push(args); this.drawModes.push(this.globalCompositeOperation); },
          clearRect(...args) { this.clears.push(args); },
          fillRect(...args) { this.fills.push({ style: this.fillStyle, args }); },
          fillText(...args) { this.text.push({ style: this.fillStyle, font: this.font, args }); },
          createLinearGradient(...args) {
            const gradient = { args, stops: [], addColorStop(...stop) { this.stops.push(stop); } };
            this.gradients.push(gradient);
            return gradient;
          },
          fill(path) { this.paths.push({ path, shadowBlur: this.shadowBlur, shadowOffsetX: this.shadowOffsetX }); },
          getImageData() {
            if (maskFailure) throw new Error('Mask readback unavailable');
            const data = new Uint8ClampedArray(167 * 255 * 4);
            [0, 3, 128, 252, 255].forEach((alpha, i) => { data[i * 4 + 3] = alpha; });
            return { data };
          },
          putImageData(pixels) { this.pixels.push(pixels); },
          setTransform() {},
          save() { this.stack.push({ shadowBlur: this.shadowBlur, shadowOffsetX: this.shadowOffsetX }); },
          restore() { Object.assign(this, this.stack.pop()); },
          scale() {},
          translate() {}
        };
        result.context = context;
        result.getContext = (type, options) => { result.contextOptions = options; return contextAvailable ? context : null; };
        result.exports = 0;
        result.toDataURL = () => {
          result.exports++;
          if (exportFailure) throw new Error('Canvas export unavailable');
          return 'data:image/png;base64,aW1hZ2U=';
        };
        canvases.push(result);
      }
      return result;
    }
  };
  const setTimer = callback => { const id = ++nextTimer; timers.set(id, callback); return id; };
  const clearTimer = id => { timers.delete(id); };
  const window = {
    document, navigator: { userAgent, vendor }, location: new URL('http://localhost/servers'),
    Image: MockImage, URL, AbortController, devicePixelRatio: 2,
    Path2D: pathAvailable ? class { constructor(data) { this.data = data; paths.push(this); } } : undefined,
    setTimeout: setTimer, clearTimeout: clearTimer,
    requestAnimationFrame: setTimer, cancelAnimationFrame: clearTimer,
    queueMicrotask
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../public/serverTileHalo'), 'utf8'), {
    window, document, navigator: window.navigator, Image: MockImage, URL,
    AbortController, setTimeout: setTimer, clearTimeout: clearTimer, queueMicrotask
  });
  return {
    window, document, images, canvases, timers, paths,
    create() {
      const visual = node('div');
      const ready = [];
      const api = window.ServerTileHalo.create(visual, value => ready.push(value));
      return { visual, ready, api };
    },
    async flush() {
      await new Promise(setImmediate);
      for (const [id, callback] of [...timers]) {
        timers.delete(id);
        callback(0);
      }
      await new Promise(setImmediate);
    }
  };
}

function snapshot(changes = {}) {
  return {
    width: 334, height: 510, path: 'M20 20H314V490H20Z',
    source: null, label: 'C', contained: false, imageBackground: '#101215',
    tint: '#287f83', depth: '#102b43', initialColor: '#c3faf3', fontFamily: 'sans-serif',
    ...changes
  };
}

async function finishRaster(page) {
  const raster = page.images.at(-1);
  assert.match(raster.src, /^data:image\/svg\+xml/);
  raster.load();
  await page.flush();
  return raster;
}

test('cached halo profile selects Safari and leaves other browser engines alone', () => {
  assert.equal(harness().window.ServerTileHalo.isPreferred(), true);
  assert.equal(harness({ userAgent: safari.replace('Macintosh; Intel Mac OS X 10_15_7', 'iPhone; CPU iPhone OS 27_0 like Mac OS X') }).window.ServerTileHalo.isPreferred(), true);
  for (const userAgent of [chrome, `${chrome} Edg/140.0`, `${chrome} OPR/120.0`, safari.replace('Version/27.0', 'CriOS/140.0'), safari.replace('Version/27.0', 'FxiOS/140.0'), 'Mozilla/5.0 Firefox/140.0', '']) {
    assert.equal(harness({ userAgent }).window.ServerTileHalo.isPreferred(), false, userAgent);
  }
  assert.equal(harness({ vendor: 'Google Inc.' }).window.ServerTileHalo.isPreferred(), false);
});

test('missing Canvas or Path2D support keeps the existing renderer without mounting surfaces', () => {
  for (const options of [{ contextAvailable: false }, { pathAvailable: false }]) {
    const page = harness(options);
    const tile = page.create();
    assert.equal(tile.api, null);
    assert.equal(tile.visual.children.length, 0);
    assert.deepEqual(tile.ready, []);
  }
});

test('renders an independent halo once and reuses it for unchanged or rounded-equivalent input', async () => {
  const page = harness();
  const tile = page.create();
  const input = snapshot({ label: '<', fontFamily: 'system-ui', initialY: 210 });
  tile.api.update(input);
  await page.flush();
  assert.equal(page.images.length, 0, 'disabled renderer does not start work');
  tile.api.setEnabled(true);
  await page.flush();
  assert.equal(page.images.length, 1);
  const xml = decodeURIComponent(page.images[0].src.split(',').slice(1).join(','));
  assert.match(xml, /viewBox="-40 -40 414 590"/);
  assert.match(xml, /href="data:image\/png;base64,/);
  assert.match(xml, /filter="url\(#glow\)"/);
  assert.doesNotMatch(xml, /feMerge|SourceGraphic|http:\/\/localhost/);
  assert.deepEqual(page.canvases[4].context.text[0].args, ['<', 167, 210], 'initial uses the live artwork baseline and is painted as canvas text, not interpolated into XML');
  assert.deepEqual(page.canvases[4].context.gradients[0].stops, [[0, '#287f83'], [1, '#102b43']]);
  assert.deepEqual(page.canvases[4].context.gradients[0].args, [0, 0, 1, 1], 'fallback uses normalized SVG gradient coordinates');
  await finishRaster(page);
  const canvas = tile.visual.children[0];
  assert.equal(canvas.width, 414, 'halo does not allocate at Retina scale');
  assert.equal(canvas.height, 590);
  assert.equal(canvas.style.visibility, 'visible');
  assert.deepEqual(tile.ready, [false, true]);
  tile.api.update({ ...input });
  tile.api.update({ ...input, width: 334.2, height: 510.2 });
  await page.flush();
  assert.equal(page.images.length, 1);
  assert.equal(canvas.context.draws.length, 1);
  assert.equal(page.timers.size, 0);
});

test('responsive updates collapse to the latest size and cap oversized backing stores', async () => {
  const page = harness();
  const tile = page.create();
  tile.api.setEnabled(true);
  tile.api.update(snapshot());
  tile.api.update(snapshot({ width: 900, height: 1200 }));
  tile.api.update(snapshot({ width: 1000, height: 1400 }));
  await page.flush();
  assert.equal(page.images.length, 1);
  await finishRaster(page);
  const canvas = tile.visual.children[0];
  assert.ok(canvas.width <= 768);
  assert.ok(canvas.height <= 768);
  assert.equal(canvas.height, 768);
  assert.equal(tile.visual.children[1].height, 1536, 'sharp foreground has a separate bounded Retina backing store');
  assert.ok(tile.visual.children[1].width <= 1536);
});

test('reuses decoded same-origin artwork across resizes and centers cover artwork', async () => {
  const page = harness();
  const tile = page.create();
  tile.api.setEnabled(true);
  tile.api.update(snapshot({ source: '/api/servers/default/thumbnail?v=one' }));
  await page.flush();
  const art = page.images[0];
  assert.equal(art.src, 'http://localhost/api/servers/default/thumbnail?v=one');
  art.load(640, 480);
  await page.flush();
  assert.deepEqual(page.canvases[4].context.draws[0].slice(1), [-173, 0, 680, 510]);
  await finishRaster(page);
  tile.api.update(snapshot({ source: '/api/servers/default/thumbnail?v=one', width: 350 }));
  await page.flush();
  assert.equal(page.images.length, 3, 'resize loads only another SVG raster, not another thumbnail');
  assert.equal(page.canvases[5].context.draws[0][0], art);
  await finishRaster(page);
  assert.equal(tile.visual.children[0].context.draws.length, 2);
});

test('contained artwork retains its letterbox background and lighten blend', async () => {
  const page = harness();
  const tile = page.create();
  tile.api.setEnabled(true);
  tile.api.update(snapshot({ source: '/assets/server-tiles/creative.png', contained: true, imageBackground: '#2c0805' }));
  await page.flush();
  page.images[0].load(640, 480);
  await page.flush();
  const painter = page.canvases[4].context;
  assert.equal(painter.fills[0].style, '#2c0805');
  assert.equal(painter.globalCompositeOperation, 'lighten');
  assert.deepEqual(painter.draws[0].slice(1), [0, 129.75, 334, 250.5]);
  await finishRaster(page);
  assert.equal(tile.ready.at(-1), true);
});

test('rejects cross-origin artwork before issuing an image request and deduplicates failed input', async () => {
  const page = harness();
  const tile = page.create();
  const input = snapshot({ source: 'https://other.example/art.png' });
  tile.api.setEnabled(true);
  tile.api.update(input);
  await page.flush();
  assert.equal(page.images.length, 0);
  assert.equal(tile.visual.children[0].style.visibility, 'hidden');
  assert.equal(tile.ready.at(-1), false);
  const readyCalls = tile.ready.length;
  tile.api.update({ ...input });
  await page.flush();
  assert.equal(tile.ready.length, readyCalls, 'status polling does not retry failed artwork');
  assert.equal(page.images.length, 0);
});

test('artwork changes cancel obsolete image loads and only publish the current halo', async () => {
  const page = harness();
  const tile = page.create();
  tile.api.setEnabled(true);
  tile.api.update(snapshot({ source: '/first.png' }));
  await page.flush();
  const obsolete = page.images[0];
  const lateLoad = obsolete.onload;
  tile.api.update(snapshot({ source: '/second.png' }));
  assert.equal(obsolete.src, '', 'obsolete image request is released');
  await page.flush();
  page.images[1].load();
  lateLoad();
  await page.flush();
  assert.equal(page.images.length, 3);
  await finishRaster(page);
  assert.equal(tile.visual.children[0].context.draws.length, 1);
  assert.equal(tile.ready.filter(Boolean).length, 1);
});

test('obsolete SVG completion cannot overwrite a newer raster', async () => {
  const page = harness();
  const tile = page.create();
  tile.api.setEnabled(true);
  tile.api.update(snapshot());
  await page.flush();
  const obsolete = page.images[0];
  const lateLoad = obsolete.onload;
  tile.api.update(snapshot({ label: 'D' }));
  assert.equal(obsolete.src, '');
  await page.flush();
  const latest = page.images.at(-1);
  await finishRaster(page);
  lateLoad();
  await page.flush();
  const draws = tile.visual.children[0].context.draws;
  assert.equal(draws.length, 1);
  assert.equal(draws[0][0], latest);
  assert.equal(tile.ready.filter(Boolean).length, 1);
});

test('returning to the rendered key restores the cached halo during an in-flight replacement', async () => {
  const page = harness();
  const tile = page.create();
  tile.api.setEnabled(true);
  tile.api.update(snapshot());
  await page.flush();
  await finishRaster(page);
  tile.api.update(snapshot({ label: 'D' }));
  await page.flush();
  const replacement = page.images.at(-1);
  tile.api.update(snapshot());
  await page.flush();
  assert.equal(replacement.src, '');
  assert.equal(tile.visual.children[0].style.visibility, 'visible');
  assert.equal(tile.ready.at(-1), true);
  assert.equal(page.images.length, 2, 'returning to cached pixels avoids another rasterization');
});

test('disabling cancels pending work and reenabling can render without publishing an obsolete result', async () => {
  const page = harness();
  const tile = page.create();
  tile.api.setEnabled(true);
  tile.api.update(snapshot({ source: '/art.png' }));
  await page.flush();
  const obsolete = page.images[0];
  const lateLoad = obsolete.onload;
  tile.api.setEnabled(false);
  assert.equal(obsolete.src, '');
  lateLoad();
  await page.flush();
  assert.equal(tile.ready.filter(Boolean).length, 0);
  tile.api.setEnabled(true);
  await page.flush();
  page.images[1].load();
  await page.flush();
  await finishRaster(page);
  tile.api.setEnabled(false);
  tile.api.setEnabled(true);
  await page.flush();
  assert.equal(page.images.length, 3, 'completed halo survives a temporary suspension');
  assert.equal(tile.visual.children[0].context.draws.length, 1);
});

test('image, raster and canvas export failures leave the original effect available', async () => {
  for (const failure of ['image', 'raster', 'export']) {
    const page = harness({ exportFailure: failure === 'export' });
    const tile = page.create();
    tile.api.setEnabled(true);
    tile.api.update(snapshot({ source: failure === 'image' ? '/broken.png' : null }));
    await page.flush();
    if (failure !== 'export') page.images[0].fail();
    await page.flush();
    assert.equal(tile.visual.children[0].context.draws.length, 0, failure);
    assert.equal(tile.visual.children[0].style.visibility, 'hidden', failure);
    assert.equal(tile.ready.at(-1), false, failure);
  }
});

test('destroy releases pending requests, canvas pixels and delayed callbacks', async () => {
  const page = harness();
  const tile = page.create();
  tile.api.setEnabled(true);
  tile.api.update(snapshot());
  await page.flush();
  const pending = page.images[0];
  const lateLoad = pending.onload;
  const canvas = tile.visual.children[0];
  const callbacks = tile.ready.length;
  tile.api.destroy();
  tile.api.destroy();
  assert.equal(pending.src, '');
  assert.equal(canvas.width, 1);
  assert.equal(canvas.height, 1);
  assert.equal(tile.visual.children.length, 0);
  for (const buffer of page.canvases) {
    assert.equal(buffer.width, 1, 'all raster buffers released');
    assert.equal(buffer.height, 1);
  }
  lateLoad();
  tile.api.update(snapshot({ label: 'D' }));
  tile.api.setEnabled(true);
  await page.flush();
  assert.equal(page.images.length, 1);
  assert.equal(canvas.context.draws.length, 0);
  assert.equal(tile.ready.length, callbacks);
  assert.equal(page.timers.size, 0);
});

test('dynamic frames reuse sharp artwork and the halo while updating only the small feather mask', async () => {
  const page = harness();
  const tile = page.create();
  const currentPath = 'M30 30H304V480H30Z';
  tile.api.update(snapshot());
  tile.api.setPath(currentPath);
  tile.api.setEnabled(true);
  await page.flush();
  assert.equal(page.paths.length, 0, 'foreground waits for the complete cache');
  assert.ok(tile.visual.children.every(surface => surface.style.visibility === 'hidden'));
  await finishRaster(page);
  const [halo, foreground, art, mask] = page.canvases;
  assert.equal(foreground.className, 'server-tile-foreground');
  assert.equal(foreground.width, 668);
  assert.equal(foreground.height, 1020);
  assert.equal(mask.width, 167);
  assert.equal(mask.height, 255);
  assert.equal(mask.contextOptions.willReadFrequently, true);
  assert.equal(page.paths.at(-1).data, currentPath, 'initial draw uses the newest contour');
  assert.equal(art.context.text.length, 1);
  assert.deepEqual(foreground.context.drawModes, ['source-over', 'destination-in']);
  assert.equal(foreground.context.globalCompositeOperation, 'source-over');
  const exports = page.canvases.reduce((count, buffer) => count + buffer.exports, 0);
  tile.api.setPath(currentPath);
  assert.equal(page.paths.length, 1, 'duplicate contours do not repaint');
  tile.api.setPath('M40 40H294V470H40Z');
  tile.api.setPath('M35 35H299V475H35Z');
  assert.equal(page.paths.length, 3);
  assert.equal(halo.context.draws.length, 1, 'dynamic path changes never rebuild the halo');
  assert.equal(art.context.text.length, 1, 'decoded artwork pixels are not repainted per frame');
  assert.equal(foreground.context.draws.length, 6);
  assert.equal(page.canvases.reduce((count, buffer) => count + buffer.exports, 0), exports, 'frames never encode an image');
  assert.equal(page.images.length, 1);
  assert.ok(tile.visual.children.every(surface => surface.style.visibility === 'visible'));
  assert.deepEqual(tile.ready, [false, true], 'readiness only publishes a complete pair of surfaces');
});

test('the low-resolution feather applies the SVG alpha transfer and excludes its sharp source', async () => {
  const page = harness();
  const tile = page.create();
  tile.api.update(snapshot());
  tile.api.setEnabled(true);
  await page.flush();
  await finishRaster(page);
  const mask = page.canvases[3];
  assert.equal(mask.context.paths[0].shadowBlur, 11);
  assert.equal(mask.context.paths[0].shadowOffsetX, 500);
  const pixels = mask.context.pixels[0].data;
  assert.deepEqual([3, 7, 11, 15, 19].map(index => pixels[index]), [0, 0, 128, 255, 255]);
  assert.equal(mask.context.stack.length, 0, 'mask state is restored after rendering');
});

test('disabled and in-flight contours are deferred, then the latest contour paints on cache reuse', async () => {
  const page = harness();
  const tile = page.create();
  tile.api.update(snapshot());
  tile.api.setEnabled(true);
  await page.flush();
  await finishRaster(page);
  tile.api.setEnabled(false);
  tile.api.setPath('M30 30H304V480H30Z');
  tile.api.setPath('M35 35H299V475H35Z');
  assert.equal(page.paths.length, 1);
  assert.ok(tile.visual.children.every(surface => surface.style.visibility === 'hidden'));
  tile.api.setEnabled(true);
  assert.equal(page.paths.length, 2);
  assert.equal(page.paths.at(-1).data, 'M35 35H299V475H35Z');
  assert.equal(page.images.length, 1, 'temporary suspension keeps the completed pixel cache');
  tile.api.update(snapshot({ label: 'D' }));
  await page.flush();
  tile.api.setPath('M40 40H294V470H40Z');
  assert.equal(page.paths.length, 2, 'pending artwork never mixes with an updated foreground');
  await finishRaster(page);
  assert.equal(page.paths.at(-1).data, 'M40 40H294V470H40Z');
  assert.equal(page.canvases[2].context.text.at(-1).args[0], 'D');
});

test('display density changes refresh foreground pixels and respect the Retina cap', async () => {
  const page = harness();
  page.window.devicePixelRatio = 1;
  const tile = page.create();
  tile.api.update(snapshot());
  tile.api.setEnabled(true);
  await page.flush();
  await finishRaster(page);
  const foreground = tile.visual.children[1];
  assert.equal(foreground.width, 334);
  page.window.devicePixelRatio = 2;
  tile.api.update(snapshot());
  await page.flush();
  await finishRaster(page);
  assert.equal(foreground.width, 668);
  assert.equal(page.images.length, 2);
  page.window.devicePixelRatio = 3;
  tile.api.update(snapshot());
  await page.flush();
  assert.equal(page.images.length, 2, 'densities above the cap share the same cache');
});

test('initial and subsequent mask failures hide both surfaces and restore the SVG renderer', async () => {
  const initial = harness({ maskFailure: true });
  const first = initial.create();
  first.api.update(snapshot());
  first.api.setEnabled(true);
  await initial.flush();
  await finishRaster(initial);
  assert.equal(first.ready.includes(true), false);
  assert.ok(first.visual.children.every(surface => surface.style.visibility === 'hidden'));
  const page = harness();
  const tile = page.create();
  tile.api.update(snapshot());
  tile.api.setEnabled(true);
  await page.flush();
  await finishRaster(page);
  page.canvases[3].context.getImageData = () => { throw new Error('Readback failed'); };
  tile.api.setPath('M30 30H304V480H30Z');
  assert.equal(tile.ready.at(-1), false);
  assert.ok(tile.visual.children.every(surface => surface.style.visibility === 'hidden'));
  const calls = tile.ready.length;
  tile.api.setPath('M35 35H299V475H35Z');
  assert.equal(tile.ready.length, calls, 'failed foreground stops per-frame work');
});
