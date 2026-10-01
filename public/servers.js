(function serverOverview(global) {
    'use strict';
    let controller = null;
    let pollTimer = null;
    let lastSuccess = null;
    let visibleIds = new Set();
    let refreshPromise = null;
    let sharedSlots = {};
    let openSlotPopup = null;
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
        return status.running ? (status.ready === false ? 'Starting' : 'Online') : 'Offline';
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
        const tile = element('div', 'server-tile');
        const link = element('a', 'server-tile-link');
        link.href = global.ServerContext.panelUrl(server.id);
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
        // Measure this wrapper, so the mini tile's own motion cannot move its sensor.
        const infoSensor = element('div', 'server-tile-info-sensor');
        infoSensor.dataset.pointerSensor = 'surface';
        const info = element('div', 'server-tile-info');
        info.setAttribute('data-pointer-visual', '');
        const copy = element('div', 'server-tile-copy');
        const power = element('button', 'server-tile-power');
        power.type = 'button';
        power.dataset.pointerProfile = 'surface';
        const icon = element('span', 'server-tile-power-icon');
        icon.setAttribute('aria-hidden', 'true');
        power.append(icon);
        const feedback = element('span', 'server-tile-feedback');
        feedback.setAttribute('role', 'status');
        const summary = element('div', 'server-tile-summary');
        const badge = element('span', 'server-tile-status');
        const population = element('span', 'server-tile-population');
        const details = element('div', 'server-tile-details');
        const operation = element('span', 'server-tile-operation');
        const alert = element('span', 'server-tile-operation');
        const backup = element('span', '');
        copy.append(name, summary);
        info.append(copy, power, feedback);
        infoSensor.append(info);
        visual.append(mark, link, infoSensor);
        tile.append(visual);
        const aura = global.ServerTileAura?.create(visual, server.id === 'abhihardcoreworld'
            ? { imageFit: 'contain', imageBackground: '#2c0805' } : undefined);
        const entry = { tile, link, name, mark, info, infoSensor, copy, power, feedback, summary, badge, population, details, operation, alert, backup, aura };
        power.addEventListener('click', () => togglePower(entry));
        return entry;
    }
    function updateThumbnail(entry, server) {
        const imagePath = server.thumbnailUrl || (Object.hasOwn(tileImages, server.id) ? tileImages[server.id] : null);
        if (imagePath !== entry.imagePath) {
            // Only a new URL retries an image: regular status polls preserve both
            // decoded artwork and the initial fallback after a failed request.
            entry.imagePath = imagePath;
            entry.mark.classList.remove('has-image');
            if (imagePath) {
                const thumbnail = element('img', 'server-tile-thumbnail');
                thumbnail.alt = '';
                thumbnail.decoding = 'async';
                thumbnail.addEventListener('error', () => {
                    if (entry.mark.firstElementChild !== thumbnail) return;
                    entry.aura?.setArtwork(null, entry.name.textContent);
                    entry.mark.classList.remove('has-image');
                    updateText(entry.mark, entry.name.textContent.slice(0, 1).toUpperCase());
                }, { once: true });
                thumbnail.src = imagePath;
                entry.mark.classList.add('has-image');
                entry.mark.replaceChildren(thumbnail);
            }
        }
        if (!entry.mark.classList.contains('has-image')) updateText(entry.mark, server.displayName.slice(0, 1).toUpperCase());
        entry.aura?.setArtwork(entry.mark.classList.contains('has-image') ? imagePath : null, server.displayName);
    }
    function lifecycleOperation(server) {
        return typeof server.operation === 'string' ? server.operation : server.operation?.type;
    }
    function closeSlotPopup() {
        if (!openSlotPopup) return;
        const { entry, popup } = openSlotPopup;
        const restoreFocus = popup.contains(document.activeElement);
        popup.remove();
        entry.power.setAttribute('aria-expanded', 'false');
        entry.tile.classList.remove('has-slot-popup');
        openSlotPopup = null;
        if (restoreFocus) entry.power.focus({ preventScroll: true });
    }
    function showSlotMessage(entry, message = `All ${sharedSlots.limit || 2} server slots are occupied. Stop a server before starting another.`) {
        closeSlotPopup();
        if (document.body.dataset.uiTheme !== 'glass') {
            global.alert(message);
            return;
        }
        const popup = element('div', 'server-slot-popup');
        popup.id = `server-slot-popup-${entry.server.id}`;
        popup.setAttribute('role', 'status');
        const text = element('p', 'server-slot-popup-message', message);
        const close = element('button', 'server-slot-popup-close');
        const closeIcon = element('span', 'server-slot-popup-close-icon');
        closeIcon.setAttribute('aria-hidden', 'true');
        close.append(closeIcon);
        close.type = 'button';
        close.setAttribute('aria-label', 'Dismiss server slot message');
        close.setAttribute('data-no-pointer-lighting', '');
        close.addEventListener('click', closeSlotPopup);
        popup.append(text, close);
        entry.infoSensor.append(popup);
        entry.power.setAttribute('aria-controls', popup.id);
        entry.power.setAttribute('aria-expanded', 'true');
        entry.tile.classList.add('has-slot-popup');
        openSlotPopup = { entry, popup };
    }
    function updatePower(entry) {
        const { server, power, pending } = entry;
        const description = describeState(server);
        const phases = { start: 'Starting', stop: 'Stopping', restart: 'Restarting' };
        const phase = phases[pending] || (['Starting', 'Stopping', 'Restarting'].includes(description) ? description : '')
            || phases[lifecycleOperation(server)] || '';
        const action = phase === 'Starting' ? 'start' : phase ? 'stop' : server.status?.running ? 'stop' : 'start';
        power.dataset.action = action;
        power.disabled = Boolean(phase || server.operation || server.status?.updateInProgress
            || !['Online', 'Offline'].includes(description) || nodes.tiles.classList.contains('is-stale'));
        entry.slotsFull = action === 'start' && !power.disabled
            && sharedSlots.occupied >= (sharedSlots.limit || 2) && !sharedSlots.canBypass;
        power.classList.toggle('is-slot-blocked', entry.slotsFull);
        // Keep the control focusable/clickable so it can explain why starting is unavailable.
        power.setAttribute('aria-disabled', String(power.disabled || entry.slotsFull));
        if (!entry.slotsFull && openSlotPopup?.entry === entry) closeSlotPopup();
        power.setAttribute('aria-busy', String(Boolean(phase)));
        const label = phase ? `${phase} ${server.displayName}`
            : `${action === 'start' ? 'Start' : 'Stop'} ${server.displayName}`;
        power.setAttribute('aria-label', label);
        power.title = entry.slotsFull ? `${label} — all server slots are occupied`
            : power.disabled && !phase ? `${label} — waiting for server availability` : label;
        const displayedState = phase || description;
        updateText(entry.badge, displayedState);
        entry.tile.dataset.state = displayedState === 'Online' ? 'online' : displayedState === 'Offline' ? 'offline' : 'busy';
    }
    async function togglePower(entry) {
        if (entry.power.disabled || entry.pending) return;
        if (entry.slotsFull) {
            if (openSlotPopup?.entry === entry) closeSlotPopup();
            else showSlotMessage(entry);
            return;
        }
        const action = entry.power.dataset.action;
        let slotError = null;
        entry.pending = action;
        updateText(entry.feedback, '');
        updatePower(entry);
        try {
            const response = await fetch(`/api/servers/${encodeURIComponent(entry.server.id)}/${action}`, {
                method: 'POST', credentials: 'same-origin',
                headers: { Authorization: `Bearer ${localStorage.getItem('token') || ''}` }
            });
            if (response.status === 401) { global.ServerContext.clearAll(); global.location.replace('/'); return; }
            if (response.status === 428) { global.location.replace('/set-password.html'); return; }
            if (!response.ok) {
                const body = await response.text();
                let message = body;
                try {
                    const error = JSON.parse(body);
                    message = error.error?.message || error.message || body;
                    if (error.error?.code === 'SERVER_SLOTS_FULL' || error.code === 'SERVER_SLOTS_FULL') slotError = message;
                } catch (_) { /* Plain-text lifecycle errors are also supported. */ }
                throw new Error(message || `Could not ${action} ${entry.server.displayName}.`);
            }
            updateText(entry.feedback, '');
        } catch (error) {
            if (!slotError) updateText(entry.feedback, error.message || 'Could not connect to the server.');
        } finally {
            // Finish any older poll, then read the authoritative state after the command.
            if (refreshPromise) await refreshPromise;
            await refresh();
            entry.pending = null;
            updatePower(entry);
            if (slotError && tilesById.has(entry.server.id)) showSlotMessage(entry, slotError);
        }
    }
    function updateTile(entry, server, index) {
        const { tile, link, name, copy, summary, badge, population, details, operation, alert, backup } = entry;
        entry.server = server;
        updatePower(entry);
        if (entry.index !== index) {
            tile.style.setProperty('--tile-index', index);
            entry.index = index;
        }
        const online = Boolean(server.status?.running);
        updateText(name, server.displayName);
        const label = `${server.displayName} control panel`;
        if (link.getAttribute('aria-label') !== label) link.setAttribute('aria-label', label);
        updateThumbnail(entry, server);
        const players = server.playerCount ?? server.status?.playerCount;
        const showPlayers = Number.isInteger(players) && online;
        updateText(population, showPlayers ? `${players} player${players === 1 ? '' : 's'}` : '');
        syncChildren(summary, showPlayers ? [badge, population] : [badge]);
        const isLifecycle = ['start', 'stop', 'restart'].includes(lifecycleOperation(server));
        updateText(operation, server.operation && !isLifecycle ? (typeof server.operation === 'string' ? server.operation : server.operation.label || server.operation.type || 'Operation in progress') : '');
        updateText(alert, server.alert ? (typeof server.alert === 'string' ? server.alert : 'Attention needed') : '');
        let backupText = '';
        if (server.lastBackupAt) {
            const date = new Date(server.lastBackupAt);
            if (Number.isFinite(date.getTime())) backupText = `Last backup ${date.toLocaleDateString()}`;
        }
        updateText(backup, backupText);
        syncChildren(details, [operation, alert, backup].filter(node => node.textContent));
        syncChildren(copy, details.childElementCount ? [name, summary, details] : [name, summary]);
    }
    function showEmpty(message) {
        updateText(nodes.empty, message);
        syncChildren(nodes.tiles, [nodes.empty]);
    }
    function renderServers(servers, nextIds) {
        const activeElement = document.activeElement;
        const activeEntry = Array.from(tilesById.values()).find(entry => entry.tile.contains(activeElement));
        for (const id of tilesById.keys()) if (!nextIds.has(id)) {
            if (openSlotPopup?.entry === tilesById.get(id)) closeSlotPopup();
            tilesById.get(id).aura?.destroy();
            tilesById.delete(id);
        }
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
        // Fallback artwork colors depend on final nth-child order after reconciliation.
        for (const entry of tilesById.values()) entry.aura?.refreshAppearance?.();
        if (activeEntry && tilesById.has(activeEntry.server.id) && activeEntry.tile.contains(activeElement)
            && document.activeElement !== activeElement) activeElement.focus({ preventScroll: true });
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
    function refresh(options = {}) {
        if (!refreshPromise) refreshPromise = fetchServers(options).finally(() => { refreshPromise = null; });
        return refreshPromise;
    }
    async function fetchServers({ manual = false } = {}) {
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
            nodes.tiles.classList.remove('is-stale');
            sharedSlots = payload.slots || {};
            renderServers(servers, nextIds);
            const slots = sharedSlots;
            updateText(nodes.slots, `${slots.occupied ?? '—'} / ${slots.limit ?? 2} shared slots in use${slots.canBypass ? ' · Admin override available' : ''}`);
            showNotice(new URLSearchParams(location.search).has('unavailable') ? 'That server is no longer available to your account.' : '');
            lastSuccess = new Date();
            if (nodes.tiles.classList.contains('is-stale')) nodes.tiles.classList.remove('is-stale');
        } catch (error) {
            if (error.name !== 'AbortError') {
                showNotice(lastSuccess ? 'Connection interrupted. Server details below may be out of date.' : error.message);
                if (!nodes.tiles.classList.contains('is-stale')) nodes.tiles.classList.add('is-stale');
                tilesById.forEach(updatePower);
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
    document.addEventListener('click', event => {
        if (openSlotPopup && !openSlotPopup.popup.contains(event.target) && !openSlotPopup.entry.power.contains(event.target)) closeSlotPopup();
    });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && openSlotPopup) {
            event.preventDefault();
            closeSlotPopup();
        }
    });
    document.addEventListener('visibilitychange', () => { if (!document.hidden && nodes.tiles) refresh(); });
})(window);
