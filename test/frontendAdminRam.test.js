const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function element() {
  return {
    value: '', checked: false, children: [], handlers: {}, textContent: '',
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener(name, handler) { this.handlers[name] = handler; },
    append(...items) { this.children.push(...items); },
    replaceChildren(...items) { this.children = items.flatMap(item => item.fragment ? item.children : [item]); },
    get options() { return this.children; }, get childNodes() { return this.children; },
    focus() {}, scrollIntoView() {}, dispatchEvent() {},
    fire(name) { return this.handlers[name]({ preventDefault() {} }); }
  };
}

test('admin RAM editor fetches current script values and sends sync or override mode with the script revision', async () => {
  const nodes = new Map();
  const $ = id => { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); };
  const writes = [];
  let heapMb = 1024;
  const server = () => ({ id: 'default', displayName: 'Primary', rootPath: '/server', startCommandPath: '/server/start.command',
    screenSession: 'Minecraft', revision: 1, timezone: 'UTC', launch: { ramOverride: false, heapMb, initialHeapMb: 512 },
    scriptHeap: { revision: 'a'.repeat(64) } });
  const window = {};
  vm.runInNewContext(fs.readFileSync(require.resolve('../public/adminServers.js'), 'utf8'), {
    window, document: { getElementById: $, createElement: element, createDocumentFragment: () => ({ ...element(), fragment: true }) },
    localStorage: { getItem: () => 'token' },
    fetch: async (url, options) => {
      if (options.method) writes.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({ servers: [server()] }) };
    }
  });
  await window.AdminServers.init();
  heapMb = 4096; // External file edit after the initial server list was loaded.
  await $('server-profile-list').children[0].children[1].children[0].fire('click');
  assert.equal($('profile-heap').value, 4096);
  assert.equal($('profile-ram-override').checked, false);
  assert.match($('profile-ram-help').textContent, /updates the startup script/);
  assert.equal($('profile-update-pipeline').checked, true);
  $('profile-update-pipeline').checked = false;
  $('profile-heap').value = '8192';
  $('profile-initial-heap').value = '512';
  await $('server-profile-form').fire('submit');
  assert.equal(writes[0].updatePipelineEnabled, false);
  assert.equal(writes[0].launch.ramOverride, false);
  assert.equal(writes[0].launch.heapMb, 8192);
  assert.equal(writes[0].scriptRevision, 'a'.repeat(64));
  await $('server-profile-list').children[0].children[1].children[0].fire('click');
  $('profile-ram-override').checked = true;
  await $('profile-ram-override').fire('change');
  assert.match($('profile-ram-help').textContent, /stays unchanged/);
  $('profile-heap').value = '4096';
  $('profile-initial-heap').value = '512';
  await $('server-profile-form').fire('submit');
  assert.equal(writes[1].launch.ramOverride, true);
});
