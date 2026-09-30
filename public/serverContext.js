/* The URL owns the server identity. This context never changes within a document. */
(function attachServerContext(global) {
    'use strict';
    const pathMatch = global.location.pathname.match(/^\/servers\/([^/]+)\/?$/);
    const queryId = new URLSearchParams(global.location.search).get('serverId');
    let candidate;
    try { candidate = pathMatch ? decodeURIComponent(pathMatch[1]) : (global.location.pathname.startsWith('/servers/') ? '' : queryId || 'default'); }
    catch (_) { candidate = ''; }
    const id = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(candidate) ? candidate : '';
    const root = `/api/servers/${encodeURIComponent(id)}`;
    const prefix = 'server-tab:v1:';
    const reads = new Set();
    let userId = null;
    let profile = null;
    let departed = false;
    let revoked = false;

    function storageKeys(storage) {
        try { return Array.from({ length: storage.length }, (_, i) => storage.key(i)).filter(Boolean); }
        catch (_) { return []; }
    }
    function clearAll() {
        for (const key of storageKeys(global.sessionStorage)) {
            if (key.startsWith(prefix) || key.startsWith('server-chat:')) global.sessionStorage.removeItem(key);
        }
    }
    function clearServer(serverId = id) {
        const scope = `${prefix}${userId}:${serverId}:`;
        for (const key of storageKeys(global.sessionStorage)) {
            if (key.startsWith(scope) || (key.startsWith('server-chat:') && (key.endsWith(`:${userId}:${serverId}`) || key.includes(`:${userId}:${serverId}:`)))) global.sessionStorage.removeItem(key);
        }
        // Existing chat read cursors/preferences are already user/server scoped.
        for (const key of storageKeys(global.localStorage)) {
            if (key.startsWith('server-chat:') && (key.endsWith(`:${userId}:${serverId}`) || key.includes(`:${userId}:${serverId}:`))) {
                global.localStorage.removeItem(key);
            }
        }
    }
    function key(name) { return userId === null ? null : `${prefix}${userId}:${id}:${name}`; }
    function read(name, fallback = null) {
        try { const value = global.sessionStorage.getItem(key(name)); return value === null ? fallback : JSON.parse(value); }
        catch (_) { return fallback; }
    }
    function write(name, value) {
        if (!key(name) || revoked || departed) return;
        try { global.sessionStorage.setItem(key(name), JSON.stringify(value)); } catch (_) { /* Storage can be disabled. */ }
    }
    function init(user) {
        let previous = null;
        try { previous = global.sessionStorage.getItem('server-tab:user'); } catch (_) { /* Optional memory. */ }
        userId = user && user.id != null ? String(user.id) : null;
        if (previous !== userId) clearAll();
        try { global.sessionStorage.setItem('server-tab:user', userId || ''); } catch (_) { /* Optional memory. */ }
    }
    function apiPath(path) {
        const pathPart = typeof path === 'string' ? path.split('?')[0] : '';
        if (pathPart.includes('\\') || /(?:^|\/)(?:\.|%2e){1,2}(?:\/|$)/i.test(pathPart)) throw new Error('Invalid server request path.');
        if (!id) throw new Error('Invalid server link. Open a server from All servers.');
        if (path === root || path.startsWith(`${root}/`)) return path;
        if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || path.startsWith('/api/servers/')) {
            throw new Error('A request cannot target a different server.');
        }
        return root + path;
    }
    function revoke() {
        revoked = true;
        clearServer();
        reads.forEach(controller => controller.abort());
        global.location.replace('/servers.html?unavailable=1');
    }
    async function scopedFetch(path, options = {}) {
        if (departed || revoked) throw new DOMException('Server page is no longer active', 'AbortError');
        const headers = new Headers(options.headers || {});
        const token = global.localStorage.getItem('token');
        if (token && !headers.has('Authorization')) headers.set('Authorization', `Bearer ${token}`);
        const controller = new AbortController();
        const abort = () => controller.abort();
        if (options.signal) {
            if (options.signal.aborted) abort();
            else options.signal.addEventListener('abort', abort, { once: true });
        }
        const isRead = !options.method || options.method.toUpperCase() === 'GET';
        if (isRead) reads.add(controller);
        try {
            const response = await global.fetch(apiPath(path), {
                ...options, headers, signal: controller.signal, cache: 'no-store', credentials: 'same-origin'
            });
            if (departed || revoked) throw new DOMException('Server page is no longer active', 'AbortError');
            if (response.status === 401) {
                clearAll();
                global.localStorage.removeItem('token');
                global.location.replace('/');
            } else if (response.status === 428) {
                global.location.replace('/set-password.html');
            } else if (response.status === 404 || response.status === 403) {
                const payload = await response.clone().json().catch(() => ({}));
                const code = payload.error && payload.error.code || payload.code;
                if (['SERVER_NOT_FOUND', 'SERVER_ACCESS_DENIED', 'SERVER_DISABLED'].includes(code)) {
                    revoke();
                    throw new DOMException('Server access changed', 'AbortError');
                }
            }
            return response;
        } finally {
            reads.delete(controller);
            if (options.signal) options.signal.removeEventListener('abort', abort);
        }
    }
    global.addEventListener('pagehide', () => {
        departed = true;
        reads.forEach(controller => controller.abort());
        reads.clear();
    });
    global.addEventListener('pageshow', event => {
        // Revalidate access and close stale confirmations restored from the back/forward cache.
        if (event.persisted) global.location.reload();
    });
    global.addEventListener('storage', event => {
        if (event.key === 'token' && event.oldValue !== event.newValue) {
            clearAll();
            global.location.replace('/');
        }
    });
    global.ServerContext = Object.freeze({
        id, apiPath, fetch: scopedFetch, init, read, write, clearServer, clearAll, revoke,
        can(permission) { return profile?.permissions?.[permission] !== false; },
        setProfile(value) {
            if (!value || value.id !== id) return;
            profile = value;
            const controls = {
                start: ['start-server'], stop: ['stop-server'], restart: ['restart-server'], backup: ['backup-server'],
                backupBrowse: ['sftp-button'], backupUpload: ['upload-form', 'create-directory-button'],
                updates: ['update-server', 'server-version-button'], chatRead: ['server-chat-toggle', 'server-chat-shell'],
                playerLink: ['player-center-link-nav'], chatSend: ['server-chat-form'], players: ['player-center-toggle', 'player-center-shell']
            };
            let style = document.getElementById('server-permission-styles');
            if (!style) { style = document.createElement('style'); style.id = 'server-permission-styles'; document.head.append(style); }
            const denied = Object.entries(controls).filter(([key]) => value.permissions?.[key] === false).flatMap(([, ids]) => ids.map(id => '#' + id));
            style.textContent = denied.length ? denied.join(',') + '{display:none !important}' : '';
        },
        get profile() { return profile; },
        get serverName() { return profile && profile.displayName || id; },
        panelUrl(serverId = id) { return `/servers/${encodeURIComponent(serverId)}`; },
        sftpUrl(serverId = id) { return `/sftp.html?serverId=${encodeURIComponent(serverId)}`; }
    });
})(window);
