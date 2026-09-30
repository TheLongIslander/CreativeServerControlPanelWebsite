(function serverOverview(global) {
    'use strict';
    let controller = null;
    let pollTimer = null;
    let lastSuccess = null;
    let visibleIds = new Set();
    const nodes = {};
    const tilesById = new Map();
    const tileImages = Object.freeze({
        default: '/assets/server-tiles/creative.png',
        pogeg: '/assets/server-tiles/pogeg-farm.png'
    });
    function element(tag, className, text) {
        const node = document.createElement(tag);
        node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }
    function setupTitleLetters() {
        const heading = document.getElementById('overview-title');
        if (!heading || heading.querySelector('.overview-title-visual')) return;
        const title = heading.textContent.trim();
        const visual = element('span', 'overview-title-visual');
        visual.setAttribute('aria-hidden', 'true');
        // Expose one complete heading; the decorative letters keep stable sensors
        // and wrap at word boundaries instead of shifting as individual glyphs grow.
        for (const part of title.match(/\S+|\s+/g) || []) {
            if (/^\s+$/.test(part)) {
                visual.append(document.createTextNode(part));
                continue;
            }
            const word = element('span', 'overview-title-word');
            for (const letter of part) {
                const sensor = element('span', 'overview-title-letter-sensor');
                sensor.dataset.pointerSensor = 'letter';
                const glyph = element('span', 'overview-title-letter', letter);
                glyph.setAttribute('data-pointer-visual', '');
                sensor.append(glyph);
                word.append(sensor);
            }
            visual.append(word);
        }
        heading.setAttribute('aria-label', title);
        heading.dataset.pointerProfile = 'surface';
        heading.replaceChildren(visual);
    }
    function describeState(server) {
        const status = server.status || {};
        if (status.state === 'unavailable' || status.state === 'unknown' || status.error) return 'Status unavailable';
        if (status.state && !['ready', 'running', 'stopped', 'offline'].includes(status.state)) {
            return status.state[0].toUpperCase() + status.state.slice(1);
        }
        return status.running ? (status.ready === false ? 'Starting' : 'Online') : 'Stopped';
    }
    function updateText(node, text) {
        if (node.textContent !== text) node.textContent = text;
    }
    function syncChildren(parent, children) {
        const wanted = new Set(children);
        for (const child of Array.from(parent.children)) {
            if (!wanted.has(child)) child.remove();
        }
        children.forEach((child, index) => {
            if (parent.children[index] !== child) {
                // Moving an existing tile must not replay its entrance animation.
                if (child.parentNode === parent && child.classList.contains('is-entering')) child.classList.remove('is-entering');
                parent.insertBefore(child, parent.children[index] || null);
            }
        });
    }
    function createTile(server) {
        const tile = element('a', 'server-tile');
        tile.href = global.ServerContext.panelUrl(server.id);
        tile.dataset.serverId = server.id;
        tile.dataset.pointerProfile = 'anchored';
        // Keep the link's hitbox steady while its glass surface follows the pointer.
        const visual = element('div', 'server-tile-visual');
        tile.classList.add('is-entering');
        tile.addEventListener('animationend', event => {
            if (event.target === visual && event.animationName === 'tile-arrive') tile.classList.remove('is-entering');
        });
        const name = element('h2', '', server.displayName);
        const mark = element('div', 'server-tile-mark');
        mark.setAttribute('aria-hidden', 'true');
        const imagePath = Object.hasOwn(tileImages, server.id) ? tileImages[server.id] : null;
        if (imagePath) {
            const thumbnail = element('img', 'server-tile-thumbnail');
            thumbnail.alt = '';
            thumbnail.decoding = 'async';
            thumbnail.addEventListener('error', () => {
                mark.classList.remove('has-image');
                updateText(mark, name.textContent.slice(0, 1).toUpperCase());
            }, { once: true });
            thumbnail.src = imagePath;
            mark.classList.add('has-image');
            mark.replaceChildren(thumbnail);
        }
        // Measure this wrapper, so the mini tile's own motion cannot move its sensor.
        const infoSensor = element('div', 'server-tile-info-sensor');
        infoSensor.dataset.pointerSensor = 'surface';
        const info = element('div', 'server-tile-info');
        info.setAttribute('data-pointer-visual', '');
        const summary = element('div', 'server-tile-summary');
        const badge = element('span', 'server-tile-status');
        const population = element('span', 'server-tile-population');
        const details = element('div', 'server-tile-details');
        const operation = element('span', 'server-tile-operation');
        const alert = element('span', 'server-tile-operation');
        const backup = element('span', '');
        info.append(name, summary);
        infoSensor.append(info);
        visual.append(mark, infoSensor);
        tile.append(visual);
        return { tile, name, mark, info, summary, badge, population, details, operation, alert, backup };
    }
    function updateTile(entry, server, index) {
        const { tile, name, mark, info, summary, badge, population, details, operation, alert, backup } = entry;
        if (entry.index !== index) {
            tile.style.setProperty('--tile-index', index);
            entry.index = index;
        }
        const online = Boolean(server.status?.running);
        const description = describeState(server);
        const state = description === 'Online' ? 'online' : description === 'Stopped' ? 'offline' : 'busy';
        if (tile.dataset.state !== state) tile.dataset.state = state;
        updateText(name, server.displayName);
        const label = `${server.displayName} control panel`;
        if (tile.getAttribute('aria-label') !== label) tile.setAttribute('aria-label', label);
        if (!mark.classList.contains('has-image')) updateText(mark, server.displayName.slice(0, 1).toUpperCase());
        updateText(badge, description);
        const players = server.playerCount ?? server.status?.playerCount;
        const showPlayers = Number.isInteger(players) && online;
        updateText(population, showPlayers ? `${players} player${players === 1 ? '' : 's'}` : '');
        syncChildren(summary, showPlayers ? [badge, population] : [badge]);
        updateText(operation, server.operation ? (typeof server.operation === 'string' ? server.operation : server.operation.label || server.operation.type || 'Operation in progress') : '');
        updateText(alert, server.alert ? (typeof server.alert === 'string' ? server.alert : 'Attention needed') : '');
        let backupText = '';
        if (server.lastBackupAt) {
            const date = new Date(server.lastBackupAt);
            if (Number.isFinite(date.getTime())) backupText = `Last backup ${date.toLocaleDateString()}`;
        }
        updateText(backup, backupText);
        syncChildren(details, [operation, alert, backup].filter(node => node.textContent));
        syncChildren(info, details.childElementCount ? [name, summary, details] : [name, summary]);
    }
    function showEmpty(message) {
        updateText(nodes.empty, message);
        syncChildren(nodes.tiles, [nodes.empty]);
    }
    function renderServers(servers, nextIds) {
        const activeId = document.activeElement?.dataset.serverId;
        for (const id of tilesById.keys()) if (!nextIds.has(id)) tilesById.delete(id);
        const tiles = servers.map((server, index) => {
            let entry = tilesById.get(server.id);
            if (!entry) {
                entry = createTile(server);
                tilesById.set(server.id, entry);
            }
            updateTile(entry, server, index);
            return entry.tile;
        });
        if (tiles.length) syncChildren(nodes.tiles, tiles);
        else showEmpty('No servers are available to your account. An admin can add a server or update your access.');
        const activeTile = tilesById.get(activeId)?.tile;
        if (activeTile && document.activeElement !== activeTile) activeTile.focus({ preventScroll: true });
    }
    function showNotice(message) {
        updateText(nodes.notice, message);
        nodes.notice.classList.toggle('hidden', !message);
    }
    function setupManualRefresh(user) {
        const preferenceKey = `server-overview:manual-refresh:${user.id}`;
        const toggle = document.getElementById('manual-refresh-toggle');
        const advanced = document.getElementById('overview-advanced');
        const advancedButton = document.getElementById('overview-advanced-button');
        const advancedPanel = document.getElementById('overview-advanced-panel');
        const accountButton = document.getElementById('account-button');
        const dropdown = document.getElementById('account-dropdown');
        let enabled = user.role === 'admin';
        try {
            const saved = localStorage.getItem(preferenceKey);
            if (saved === 'true' || saved === 'false') enabled = saved === 'true';
        } catch (_) { /* Use the role default when preference storage is unavailable. */ }
        function apply(value) {
            toggle.checked = value;
            nodes.refresh.classList.toggle('hidden', !value);
        }
        apply(enabled);
        advanced.classList.remove('hidden');
        toggle.addEventListener('change', () => {
            apply(toggle.checked);
            try { localStorage.setItem(preferenceKey, String(toggle.checked)); } catch (_) { /* Keep the preference for this page. */ }
        });
        function setAdvancedOpen(open) {
            advancedPanel.classList.toggle('hidden', !open);
            advancedButton.setAttribute('aria-expanded', String(open));
        }
        advancedButton.addEventListener('click', () => {
            setAdvancedOpen(advancedPanel.classList.contains('hidden'));
        });
        function resetAdvancedWhenClosed() {
            if (dropdown.classList.contains('hidden')) setAdvancedOpen(false);
        }
        accountButton.addEventListener('click', resetAdvancedWhenClosed);
        document.addEventListener('click', resetAdvancedWhenClosed);
        document.addEventListener('keydown', event => {
            if (event.key !== 'Escape' || dropdown.classList.contains('hidden')) return;
            event.preventDefault();
            if (!advancedPanel.classList.contains('hidden')) {
                setAdvancedOpen(false);
                advancedButton.focus();
            } else {
                accountButton.click();
                accountButton.focus();
            }
        });
    }
    async function refresh({ manual = false } = {}) {
        if (controller) return;
        controller = new AbortController();
        if (manual) nodes.refresh.disabled = true;
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
            renderServers(servers, nextIds);
            const slots = payload.slots || {};
            updateText(nodes.slots, `${slots.occupied ?? '—'} / ${slots.limit ?? 2} shared slots in use${slots.canBypass ? ' · Admin override available' : ''}`);
            if (slots.occupied >= (slots.limit || 2) && !slots.canBypass) showNotice('Both server slots are in use. Stop a server before starting another.');
            else showNotice(new URLSearchParams(location.search).has('unavailable') ? 'That server is no longer available to your account.' : '');
            lastSuccess = new Date();
            if (nodes.tiles.classList.contains('is-stale')) nodes.tiles.classList.remove('is-stale');
        } catch (error) {
            if (error.name !== 'AbortError') {
                showNotice(lastSuccess ? 'Connection interrupted. Server details below may be out of date.' : error.message);
                if (!nodes.tiles.classList.contains('is-stale')) nodes.tiles.classList.add('is-stale');
                if (!lastSuccess) showEmpty('Your servers could not be loaded. Retrying automatically…');
            }
        } finally {
            controller = null;
            if (manual) nodes.refresh.disabled = false;
            if (nodes.tiles.getAttribute('aria-busy') !== 'false') nodes.tiles.setAttribute('aria-busy', 'false');
        }
    }
    global.logout = async function logout() {
        global.ServerContext.clearAll();
        await fetch('/logout', { method: 'POST', headers: { Authorization: `Bearer ${localStorage.getItem('token') || ''}` } }).catch(() => {});
        localStorage.removeItem('token');
        global.location.href = '/';
    };
    document.addEventListener('DOMContentLoaded', async () => {
        setupTitleLetters();
        nodes.tiles = document.getElementById('server-tiles');
        nodes.empty = nodes.tiles.querySelector('.overview-empty') || element('p', 'overview-empty');
        nodes.slots = document.getElementById('server-slots');
        nodes.notice = document.getElementById('overview-notice');
        nodes.refresh = document.getElementById('refresh-servers');
        nodes.refresh.addEventListener('click', () => refresh({ manual: true }));
        try {
            const response = await fetch('/me', { headers: { Authorization: `Bearer ${localStorage.getItem('token') || ''}` }, cache: 'no-store' });
            if (!response.ok) { global.ServerContext.clearAll(); global.location.replace('/'); return; }
            const user = await response.json();
            if (user.mustResetPassword) { global.location.replace('/set-password.html'); return; }
            global.ServerContext.init(user);
            global.Appearance?.init({ user });
            setupManualRefresh(user);
            await refresh();
            pollTimer = setInterval(() => { if (!document.hidden) refresh(); }, 10000);
        } catch (_) { showNotice('Could not connect to the panel. Reload to try again.'); }
    });
    global.addEventListener('pagehide', () => { controller?.abort(); clearInterval(pollTimer); });
    document.addEventListener('visibilitychange', () => { if (!document.hidden && nodes.tiles) refresh(); });
})(window);
