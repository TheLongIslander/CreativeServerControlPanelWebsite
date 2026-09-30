const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function node() {
    return { listeners: {}, children: [], disabled: false, value: 'default', textContent: '', innerHTML: '',
        classList: { contains: () => false, add() {}, remove() {}, toggle() {} },
        addEventListener(type, handler) { this.listeners[type] = handler; },
        appendChild(child) { this.children.push(child); }, setAttribute() {} };
}
function harness(file, serverFetch) {
    const nodes = new Map();
    const context = { console, URLSearchParams, AbortController, setTimeout, clearTimeout, setInterval, clearInterval,
        localStorage: { getItem: () => 'fixture' },
        document: { addEventListener() {}, createElement: () => node(), body: node(), getElementById(id) {
            if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id);
        } },
        ServerContext: { id: 'default', serverName: 'Creative', profile: { capabilities: {} }, fetch: serverFetch },
        addEventListener() {}, fetch: serverFetch };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(require.resolve(`../public/${file}`), 'utf8'), context);
    return { context, nodes, get: id => context.document.getElementById(id) };
}

test('shared slots disable non-admin Start without disabling Stop/Restart of a running server', async () => {
    let payload = { running: false, state: 'offline', slots: { limit: 2, occupied: 2, canBypass: false } };
    const page = harness('script.js', async () => new Response(JSON.stringify(payload)));
    await page.context.checkServerStatus();
    assert.equal(page.get('start-server').disabled, true);
    assert.match(page.get('server-runtime-status').textContent, /Both shared server slots/);
    payload = { ...payload, running: true, state: 'ready' };
    await page.context.checkServerStatus();
    assert.equal(page.get('stop-server').disabled, false);
    assert.equal(page.get('restart-server').disabled, false);
    payload = { ...payload, running: false, state: 'offline', slots: { ...payload.slots, canBypass: true } };
    await page.context.checkServerStatus();
    assert.equal(page.get('start-server').disabled, false);
});

test('unavailable status and in-progress operations keep lifecycle controls disabled', async () => {
    let payload = { running: false, state: 'unknown' };
    const page = harness('script.js', async () => new Response(JSON.stringify(payload)));
    await page.context.checkServerStatus();
    assert.equal(page.get('start-server').disabled, true);
    assert.equal(page.get('backup-server').disabled, true);
    payload = { running: true, state: 'ready', operation: { type: 'backup' } };
    await page.context.checkServerStatus();
    assert.equal(page.get('stop-server').disabled, true);
    assert.match(page.get('server-runtime-status').textContent, /backup in progress/);
});

test('late update-history responses cannot populate a different server selection', async () => {
    const pending = [];
    const page = harness('admin.js', (url, options) => new Promise(resolve => pending.push({ url, options, resolve })));
    page.context.rendered = [];
    vm.runInContext('renderUpdateHistory = runs => rendered.push(runs); closeUpdateSummaryModal = () => {};', page.context);
    page.get('update-history-server').value = 'default';
    const creative = page.context.refreshUpdateHistory();
    page.get('update-history-server').value = 'survival';
    const survival = page.context.refreshUpdateHistory();
    assert.match(pending[0].url, /serverId=default/);
    assert.match(pending[1].url, /serverId=survival/);
    assert.equal(pending[0].options.signal.aborted, true);
    pending[1].resolve(new Response(JSON.stringify([{ id: 1, serverId: 'survival' }])));
    await survival;
    // Intentionally ignore the cancelled signal to simulate an already-completed response.
    pending[0].resolve(new Response(JSON.stringify([{ id: 1, serverId: 'default' }])));
    await creative;
    assert.equal(page.context.rendered.at(-1)[0].serverId, 'survival');
    assert.equal(page.context.rendered.filter(rows => rows[0]?.serverId === 'default').length, 0);
});


test('loading update availability stays read-only and Start calls only lifecycle endpoints', async () => {
    const calls = [];
    const page = harness('script.js', async (url, options = {}) => {
        calls.push({ url, method: options.method || 'GET' });
        if (url === '/updates/status') return new Response(JSON.stringify({ currentVersion: '1.21.11', latestVersion: '26.3', updateAvailable: true, updateInProgress: false }));
        if (url === '/start') return new Response('Server start command executed');
        if (url === '/server-status') return new Response(JSON.stringify({ running: true, state: 'starting' }));
        throw new Error(`Unexpected request: ${url}`);
    });
    page.context.alert = () => {};
    await page.context.loadUpdateStatus();
    assert.deepEqual(calls, [{ url: '/updates/status', method: 'GET' }]);
    assert.match(page.get('update-server').title, /keeps its installed Minecraft version/);
    page.get('start-server').listeners.click();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls.filter(call => call.method === 'POST'), [{ url: '/start', method: 'POST' }]);
    assert.equal(calls.some(call => ['/updates/check', '/updates/apply'].includes(call.url)), false);
    assert.equal(calls.at(-1).url, '/server-status');
    assert.equal(page.get('start-server').disabled, true);
});

test('busy lifecycle responses show the actual operation error rather than claiming an update', async () => {
    const page = harness('script.js', async () => new Response(JSON.stringify({ running: false, state: 'offline' })));
    const messages = [];
    page.context.alert = message => messages.push(message);
    const response = new Response(JSON.stringify({ error: { code: 'SERVER_BUSY', message: 'Another operation is running on this server.' } }), { status: 423 });
    assert.equal(await page.context.handleFetchResponse(response), null);
    assert.deepEqual(messages, ['Another operation is running on this server.']);
});
