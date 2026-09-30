const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../public/servers.js'), 'utf8');

class Events {
    constructor() { this.listeners = new Map(); }
    addEventListener(type, handler, options = {}) {
        const entries = this.listeners.get(type) || [];
        entries.push({ handler, once: options.once });
        this.listeners.set(type, entries);
    }
    async fire(type, event = {}) {
        const entries = [...(this.listeners.get(type) || [])];
        for (const entry of entries) {
            if (entry.once) this.listeners.set(type, this.listeners.get(type).filter(item => item !== entry));
        }
        await Promise.all(entries.map(({ handler }) => handler({ type, target: this, preventDefault() {}, ...event })));
    }
}

class Element extends Events {
    constructor(tag, document) {
        super();
        this.tagName = tag.toUpperCase();
        this.ownerDocument = document;
        this.children = [];
        this.parentNode = null;
        this.dataset = {};
        this.attributes = {};
        this.className = '';
        this.hidden = false;
        this.disabled = false;
        this._text = '';
        this.style = { setProperty() {} };
        this.classList = {
            contains: value => this.className.split(/\s+/).includes(value),
            add: (...values) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...values])].join(' '); },
            remove: (...values) => { this.className = this.className.split(/\s+/).filter(value => !values.includes(value)).join(' '); },
            toggle: (value, force) => {
                const enabled = force === undefined ? !this.classList.contains(value) : force;
                this.classList[enabled ? 'add' : 'remove'](value);
                return enabled;
            }
        };
    }
    get childElementCount() { return this.children.length; }
    get parentElement() { return this.parentNode; }
    get firstElementChild() { return this.children[0] || null; }
    get nextElementSibling() { return this.parentNode?.children[this.parentNode.children.indexOf(this) + 1] || null; }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    set textContent(value) {
        this.changed();
        for (const child of [...this.children]) this.removeChild(child);
        this._text = String(value);
    }
    changed() { this.ownerDocument.writes.push(this); }
    append(...children) { for (const child of children) this.insertBefore(child, null); }
    appendChild(child) { return this.insertBefore(child, null); }
    insertBefore(child, reference) {
        if (reference === child) return child;
        child.parentNode?.removeChild(child);
        const index = reference === null ? this.children.length : this.children.indexOf(reference);
        if (index < 0) throw new Error('Reference node is not a child');
        this.changed();
        this.children.splice(index, 0, child);
        child.parentNode = this;
        return child;
    }
    removeChild(child) {
        const index = this.children.indexOf(child);
        if (index < 0) throw new Error('Node is not a child');
        this.changed();
        this.children.splice(index, 1);
        child.parentNode = null;
        if (child.contains(this.ownerDocument.activeElement)) this.ownerDocument.activeElement = this.ownerDocument.body;
        return child;
    }
    replaceChildren(...children) {
        for (const child of [...this.children]) this.removeChild(child);
        this._text = '';
        this.append(...children);
    }
    remove() { this.parentNode?.removeChild(this); }
    contains(node) { return node === this || this.children.some(child => child.contains(node)); }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) { return this.attributes[name] ?? null; }
    focus(options = {}) {
        this.ownerDocument.activeElement = this;
        if (!options.preventScroll) this.ownerDocument.scrollTop = 0;
    }
    click() { return this.fire('click'); }
    querySelector(selector) { return descendants(this).find(node => selector.startsWith('.') ? node.classList.contains(selector.slice(1)) : node.tagName.toLowerCase() === selector) || null; }
}

function descendants(node) { return node.children.flatMap(child => [child, ...descendants(child)]); }
function assertSameNodes(actual, expected, message = 'nodes stay mounted') {
    assert.equal(actual.length, expected.length, message);
    assert.ok(actual.every((node, index) => node === expected[index]), message);
}
function visibleText(node) {
    if (node.hidden || node.classList.contains('hidden')) return '';
    return [node._text, ...node.children.map(visibleText)].filter(Boolean).join(' ');
}
function storage() {
    return Object.defineProperties({}, {
        getItem: { value(key) { return Object.hasOwn(this, key) ? this[key] : null; } },
        setItem: { value(key, value) { this[key] = String(value); } },
        removeItem: { value(key) { delete this[key]; } }
    });
}
function server(id, changes = {}) {
    return { id, displayName: id === 'default' ? 'Creative' : 'Pogeg Farm', status: { running: false, state: 'stopped' }, sftp: { state: 'available' }, ...changes };
}
function payload(servers) { return { servers, slots: { occupied: 0, limit: 2, canBypass: true } }; }

