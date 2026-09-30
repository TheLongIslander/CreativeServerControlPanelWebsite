const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../public/serverContext.js'), 'utf8');

function storage() {
    const values = new Map();
    return { get length() { return values.size; }, key(i) { return [...values.keys()][i]; },
        getItem(key) { return values.get(String(key)) ?? null; }, setItem(key, value) { values.set(String(key), String(value)); },
        removeItem(key) { values.delete(String(key)); } };
}
function browser(url = '/servers/default', options = {}) {
    const location = new URL(url, 'http://panel.local');
    location.replace = url => { location.redirected = url; };
    location.reload = () => { location.reloaded = true; };
    const listeners = new Map();
    const requests = [];
    const window = { URLSearchParams, Headers, AbortController, DOMException, location,
        sessionStorage: options.sessionStorage || storage(), localStorage: options.localStorage || storage(),
        addEventListener(type, handler) { listeners.set(type, handler); },
        fetch: options.fetch || (async (path, options) => { requests.push({ path, options }); return new Response('{}'); }) };
    window.window = window;
    vm.runInNewContext(source, window);
    window.ServerContext.init({ id: options.userId || 1 });
    return { window, context: window.ServerContext, requests, fire(type, event = {}) { listeners.get(type)?.(event); } };
}

test('URL identity is fixed, deep links outrank query strings, and legacy entry targets default explicitly', async () => {
    const page = browser('/servers/survival?serverId=default');
    page.window.localStorage.setItem('token', 'account-token');
    page.window.localStorage.setItem('currentServer', 'default');
    await page.context.fetch('/start', { method: 'POST' });
    assert.equal(page.context.id, 'survival');
    assert.equal(page.requests[0].path, '/api/servers/survival/start');
    assert.equal(page.requests[0].options.headers.get('Authorization'), 'Bearer account-token');
    assert.throws(() => page.context.apiPath('/api/servers/default/stop'));
    assert.throws(() => page.context.apiPath('//example.test/stop'));
    assert.equal(browser('/index.html').context.id, 'default');
    assert.equal(browser('/sftp.html?serverId=survival').context.id, 'survival');
    assert.throws(() => browser('/sftp.html?serverId=%2Fbad').context.apiPath('/stop'));
});

test('drafts and file locations restore independently per user, server and browser tab', () => {
    const sharedTab = storage();
    const a = browser('/servers/default', { sessionStorage: sharedTab });
    a.context.write('chat:draft', 'Creative only');
    a.context.write('chat:scroll', { top: 52, nearBottom: false });
    const b = browser('/servers/survival', { sessionStorage: sharedTab });
    assert.equal(b.context.read('chat:draft', ''), '');
    b.context.write('chat:draft', 'Survival only');
    b.context.write('sftp:directory', '/snapshots');
    const restoredA = browser('/servers/default', { sessionStorage: sharedTab });
    assert.equal(restoredA.context.read('chat:draft'), 'Creative only');
    assert.equal(restoredA.context.read('chat:scroll').top, 52);
    assert.equal(restoredA.context.read('sftp:directory', '/'), '/');
    assert.equal(browser('/servers/default').context.read('chat:draft'), null);
    const otherUser = browser('/servers/default', { sessionStorage: sharedTab, userId: 2 });
    assert.equal(otherUser.context.read('chat:draft'), null);
    assert.equal(browser('/servers/survival', { sessionStorage: sharedTab, userId: 2 }).context.read('sftp:directory'), null);
});

test('navigation aborts obsolete reads and never retargets an accepted mutation', async () => {
    const pending = [];
    const page = browser('/servers/default', { fetch(path, options) {
        return new Promise(resolve => pending.push({ path, options, resolve }));
    } });
    const read = page.context.fetch('/server-status');
    const mutation = page.context.fetch('/restart', { method: 'POST' });
    page.fire('pagehide');
    assert.equal(pending[0].options.signal.aborted, true);
    assert.equal(pending[1].options.signal.aborted, false);
    assert.equal(pending[1].path, '/api/servers/default/restart');
    for (const request of pending) request.resolve(new Response('{}'));
    await assert.rejects(read, { name: 'AbortError' });
    await assert.rejects(mutation, { name: 'AbortError' });
    await assert.rejects(page.context.fetch('/start', { method: 'POST' }), { name: 'AbortError' });
    page.fire('pageshow', { persisted: true });
    assert.equal(page.window.location.reloaded, true);
});

test('access revocation erases only the affected server memory and rejects new work', async () => {
    const sharedTab = storage();
    const b = browser('/servers/survival', { sessionStorage: sharedTab });
    b.context.write('chat:draft', 'Keep Survival');
    const a = browser('/servers/default', { sessionStorage: sharedTab, fetch: async () => new Response(JSON.stringify({ error: { code: 'SERVER_NOT_FOUND' } }), { status: 404 }) });
    a.context.write('chat:draft', 'Forget Creative');
    await assert.rejects(a.context.fetch('/chat/messages'), { name: 'AbortError' });
    assert.equal(a.context.read('chat:draft'), null);
    assert.equal(b.context.read('chat:draft'), 'Keep Survival');
    assert.equal(a.window.location.redirected, '/servers.html?unavailable=1');
    await assert.rejects(a.context.fetch('/stop', { method: 'POST' }), { name: 'AbortError' });
});

test('a missing optional feature does not revoke a valid server; logout clears all tab memory', async () => {
    const page = browser('/servers/default', { fetch: async () => new Response(JSON.stringify({ error: { code: 'FEATURE_UNAVAILABLE' } }), { status: 404 }) });
    page.context.write('chat:draft', 'Still here');
    await page.context.fetch('/players');
    assert.equal(page.context.read('chat:draft'), 'Still here');
    assert.equal(page.window.location.redirected, undefined);
    page.fire('storage', { key: 'token', oldValue: 'old', newValue: null });
    assert.equal(page.context.read('chat:draft'), null);
    assert.equal(page.window.location.redirected, '/');
});
