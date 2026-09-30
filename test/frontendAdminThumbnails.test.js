const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function element() {
  const classes = new Set();
  return {
    value: '', checked: false, children: [], handlers: {}, disabled: false, _text: '',
    get textContent() { return this._text; },
    set textContent(value) { this._text = String(value); this.children = []; },
    classList: {
      add: value => classes.add(value), remove: value => classes.delete(value), contains: value => classes.has(value),
      toggle(value, force) { const enabled = force ?? !classes.has(value); if (enabled) classes.add(value); else classes.delete(value); }
    },
    addEventListener(name, handler) { this.handlers[name] = handler; },
    append(...items) { this.children.push(...items); },
    replaceChildren(...items) { this._text = ''; this.children = items.flatMap(item => item.fragment ? item.children : [item]); },
    get options() { return this.children; }, get childNodes() { return this.children; }, get firstElementChild() { return this.children[0]; },
    focus() {}, scrollIntoView() {}, dispatchEvent() {},
    fire(name) { return this.handlers[name]({ preventDefault() {} }); }
  };
}

function profile(id = 'abhi', changes = {}) {
  return { id, displayName: id === 'abhi' ? 'Abhi Hardcore World' : 'Creative', revision: 4,
    rootPath: '/server', startCommandPath: '/server/start.command', screenSession: 'Minecraft',
    timezone: 'UTC', status: { running: true }, launch: { heapMb: 1024 }, thumbnailUrl: null, ...changes };
}

async function browser(servers = [profile()]) {
  const nodes = new Map();
  const $ = id => { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); };
  const requests = [], blobs = [], revoked = [];
  class FormData {
    constructor() { this.fields = new Map(); }
    append(name, file) { this.fields.set(name, file); }
  }
  const window = { URL: {
    createObjectURL(file) { const url = `blob:thumbnail-${blobs.length}`; blobs.push({ file, url }); return url; },
    revokeObjectURL(url) { revoked.push(url); }
  } };
  let write = async (url, options) => ({ server: profile(url.split('/')[3], { thumbnailUrl: options.method === 'DELETE' ? null : '/api/servers/abhi/thumbnail?v=new' }) });
  vm.runInNewContext(fs.readFileSync(require.resolve('../public/adminServers.js'), 'utf8'), {
    window, FormData, document: { getElementById: $, createElement: element, createDocumentFragment: () => ({ ...element(), fragment: true }) },
    localStorage: { getItem: () => 'token' },
    fetch: async (url, options) => {
      let payload = { servers };
      if (options.method) { requests.push({ url, options }); payload = await write(url, options); }
      return { ok: !payload.error, status: payload.error ? 400 : 200, json: async () => payload };
    }
  });
  await window.AdminServers.init();
  return { $, window, requests, blobs, revoked,
    setWrite(callback) { write = callback; },
    edit(index = 0) { return $('server-profile-list').children[index].children[1].children[0].fire('click'); },
    choose(file = { name: 'world.png', type: 'image/png', size: 32 }) {
      $('profile-thumbnail-file').files = [file];
      $('profile-thumbnail-file').value = file.name;
      return $('profile-thumbnail-file').fire('change');
    }
  };
}

test('thumbnail upload previews locally, posts multipart, and preserves unsaved profile settings on a running server', async () => {
  const page = await browser();
  const { $ } = page;
  await page.edit();
  assert.equal($('profile-thumbnail-preview').textContent, 'A');
  assert.equal($('upload-server-thumbnail').disabled, true);
  $('profile-name').value = 'Unsaved display name';
  $('profile-heap').value = '8192';
  await page.choose();
  assert.equal($('profile-thumbnail-preview').firstElementChild.src, 'blob:thumbnail-0');
  assert.equal($('profile-thumbnail-file').value, 'world.png');
  assert.match($('profile-thumbnail-notice').textContent, /Click Upload thumbnail/);
  assert.equal(page.requests.length, 0, 'selecting an image alone does not upload it');
  page.setWrite(async (url, options) => ({ server: profile('abhi', {
    revision: 99, launch: { heapMb: 32768 }, thumbnailUrl: options.method === 'DELETE' ? null : '/api/servers/abhi/thumbnail?v=new'
  }) }));
  await $('upload-server-thumbnail').fire('click');
  assert.equal(page.requests[0].url, '/admin/servers/abhi/thumbnail');
  assert.equal(page.requests[0].options.method, 'POST');
  assert.equal(page.requests[0].options.body.fields.get('thumbnail').name, 'world.png');
  assert.equal(page.requests[0].options.headers.Authorization, 'Bearer token');
  assert.equal('Content-Type' in page.requests[0].options.headers, false, 'browser must supply the multipart boundary');
  assert.equal($('profile-thumbnail-preview').firstElementChild.src, '/api/servers/abhi/thumbnail?v=new');
  assert.deepEqual(page.revoked, ['blob:thumbnail-0']);
  assert.equal($('profile-name').value, 'Unsaved display name');
  assert.equal($('profile-heap').value, '8192');
  assert.equal($('remove-server-thumbnail').classList.contains('hidden'), false);
  assert.equal($('upload-server-thumbnail').disabled, true);
  assert.equal($('save-server-profile').disabled, false);
  await $('remove-server-thumbnail').fire('click');
  assert.equal(page.requests[1].options.method, 'DELETE');
  assert.equal($('profile-thumbnail-preview').textContent, 'A');
  assert.equal($('remove-server-thumbnail').classList.contains('hidden'), true);
  await $('server-profile-form').fire('submit');
  const savedProfile = JSON.parse(page.requests[2].options.body);
  assert.equal(savedProfile.revision, 4, 'thumbnail replies cannot adopt a newer revision and overwrite another admin’s concurrent edits');
  assert.equal(savedProfile.launch.heapMb, 8192);
});

