(function adminServerProfiles(global) {
    'use strict';
    let selected = null;
    let accessId = null;
    let accessGeneration = 0;
    const $ = id => document.getElementById(id);
    function notice(message, isError = false) {
        $('server-admin-notice').textContent = message;
        $('server-admin-notice').classList.toggle('profile-error', isError);
    }
    async function api(path = '', options = {}) {
        const response = await fetch(`/admin/servers${path}`, {
            ...options,
            cache: 'no-store',
            headers: { Authorization: `Bearer ${localStorage.getItem('token') || ''}`, 'Content-Type': 'application/json' }
        });
        const payload = await response.json().catch(() => ({}));
        if (response.status === 401) { global.ServerContext?.clearAll(); global.location.replace('/'); }
        if (response.status === 428) global.location.replace('/set-password.html');
        if (!response.ok) throw new Error(payload.error?.message || payload.message || `Request failed (${response.status}).`);
        return payload;
    }
    function button(label, action) {
        const result = document.createElement('button');
        result.type = 'button';
        result.textContent = label;
        result.addEventListener('click', async () => {
            result.disabled = true;
            try { await action(); } catch (error) { notice(error.message, true); }
            finally { result.disabled = false; }
        });
        return result;
    }
    async function refresh() {
        const payload = await api();
        const historySelector = $('update-history-server');
        const previousHistoryId = historySelector.value;
        historySelector.replaceChildren();
        for (const server of payload.servers || []) {
            if (server.archived || server.enabled === false) continue;
            const option = document.createElement('option');
            option.value = server.id; option.textContent = server.displayName;
            historySelector.append(option);
        }
        if (Array.from(historySelector.options).some(option => option.value === previousHistoryId)) historySelector.value = previousHistoryId;
        if (previousHistoryId && historySelector.value !== previousHistoryId) historySelector.dispatchEvent(new Event('change'));
        const fragment = document.createDocumentFragment();
        for (const server of payload.servers || []) {
            if (server.archived) continue;
            const row = document.createElement('article');
            row.className = 'server-profile-row';
            const copy = document.createElement('div');
            const name = document.createElement('strong');
            name.textContent = server.displayName;
            const details = document.createElement('p');
            details.textContent = `${server.id} · ${server.enabled === false ? 'Disabled' : 'Enabled'} · ${server.status?.state || 'Registered'} · SFTP ${server.sftp?.enabled ? 'configured' : 'not connected'}`;
            copy.append(name, details);
            const actions = document.createElement('div');
            actions.className = 'profile-actions';
            actions.append(button('Edit profile', () => edit(server)), button('User access', () => access(server)), button('Remove', async () => {
                if (!confirm(`Remove ${server.displayName} from the panel? It must be stopped. Its files, backups, and history will be preserved.`)) return;
                await api(`/${encodeURIComponent(server.id)}`, { method: 'DELETE', body: JSON.stringify({ revision: server.revision }) });
                closeEditors();
                notice(`${server.displayName} was removed from the panel. Its files and history are preserved.`);
                await refresh();
            }));
            row.append(copy, actions);
            fragment.append(row);
        }
        if (!fragment.childNodes.length) {
            const empty = document.createElement('p');
            empty.textContent = 'No server profiles yet. Register an existing server to get started.';
            fragment.append(empty);
        }
        $('server-profile-list').replaceChildren(fragment);
    }
    function closeEditors() {
        $('server-profile-form').classList.add('hidden');
        $('server-access-editor').classList.add('hidden');
        accessId = null;
        accessGeneration++;
        selected = null;
    }
    function edit(server = null) {
        closeEditors();
        selected = server;
        const fields = {
            id: server?.id || '', name: server?.displayName || '', root: server?.rootPath || '',
            start: server?.startCommandPath || '', screen: server?.screenSession || '',
            backup: server?.backupRoot || '', timezone: server?.timezone || 'America/New_York',
            java: server?.launch?.javaPath || '', heap: server?.launch?.heapMb || '',
            'initial-heap': server?.launch?.initialHeapMb || ''
        };
        for (const [key, value] of Object.entries(fields)) $(`profile-${key}`).value = value;
        $('profile-id').disabled = Boolean(server);
        $('profile-enabled').checked = server?.enabled !== false;
        $('server-profile-form-title').textContent = server ? `Edit ${server.displayName}` : 'Register existing server';
        $('server-profile-form').classList.remove('hidden');
        $('profile-name').focus();
        $('server-profile-form').scrollIntoView({ block: 'nearest' });
    }
    async function save(event) {
        event.preventDefault();
        const target = selected;
        const get = name => $(`profile-${name}`).value.trim();
        const payload = {
            displayName: get('name'), rootPath: get('root'), startCommandPath: get('start'),
            screenSession: get('screen'), backupRoot: get('backup') || null, timezone: get('timezone'),
            enabled: $('profile-enabled').checked,
            launch: { javaPath: get('java') || null, heapMb: get('heap') ? Number(get('heap')) : null, initialHeapMb: get('initial-heap') ? Number(get('initial-heap')) : null }
        };
        if (!target) { payload.id = get('id'); payload.sftp = { enabled: false, rootPath: null }; }
        else payload.revision = target.revision;
        const saveButton = $('save-server-profile');
        saveButton.disabled = true;
        try {
            await api(target ? `/${encodeURIComponent(target.id)}` : '', { method: target ? 'PATCH' : 'POST', body: JSON.stringify(payload) });
            closeEditors();
            notice(`${payload.displayName} profile saved.`);
            await refresh();
        } catch (error) { notice(error.message, true); }
        finally { saveButton.disabled = false; }
    }
    async function access(server) {
        closeEditors();
        accessId = server.id;
        const generation = ++accessGeneration;
        $('server-access-title').textContent = `${server.displayName} — user access`;
        $('server-access-users').textContent = 'Loading users…';
        $('server-access-editor').classList.remove('hidden');
        const payload = await api(`/${encodeURIComponent(server.id)}/access`);
        if (generation !== accessGeneration) return;
        const fragment = document.createDocumentFragment();
        for (const user of payload.users || []) {
            const label = document.createElement('label');
            label.className = 'server-access-user';
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.checked = user.allowed !== false;
            checkbox.disabled = user.role === 'admin';
            const text = document.createElement('span');
            text.textContent = `${user.username}${user.role === 'admin' ? ' · Admin (always allowed)' : ''}${user.disabled ? ' · Account disabled' : ''}`;
            checkbox.addEventListener('change', async () => {
                const allowed = checkbox.checked;
                checkbox.disabled = true;
                try {
                    // Capture the original profile; opening another editor cannot retarget this write.
                    await api(`/${encodeURIComponent(server.id)}/access`, { method: 'PATCH', body: JSON.stringify({ userId: user.id, allowed }) });
                    if (accessId === server.id) notice(`${user.username} ${allowed ? 'can access' : 'is restricted from'} ${server.displayName}.`);
                } catch (error) { checkbox.checked = !allowed; notice(error.message, true); }
                finally { checkbox.disabled = false; }
            });
            label.append(checkbox, text);
            fragment.append(label);
        }
        $('server-access-users').replaceChildren(fragment);
        $('server-access-editor').scrollIntoView({ block: 'nearest' });
    }
    global.AdminServers = Object.freeze({ async init() {
        $('add-server-profile').addEventListener('click', () => edit());
        $('cancel-server-profile').addEventListener('click', closeEditors);
        $('close-server-access').addEventListener('click', closeEditors);
        $('server-profile-form').addEventListener('submit', save);
        await refresh().catch(error => notice(error.message, true));
    } });
})(window);
