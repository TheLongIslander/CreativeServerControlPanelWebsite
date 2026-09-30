(function adminServerProfiles(global) {
    'use strict';
    let selected = null;
    let accessId = null;
    let accessGeneration = 0;
    let editGeneration = 0;
    let thumbnailFile = null;
    let thumbnailPreviewUrl = null;
    let thumbnailBusy = false;
    const defaultThumbnails = Object.freeze({ default: '/assets/server-tiles/creative.png', pogeg: '/assets/server-tiles/pogeg-farm.png' });
    const $ = id => document.getElementById(id);
    function notice(message, isError = false) {
        $('server-admin-notice').textContent = message;
        $('server-admin-notice').classList.toggle('profile-error', isError);
    }
    async function api(path = '', options = {}) {
        const multipart = typeof FormData !== 'undefined' && options.body instanceof FormData;
        const response = await fetch(`/admin/servers${path}`, {
            ...options,
            cache: 'no-store',
            headers: { Authorization: `Bearer ${localStorage.getItem('token') || ''}`, ...(multipart ? {} : { 'Content-Type': 'application/json' }) }
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
            details.textContent = `${server.id} · ${server.enabled === false ? 'Disabled' : 'Enabled'} · ${server.status?.state || 'Registered'} · Updates ${server.updatePipelineEnabled === false ? 'disabled' : 'enabled'} · SFTP ${server.sftp?.enabled ? 'configured' : 'not connected'}`;
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
        editGeneration++;
        clearThumbnailFile();
        thumbnailBusy = false;
        $('server-profile-form').classList.add('hidden');
        $('server-access-editor').classList.add('hidden');
        accessId = null;
        accessGeneration++;
        selected = null;
    }
    async function edit(server = null) {
        closeEditors();
        const generation = editGeneration;
        if (server) {
            const payload = await api();
            if (generation !== editGeneration) return;
            server = payload.servers.find(item => item.id === server.id);
            if (!server || server.archived) throw new Error('This server is no longer available.');
        }
        selected = server;
        $('profile-thumbnail-editor').classList.toggle('hidden', !server);
        $('profile-thumbnail-registration-help').classList.toggle('hidden', Boolean(server));
        thumbnailNotice('');
        renderThumbnail();
        const fields = {
            id: server?.id || '', name: server?.displayName || '', root: server?.rootPath || '',
            start: server?.startCommandPath || '', screen: server?.screenSession || '',
            backup: server?.backupRoot || '', timezone: server?.timezone || 'America/New_York',
            java: server?.launch?.javaPath || '', heap: server?.launch?.heapMb || '',
            'initial-heap': server?.launch?.initialHeapMb || ''
        };
        for (const [key, value] of Object.entries(fields)) $(`profile-${key}`).value = value;
        $('profile-id').disabled = Boolean(server);
        $('profile-update-pipeline').checked = server?.updatePipelineEnabled !== false;
        $('profile-enabled').checked = server?.enabled !== false;
        $('profile-ram-override').checked = server?.launch?.ramOverride ?? false;
        ramHelp();
        $('server-profile-form-title').textContent = server ? `Edit ${server.displayName}` : 'Register existing server';
        $('server-profile-form').classList.remove('hidden');
        $('profile-name').focus();
        $('server-profile-form').scrollIntoView({ block: 'nearest' });
    }
    function clearThumbnailFile(resetInput = true) {
        if (thumbnailPreviewUrl) global.URL.revokeObjectURL(thumbnailPreviewUrl);
        thumbnailFile = null;
        thumbnailPreviewUrl = null;
        if (resetInput) $('profile-thumbnail-file').value = '';
    }
    function thumbnailNotice(message, isError = false) {
        $('profile-thumbnail-notice').textContent = message;
        $('profile-thumbnail-notice').classList.toggle('profile-error', isError);
    }
    function thumbnailControls() {
        $('profile-thumbnail-file').disabled = thumbnailBusy;
        $('upload-server-thumbnail').disabled = thumbnailBusy || !thumbnailFile;
        $('remove-server-thumbnail').disabled = thumbnailBusy || !selected?.thumbnailUrl;
        $('remove-server-thumbnail').classList.toggle('hidden', !selected?.thumbnailUrl);
        $('save-server-profile').disabled = thumbnailBusy;
        $('upload-server-thumbnail').textContent = thumbnailBusy ? 'Saving thumbnail…' : 'Upload thumbnail';
    }
    function renderThumbnail() {
        const preview = $('profile-thumbnail-preview');
        const initial = (selected?.displayName || '').slice(0, 1).toUpperCase();
        const url = thumbnailPreviewUrl || selected?.thumbnailUrl || (selected && Object.hasOwn(defaultThumbnails, selected.id) ? defaultThumbnails[selected.id] : null);
        const generation = editGeneration;
        preview.textContent = initial;
        if (url) {
            const image = document.createElement('img');
            image.alt = `${selected.displayName} thumbnail preview`;
            image.addEventListener('error', () => {
                if (generation === editGeneration && preview.firstElementChild === image) preview.textContent = initial;
            }, { once: true });
            image.src = url;
            preview.replaceChildren(image);
        }
        thumbnailControls();
    }
    function chooseThumbnail() {
        const file = $('profile-thumbnail-file').files?.[0];
        clearThumbnailFile(false);
        thumbnailNotice('');
        if (file) {
            if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
                $('profile-thumbnail-file').value = '';
                thumbnailNotice('Choose a JPEG, PNG, or WebP image.', true);
            } else if (!file.size || file.size > 5 * 1024 * 1024) {
                $('profile-thumbnail-file').value = '';
                thumbnailNotice('Choose an image no larger than 5 MiB.', true);
            } else {
                thumbnailFile = file;
                thumbnailPreviewUrl = global.URL.createObjectURL(file);
                thumbnailNotice(`${file.name} selected. Click Upload thumbnail to save it.`);
            }
        }
        renderThumbnail();
    }
    async function saveThumbnail(remove = false) {
        const target = selected;
        if (!target || thumbnailBusy || (!remove && !thumbnailFile)) return;
        const generation = editGeneration;
        const currentEditor = () => generation === editGeneration && selected?.id === target.id;
        const options = { method: remove ? 'DELETE' : 'POST' };
        if (!remove) {
            options.body = new FormData();
            options.body.append('thumbnail', thumbnailFile);
        }
        thumbnailBusy = true;
        thumbnailControls();
        thumbnailNotice(remove ? 'Removing thumbnail…' : 'Uploading thumbnail…');
        try {
            const payload = await api(`/${encodeURIComponent(target.id)}/thumbnail`, options);
            if (!currentEditor()) return;
            selected = { ...selected, thumbnailUrl: payload.server.thumbnailUrl };
            clearThumbnailFile();
            renderThumbnail();
            thumbnailNotice(remove ? 'Thumbnail removed. The server tile uses its default artwork.' : 'Thumbnail saved. Your server tile will update automatically.');
        } catch (error) {
            if (currentEditor()) thumbnailNotice(error.message, true);
        } finally {
            if (currentEditor()) { thumbnailBusy = false; thumbnailControls(); }
        }
    }
    function ramHelp() {
        const override = $('profile-ram-override').checked;
        $('profile-ram-help').textContent = override
            ? 'Panel override: RAM applies only to panel starts. The startup script stays unchanged.'
            : 'Script sync: saving RAM updates the startup script. Blank fields keep the script values. Reopen this editor to read file changes.';
        if (!override && selected?.scriptHeap?.error) $('profile-ram-help').textContent += ` ${selected.scriptHeap.error}`;
    }
    async function save(event) {
        event.preventDefault();
        if (thumbnailBusy) return;
        const target = selected;
        const get = name => $(`profile-${name}`).value.trim();
        const payload = {
            displayName: get('name'), rootPath: get('root'), startCommandPath: get('start'),
            screenSession: get('screen'), backupRoot: get('backup') || null, timezone: get('timezone'),
            enabled: $('profile-enabled').checked,
            updatePipelineEnabled: $('profile-update-pipeline').checked,
            launch: { ramOverride: $('profile-ram-override').checked, javaPath: get('java') || null, heapMb: get('heap') ? Number(get('heap')) : null, initialHeapMb: get('initial-heap') ? Number(get('initial-heap')) : null }
        };
        if (!target) { payload.id = get('id'); payload.sftp = { enabled: false, rootPath: null }; }
        else {
            payload.revision = target.revision;
            if (get('start') === target.startCommandPath) payload.scriptRevision = target.scriptHeap?.revision || null;
        }
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
            text.textContent = `Server access · ${user.username}${user.role === 'admin' ? ' · Admin (always allowed)' : ''}${user.disabled ? ' · Account disabled' : ''}`;
            checkbox.addEventListener('change', async () => {
                const allowed = checkbox.checked;
                checkbox.disabled = true;
                permissions.disabled = true;
                try {
                    // Capture the original profile; opening another editor cannot retarget this write.
                    await api(`/${encodeURIComponent(server.id)}/access`, { method: 'PATCH', body: JSON.stringify({ userId: user.id, allowed }) });
                    if (accessId === server.id) notice(`${user.username} ${allowed ? 'can access' : 'is restricted from'} ${server.displayName}.`);
                } catch (error) { checkbox.checked = !allowed; notice(error.message, true); }
                finally { checkbox.disabled = false; permissions.disabled = !checkbox.checked; }
            });
            label.append(checkbox, text);
            const row = document.createElement('details');
            row.className = 'server-permission-user';
            const summary = document.createElement('summary');
            summary.textContent = user.username + (user.role === 'admin' ? ' · Admin — full access' : ' · Permissions');
            row.append(summary, label);
            const permissions = document.createElement('fieldset');
            const legend = document.createElement('legend');
            legend.textContent = 'Allowed features';
            permissions.append(legend);
            permissions.disabled = user.role === 'admin' || !checkbox.checked;
            for (const [key, title] of Object.entries(payload.permissionDefinitions || {})) {
                const feature = document.createElement('label');
                feature.className = 'server-access-user';
                const toggle = document.createElement('input');
                toggle.type = 'checkbox';
                toggle.checked = user.permissions?.[key] !== false;
                toggle.addEventListener('change', async () => {
                    const allowed = toggle.checked;
                    toggle.disabled = true;
                    try {
                        await api(`/${encodeURIComponent(server.id)}/permissions`, { method: 'PATCH', body: JSON.stringify({ userId: user.id, permissions: { [key]: allowed } }) });
                        if (accessId === server.id) notice(`${title} ${allowed ? 'enabled' : 'disabled'} for ${user.username} on ${server.displayName}.`);
                    } catch (error) { toggle.checked = !allowed; notice(error.message, true); }
                    finally { toggle.disabled = false; }
                });
                feature.append(toggle, document.createTextNode(title));
                permissions.append(feature);
            }
            row.append(permissions);
            fragment.append(row);
        }
        $('server-access-users').replaceChildren(fragment);
        $('server-access-editor').scrollIntoView({ block: 'nearest' });
    }
    global.AdminServers = Object.freeze({ async init() {
        $('add-server-profile').addEventListener('click', () => edit());
        $('profile-ram-override').addEventListener('change', ramHelp);
        $('profile-thumbnail-file').addEventListener('change', chooseThumbnail);
        $('upload-server-thumbnail').addEventListener('click', () => saveThumbnail());
        $('remove-server-thumbnail').addEventListener('click', () => saveThumbnail(true));
        $('cancel-server-profile').addEventListener('click', closeEditors);
        $('close-server-access').addEventListener('click', closeEditors);
        $('server-profile-form').addEventListener('submit', save);
        await refresh().catch(error => notice(error.message, true));
    } });
})(window);