test('invalid selections never upload and blob previews are revoked when replaced or cancelled', async () => {
  const page = await browser([profile('default')]);
  const { $ } = page;
  await page.edit();
  assert.equal($('profile-thumbnail-preview').firstElementChild.src, '/assets/server-tiles/creative.png');
  for (const file of [
    { name: 'vector.svg', type: 'image/svg+xml', size: 16 },
    { name: 'big.png', type: 'image/png', size: 5 * 1024 * 1024 + 1 },
    { name: 'empty.png', type: 'image/png', size: 0 }
  ]) {
    await page.choose(file);
    assert.equal($('upload-server-thumbnail').disabled, true);
    assert.equal($('profile-thumbnail-notice').classList.contains('profile-error'), true);
    await $('upload-server-thumbnail').fire('click');
  }
  assert.equal(page.requests.length, 0);
  assert.equal(page.blobs.length, 0);
  await page.choose();
  await page.choose({ name: 'new.webp', type: 'image/webp', size: 5 * 1024 * 1024 });
  assert.deepEqual(page.revoked, ['blob:thumbnail-0']);
  await $('cancel-server-profile').fire('click');
  assert.deepEqual(page.revoked, ['blob:thumbnail-0', 'blob:thumbnail-1']);
  await $('add-server-profile').fire('click');
  assert.equal($('profile-thumbnail-editor').classList.contains('hidden'), true);
  assert.equal($('profile-thumbnail-registration-help').classList.contains('hidden'), false);
});

test('failed uploads keep the selected preview available for retry and errors stay near the upload controls', async () => {
  const page = await browser();
  const { $ } = page;
  await page.edit();
  await page.choose();
  page.setWrite(async () => ({ error: { message: 'Image could not be decoded.' } }));
  await $('upload-server-thumbnail').fire('click');
  assert.equal($('profile-thumbnail-notice').textContent, 'Image could not be decoded.');
  assert.equal($('upload-server-thumbnail').disabled, false);
  assert.equal($('save-server-profile').disabled, false);
  assert.equal($('profile-thumbnail-preview').firstElementChild.src, 'blob:thumbnail-0');
  assert.deepEqual(page.revoked, []);
});

test('pending uploads cannot retarget a different editor or overwrite its controls and preview', async () => {
  const page = await browser([profile(), profile('default')]);
  const { $ } = page;
  await page.edit();
  await page.choose();
  let finish;
  page.setWrite(() => new Promise(resolve => { finish = resolve; }));
  const uploading = $('upload-server-thumbnail').fire('click');
  assert.equal($('save-server-profile').disabled, true);
  await $('upload-server-thumbnail').fire('click');
  assert.equal(page.requests.length, 1, 'duplicate clicks cannot start overlapping uploads');
  await page.edit(1);
  await page.choose({ name: 'creative.jpg', type: 'image/jpeg', size: 32 });
  const preview = $('profile-thumbnail-preview').firstElementChild;
  finish({ server: profile('abhi', { thumbnailUrl: '/api/servers/abhi/thumbnail?v=late' }) });
  await uploading;
  assert.equal(page.requests[0].url, '/admin/servers/abhi/thumbnail');
  assert.equal($('profile-name').value, 'Creative');
  assert.equal($('profile-thumbnail-preview').firstElementChild, preview);
  assert.equal($('upload-server-thumbnail').disabled, false);
  assert.match($('profile-thumbnail-notice').textContent, /creative.jpg selected/);
  assert.deepEqual(page.revoked, ['blob:thumbnail-0']);
});