async function browser(initialPayload) {
    const document = new Events();
    document.writes = [];
    document.hidden = false;
    document.scrollTop = 0;
    document.createElement = tag => new Element(tag, document);
    document.body = document.createElement('body');
    document.activeElement = document.body;
    const ids = new Map();
    for (const id of ['server-tiles', 'server-slots', 'overview-notice', 'refresh-servers', 'manual-refresh-toggle', 'overview-advanced', 'overview-advanced-button', 'overview-advanced-panel', 'account-button', 'account-dropdown']) {
        const node = document.createElement(id.includes('button') ? 'button' : 'div');
        ids.set(id, node);
        document.body.append(node);
    }
    document.getElementById = id => ids.get(id) || null;
    let responsePayload = initialPayload;
    let poll;
    const cleared = [];
    const location = new URL('http://panel.local/servers.html');
    location.replace = url => { location.redirected = url; };
    const window = Object.assign(new Events(), {
        document, location, AbortController, URLSearchParams, localStorage: storage(), sessionStorage: storage(),
        ServerContext: {
            init() {}, clearAll() {},
            panelUrl: id => `/servers/${id}`,
            clearServer: id => cleared.push(id)
        },
        fetch: async url => {
            if (url === '/me') return { ok: true, json: async () => ({ id: 7, role: 'admin' }) };
            if (responsePayload instanceof Error) throw responsePayload;
            return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(responsePayload)) };
        },
        setInterval: (callback, milliseconds) => { assert.equal(milliseconds, 10000); poll = callback; return 1; },
        clearInterval() {}
    });
    window.window = window;
    vm.runInNewContext(source, window);
    await document.fire('DOMContentLoaded');
    assert.equal(typeof poll, 'function', 'overview installs its automatic refresh');
    return {
        document, window, cleared, tiles: ids.get('server-tiles'), notice: ids.get('overview-notice'),
        async refresh(nextPayload = responsePayload) {
            responsePayload = nextPayload;
            poll();
            // The interval starts an async refresh without returning its promise.
            await new Promise(resolve => setImmediate(resolve));
        }
    };
}

test('unchanged automatic refresh preserves the mounted tiles, images, focus and scroll position', async () => {
    const page = await browser(payload([server('default'), server('pogeg')]));
    const [creative, pogeg] = page.tiles.children;
    assert.equal(creative.href, '/servers/default');
    assert.equal(pogeg.querySelector('img').src, '/assets/server-tiles/pogeg-farm.png');
    const mounted = descendants(page.tiles);
    creative.focus();
    page.document.scrollTop = 420;
    page.document.writes.length = 0;

    for (let i = 0; i < 3; i++) await page.refresh();

    assertSameNodes(descendants(page.tiles), mounted, 'polling must retain all tile descendants, including decoded images');
    assert.equal(page.document.writes.some(node => node === page.tiles || mounted.includes(node)), false, 'identical data must not rewrite the tile tree and replay entrance animations');
    assert.ok(page.document.activeElement === creative, "existing DOM nodes retain their identity");
    assert.equal(page.document.scrollTop, 420, 'polling must not scroll a focused tile back into view');
});

test('live fields change in place while the thumbnail and tile remain mounted', async () => {
    const page = await browser(payload([server('default')]));
    const tile = page.tiles.children[0];
    const image = tile.querySelector('img');
    const backupAt = '2026-09-29T12:00:00.000Z';
    await page.refresh(payload([server('default', {
        displayName: 'Creative World', status: { running: true, ready: true }, playerCount: 1,
        sftp: { state: 'unavailable' }, operation: { label: 'Creating backup' },
        alert: 'Storage almost full', lastBackupAt: backupAt
    })]));

    assert.ok(page.tiles.children[0] === tile, "existing DOM nodes retain their identity");
    assert.ok(tile.querySelector('img') === image, "existing DOM nodes retain their identity");
    assert.equal(tile.querySelector('h2').textContent, 'Creative World');
    assert.equal(tile.querySelector('.server-tile-status').textContent, 'Online');
    assert.equal(tile.dataset.state, 'online');
    assert.match(visibleText(tile), /1 player\b/);
    assert.match(visibleText(tile), /Backups not connected/);
    assert.match(visibleText(tile), /Creating backup/);
    assert.match(visibleText(tile), /Storage almost full/);
    assert.ok(visibleText(tile).includes(`Last backup ${new Date(backupAt).toLocaleDateString()}`));

    await page.refresh(payload([server('default', { status: { running: true, ready: false }, playerCount: 2 })]));
    assert.equal(tile.querySelector('.server-tile-status').textContent, 'Starting');
    assert.equal(tile.dataset.state, 'busy');
    assert.match(visibleText(tile), /2 players\b/);
    assert.doesNotMatch(visibleText(tile), /Creating backup|Storage almost full|Last backup|Backups not connected/);

    await page.refresh(payload([server('default')]));
    assert.equal(tile.querySelector('.server-tile-status').textContent, 'Stopped');
    assert.equal(tile.dataset.state, 'offline');
    assert.doesNotMatch(visibleText(tile), /\d players?/);
    assert.ok(tile.querySelector('img') === image, "existing DOM nodes retain their identity");
});

