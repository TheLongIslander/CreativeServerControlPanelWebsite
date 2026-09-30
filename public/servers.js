(function serverOverview(global) {
    'use strict';
    let controller = null;
    let pollTimer = null;
    let lastSuccess = null;
    let visibleIds = new Set();
    const nodes = {};
    function element(tag, className, text) {
        const node = document.createElement(tag);
        node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }
    function describeState(server) {
        const status = server.status || {};
        if (status.state === 'unavailable' || status.state === 'unknown' || status.error) return 'Status unavailable';
        if (status.state && !['ready', 'running', 'stopped', 'offline'].includes(status.state)) {
            return status.state[0].toUpperCase() + status.state.slice(1);
        }
        return status.running ? (status.ready === false ? 'Starting' : 'Online') : 'Stopped';
    }
    function renderTile(server, index) {
        const tile = element('a', 'server-tile');
        tile.href = global.ServerContext.panelUrl(server.id);
        tile.style.setProperty('--tile-index', index);
        tile.dataset.serverId = server.id;
        const online = Boolean(server.status?.running);
        const description = describeState(server);
        tile.dataset.state = description === 'Online' ? 'online' : description === 'Stopped' ? 'offline' : 'busy';
        const top = element('div', 'server-tile-top');
        const mark = element('div', 'server-tile-mark', server.displayName.slice(0, 1).toUpperCase());
        mark.setAttribute('aria-hidden', 'true');
        const badge = element('span', 'server-tile-status', description);
        top.append(mark, badge);
        tile.append(top, element('h2', '', server.displayName));
        const details = element('div', 'server-tile-details');
        const players = server.playerCount ?? server.status?.playerCount;
        details.append(element('span', '', Number.isInteger(players) && online ? `${players} player${players === 1 ? '' : 's'} online` : online ? 'Ready for your next session' : 'Your world is waiting'));
        const operation = server.operation;
        if (operation) details.append(element('span', 'server-tile-operation', typeof operation === 'string' ? operation : operation.label || operation.type || 'Operation in progress'));
        if (server.alert) details.append(element('span', 'server-tile-operation', typeof server.alert === 'string' ? server.alert : 'Attention needed'));
        if (server.lastBackupAt) {
            const backup = new Date(server.lastBackupAt);
            if (Number.isFinite(backup.getTime())) details.append(element('span', '', `Last backup ${backup.toLocaleDateString()}`));
        }
        details.append(element('span', 'server-tile-files', server.sftp?.state === 'available' ? 'Backup browser connected' : 'Backup browser not connected'));
        tile.append(details, element('span', 'server-tile-open', 'Open control panel  ↗'));
        return tile;
    }
    function showNotice(message) {
        nodes.notice.textContent = message;
        nodes.notice.classList.toggle('hidden', !message);
    }
    async function refresh() {
        if (controller) return;
        controller = new AbortController();
        nodes.refresh.disabled = true;
        try {
            const response = await fetch('/api/servers', {
                headers: { Authorization: `Bearer ${localStorage.getItem('token') || ''}` },
                credentials: 'same-origin', cache: 'no-store', signal: controller.signal
            });
            if (response.status === 401) { global.ServerContext.clearAll(); global.location.replace('/'); return; }
            if (response.status === 428) { global.location.replace('/set-password.html'); return; }
            if (!response.ok) throw new Error('Could not refresh your servers.');
            const payload = await response.json();
            const servers = payload.servers || [];
            const nextIds = new Set(servers.map(server => server.id));
            for (const id of visibleIds) if (!nextIds.has(id)) global.ServerContext.clearServer(id);
            // Prune remembered state for restrictions applied while this overview was closed.
            for (const key of Object.keys(sessionStorage)) {
                const parts = key.split(':');
                if ((key.startsWith('server-tab:v1:') && !nextIds.has(parts[3])) || (key.startsWith('server-chat:') && !nextIds.has(parts[4]))) sessionStorage.removeItem(key);
            }
            visibleIds = nextIds;
            const activeId = document.activeElement?.dataset.serverId;
            nodes.tiles.replaceChildren(...servers.map(renderTile));
            if (activeId) Array.from(nodes.tiles.children).find(tile => tile.dataset.serverId === activeId)?.focus();
            if (!servers.length) nodes.tiles.append(element('p', 'overview-empty', 'No servers are available to your account. An admin can add a server or update your access.'));
            nodes.tiles.setAttribute('aria-busy', 'false');
            const slots = payload.slots || {};
            nodes.slots.textContent = `${slots.occupied ?? '—'} / ${slots.limit ?? 2} shared slots in use${slots.canBypass ? ' · Admin override available' : ''}`;
            if (slots.occupied >= (slots.limit || 2) && !slots.canBypass) showNotice('Both server slots are in use. Stop a server before starting another.');
            else showNotice(new URLSearchParams(location.search).has('unavailable') ? 'That server is no longer available to your account.' : '');
            lastSuccess = new Date();
            nodes.updated.textContent = `Updated ${lastSuccess.toLocaleTimeString()}`;
            nodes.tiles.classList.remove('is-stale');
        } catch (error) {
            if (error.name !== 'AbortError') {
                showNotice(lastSuccess ? 'Connection interrupted. Server details below may be out of date.' : error.message);
                nodes.tiles.classList.add('is-stale');
                if (!lastSuccess) nodes.tiles.replaceChildren(element('p', 'overview-empty', 'Your servers could not be loaded. Use Refresh to try again.'));
            }
        } finally {
            controller = null;
            nodes.refresh.disabled = false;
            nodes.tiles.setAttribute('aria-busy', 'false');
        }
    }
    global.logout = async function logout() {
        global.ServerContext.clearAll();
        await fetch('/logout', { method: 'POST', headers: { Authorization: `Bearer ${localStorage.getItem('token') || ''}` } }).catch(() => {});
        localStorage.removeItem('token');
        global.location.href = '/';
    };
    document.addEventListener('DOMContentLoaded', async () => {
        nodes.tiles = document.getElementById('server-tiles');
        nodes.slots = document.getElementById('server-slots');
        nodes.notice = document.getElementById('overview-notice');
        nodes.updated = document.getElementById('overview-updated');
        nodes.refresh = document.getElementById('refresh-servers');
        nodes.refresh.addEventListener('click', refresh);
        try {
            const response = await fetch('/me', { headers: { Authorization: `Bearer ${localStorage.getItem('token') || ''}` }, cache: 'no-store' });
            if (!response.ok) { global.ServerContext.clearAll(); global.location.replace('/'); return; }
            const user = await response.json();
            if (user.mustResetPassword) { global.location.replace('/set-password.html'); return; }
            global.ServerContext.init(user);
            global.Appearance?.init({ user });
            await refresh();
            pollTimer = setInterval(() => { if (!document.hidden) refresh(); }, 10000);
        } catch (_) { showNotice('Could not connect to the panel. Reload to try again.'); }
    });
    global.addEventListener('pagehide', () => { controller?.abort(); clearInterval(pollTimer); });
    document.addEventListener('visibilitychange', () => { if (!document.hidden && nodes.tiles) refresh(); });
})(window);