test('server additions, reordering and revoked access preserve unaffected tiles and clear only removed server memory', async () => {
    const page = await browser(payload([server('default'), server('pogeg')]));
    const [creative, pogeg] = page.tiles.children;
    pogeg.focus();
    page.document.scrollTop = 420;
    page.window.sessionStorage.setItem('server-tab:v1:7:default:chat', 'keep');
    page.window.sessionStorage.setItem('server-chat:unread:v1:7:default:session', 'keep');
    page.window.sessionStorage.setItem('server-tab:v1:7:pogeg:chat', 'forget');
    page.window.sessionStorage.setItem('server-chat:unread:v1:7:pogeg:session', 'forget');
    page.window.sessionStorage.setItem('unrelated', 'keep');

    await page.refresh(payload([server('pogeg'), server('new', { displayName: 'New World' }), server('default')]));
    assert.deepEqual(page.tiles.children.map(tile => tile.dataset.serverId), ['pogeg', 'new', 'default']);
    assert.ok(page.tiles.children[0] === pogeg, "existing DOM nodes retain their identity");
    assert.ok(page.tiles.children[2] === creative, "existing DOM nodes retain their identity");
    assert.ok(page.document.activeElement === pogeg, 'moving the focused tile restores focus');
    assert.equal(page.document.scrollTop, 420);

    await page.refresh(payload([server('default')]));
    assert.equal(page.tiles.children.length, 1);
    assert.ok(page.tiles.children[0] === creative, "existing DOM nodes retain their identity");
    assert.deepEqual(page.cleared, ['pogeg', 'new']);
    assert.equal(page.window.sessionStorage.getItem('server-tab:v1:7:default:chat'), 'keep');
    assert.equal(page.window.sessionStorage.getItem('server-chat:unread:v1:7:default:session'), 'keep');
    assert.equal(page.window.sessionStorage.getItem('server-tab:v1:7:pogeg:chat'), null);
    assert.equal(page.window.sessionStorage.getItem('server-chat:unread:v1:7:pogeg:session'), null);
    assert.equal(page.window.sessionStorage.getItem('unrelated'), 'keep');

    await page.refresh(payload([]));
    assert.match(visibleText(page.tiles), /No servers are available/);
    const empty = page.tiles.children[0];
    await page.refresh();
    assert.ok(page.tiles.children[0] === empty, 'an unchanged empty state also stays mounted');
    await page.refresh(payload([server('default')]));
    assert.equal(page.tiles.children.length, 1);
    assert.equal(page.tiles.children[0].dataset.serverId, 'default');
    assert.doesNotMatch(visibleText(page.tiles), /No servers are available/);
});

test('failed polling retains the last tiles, marks them stale, and recovers without recreating them', async () => {
    const page = await browser(payload([server('default'), server('pogeg')]));
    const mounted = [...page.tiles.children];
    await page.refresh(new Error('Network offline'));
    assertSameNodes(page.tiles.children, mounted);
    assert.equal(page.tiles.classList.contains('is-stale'), true);
    assert.match(visibleText(page.notice), /Connection interrupted/);
    assert.equal(page.document.getElementById('refresh-servers').disabled, false);

    await page.refresh(payload([server('default'), server('pogeg', { status: { running: true, ready: true } })]));
    assertSameNodes(page.tiles.children, mounted);
    assert.equal(page.tiles.classList.contains('is-stale'), false);
    assert.equal(visibleText(page.notice), '');
    assert.equal(mounted[1].querySelector('.server-tile-status').textContent, 'Online');
});
