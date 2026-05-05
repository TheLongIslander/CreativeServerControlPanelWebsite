/*
 * Purpose: Admin user management UI logic.
 */
let currentUser = null;
const updateHistorySummariesByRunId = new Map();

function redirectToLogin() {
    localStorage.removeItem('token');
    window.location.href = '/';
}

function redirectToSetPassword() {
    window.location.href = '/set-password.html';
}

async function loadCurrentUser() {
    const token = localStorage.getItem('token');
    if (!token) {
        redirectToLogin();
        return null;
    }

    const res = await fetch('/me', {
        headers: {
            'Authorization': 'Bearer ' + token
        }
    });

    if (!res.ok) {
        redirectToLogin();
        return null;
    }

    const user = await res.json();
    if (user.mustResetPassword) {
        redirectToSetPassword();
        return null;
    }

    if (user.role !== 'admin') {
        window.location.href = '/index.html';
        return null;
    }

    return user;
}


function formatDate(value) {
    if (!value) {
        return 'Never';
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return value;
    }
    return date.toLocaleString();
}

function isModalVisible(modalId) {
    const modal = document.getElementById(modalId);
    return Boolean(modal && !modal.classList.contains('hidden'));
}

function syncModalOpenState() {
    const hasVisibleModal = isModalVisible('update-summary-modal');
    document.body.classList.toggle('modal-open', hasVisibleModal);
}

function closeUpdateSummaryModal() {
    const modal = document.getElementById('update-summary-modal');
    if (!modal) {
        return;
    }
    modal.classList.add('hidden');
    modal.setAttribute('aria-hidden', 'true');
    syncModalOpenState();
}

function buildTempPasswordRow(tempPassword) {
    const wrapper = document.createElement('div');
    wrapper.classList.add('temp-password-row');

    const code = document.createElement('span');
    code.classList.add('temp-password-code');
    code.textContent = tempPassword;

    const copyButton = document.createElement('button');
    copyButton.type = 'button';
    copyButton.classList.add('copy-button');
    const label = document.createElement('span');
    label.classList.add('copy-label');
    label.textContent = 'Copy';
    copyButton.appendChild(label);
    copyButton.addEventListener('click', () => copyToClipboard(tempPassword, copyButton, wrapper));

    wrapper.appendChild(code);
    wrapper.appendChild(copyButton);

    return wrapper;
}

async function fetchUsers() {
    const token = localStorage.getItem('token');
    const res = await fetch('/admin/users', {
        headers: {
            'Authorization': 'Bearer ' + token
        }
    });

    if (res.status === 428) {
        redirectToSetPassword();
        return [];
    }

    if (res.status === 401 || res.status === 403) {
        redirectToLogin();
        return [];
    }

    if (!res.ok) {
        throw new Error('Failed to load users');
    }

    return res.json();
}

async function fetchUpdateHistory() {
    const token = localStorage.getItem('token');
    const res = await fetch('/admin/updates?limit=200', {
        headers: {
            'Authorization': 'Bearer ' + token
        }
    });

    if (res.status === 428) {
        redirectToSetPassword();
        return [];
    }

    if (res.status === 401 || res.status === 403) {
        redirectToLogin();
        return [];
    }

    if (!res.ok) {
        throw new Error('Failed to load update history');
    }

    return res.json();
}

function formatUpdateModeLabel(mode, operation = 'update') {
    if (operation === 'downgrade') {
        switch (mode) {
            case 'server_and_compatible_mods':
                return 'Downgrade + Compatible Mods';
            case 'server_only_move_all_mods':
                return 'Downgrade + Move Mods';
            default:
                return mode || 'Unknown';
        }
    }
    switch (mode) {
        case 'server_and_compatible_mods':
            return 'Server + Compatible Mods';
        case 'server_only_move_all_mods':
            return 'Server Only (Move Mods)';
        case 'restore_latest_snapshot':
            return 'Restore Snapshot';
        default:
            return mode || 'Unknown';
    }
}

function extractFileName(filePath) {
    if (!filePath) {
        return 'unknown-file';
    }
    const parts = String(filePath).split(/[\\/]/g);
    return parts[parts.length - 1] || String(filePath);
}

function formatSummaryMode(mode, operation = 'update') {
    if (operation === 'downgrade') {
        if (mode === 'server_only_move_all_mods') {
            return 'Downgrade server only and move all mods';
        }
        if (mode === 'server_and_compatible_mods') {
            return 'Downgrade server and keep only compatible mods';
        }
    }
    if (mode === 'server_only_move_all_mods') {
        return 'Update server only and move all mods';
    }
    if (mode === 'server_and_compatible_mods') {
        return 'Update server and keep only compatible mods';
    }
    return mode || 'Unknown mode';
}

function formatMoveReason(reason) {
    const map = {
        blocked: 'incompatible with target',
        unknown: 'compatibility unknown',
        server_only_mode: 'server-only mode',
        replaced_by_update: 'replaced by newer version'
    };
    return map[reason] || reason || 'moved';
}

function appendSummarySection(container, title, items, tone = '') {
    const section = document.createElement('section');
    section.className = `update-summary-section${tone ? ` ${tone}` : ''}`;
    const heading = document.createElement('h3');
    heading.textContent = title;
    section.appendChild(heading);

    if (!items || items.length === 0) {
        const emptyText = document.createElement('p');
        emptyText.className = 'update-summary-empty';
        emptyText.textContent = 'None.';
        section.appendChild(emptyText);
        container.appendChild(section);
        return;
    }

    const list = document.createElement('ul');
    items.forEach(itemText => {
        const li = document.createElement('li');
        li.textContent = itemText;
        list.appendChild(li);
    });
    section.appendChild(list);
    container.appendChild(section);
}

function openUpdateSummaryModal(result) {
    const modal = document.getElementById('update-summary-modal');
    const content = document.getElementById('update-summary-content');
    const title = document.getElementById('update-summary-title');
    if (!modal || !content || !title) {
        return;
    }

    content.innerHTML = '';
    const updatedMods = Array.isArray(result && result.updatedMods) ? result.updatedMods : [];
    const movedMods = Array.isArray(result && result.movedMods) ? result.movedMods : [];
    const notUpdatedMods = movedMods.filter(mod => mod.reason !== 'replaced_by_update');
    const preCount = Array.isArray(result && result.preModManifest) ? result.preModManifest.length : null;
    const postCount = Array.isArray(result && result.postModManifest) ? result.postModManifest.length : null;
    const operation = result && result.operation === 'downgrade' ? 'downgrade' : 'update';

    title.textContent = result && result.succeeded === false
        ? `${operation === 'downgrade' ? 'Downgrade' : 'Update'} Failed Summary`
        : `${operation === 'downgrade' ? 'Downgrade' : 'Update'} Summary`;

    const overview = document.createElement('section');
    overview.className = 'update-summary-section';
    const overviewTitle = document.createElement('h3');
    overviewTitle.textContent = 'Overview';
    overview.appendChild(overviewTitle);

    const overviewLines = [
        `Server version: ${result && result.targetVersion ? result.targetVersion : 'unknown'}`,
        `Operation: ${operation}`,
        `Mode: ${formatSummaryMode(result && result.mode, operation)}`,
        `Mods updated: ${updatedMods.length}`,
        `Mods not updated: ${notUpdatedMods.length}`,
        `Archive folder: ${result && result.archiveDir ? result.archiveDir : 'Not created'}`,
        `Snapshot: ${result && result.snapshotPath ? result.snapshotPath : 'Not recorded'}`
    ];
    if (preCount != null && postCount != null) {
        overviewLines.push(`Mods folder count: ${preCount} before -> ${postCount} after`);
    }
    overviewLines.forEach(line => {
        const p = document.createElement('p');
        p.className = 'update-summary-meta';
        p.textContent = line;
        overview.appendChild(p);
    });
    content.appendChild(overview);

    appendSummarySection(
        content,
        'Mods Updated',
        updatedMods.map(mod => {
            const name = mod.modId || mod.fileName || 'mod';
            const fromVersion = mod.fromVersion || 'unknown';
            const toVersion = mod.toVersion || 'latest';
            const fileName = mod.fileName || 'unknown-file';
            return `${name}: ${fromVersion} -> ${toVersion} (${fileName})`;
        }),
        'is-updated'
    );

    if (notUpdatedMods.length > 0) {
        appendSummarySection(
            content,
            'Mods Not Updated',
            notUpdatedMods.map(mod => {
                const fileName = extractFileName(mod.from);
                const reason = formatMoveReason(mod.reason);
                const destination = mod.to || 'unknown destination';
                return `${fileName}: ${reason} -> ${destination}`;
            }),
            'is-not-updated'
        );
    }

    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');
    syncModalOpenState();
}

function openUpdateSummaryFromRun(run) {
    if (!run || !run.id) {
        return;
    }
    const summary = updateHistorySummariesByRunId.get(run.id);
    if (!summary || typeof summary !== 'object') {
        alert('No detailed summary is available for this run.');
        return;
    }
    const result = {
        ...summary,
        mode: summary.mode || run.mode || null,
        operation: summary.operation || run.operation || 'update',
        targetVersion: summary.targetVersion || run.targetVersion || null
    };
    openUpdateSummaryModal(result);
}

function renderUpdateHistory(runs) {
    const tbody = document.getElementById('update-history-table-body');
    const empty = document.getElementById('update-history-empty');
    if (!tbody || !empty) {
        return;
    }

    tbody.innerHTML = '';
    updateHistorySummariesByRunId.clear();
    empty.textContent = 'No update history runs recorded yet.';
    if (!Array.isArray(runs) || runs.length === 0) {
        empty.classList.remove('hidden');
        return;
    }
    empty.classList.add('hidden');

    runs.forEach(run => {
        const row = document.createElement('tr');

        const startedAt = run.startedAt || run.createdAt || null;
        const startedCell = document.createElement('td');
        startedCell.textContent = formatDate(startedAt);
        startedCell.title = startedCell.textContent;

        const actorCell = document.createElement('td');
        actorCell.textContent = run.actorUsername || 'Unknown';
        actorCell.title = actorCell.textContent;

        const targetCell = document.createElement('td');
        targetCell.textContent = run.versionPath || (run.targetVersion || 'N/A');
        targetCell.title = targetCell.textContent;

        const modeCell = document.createElement('td');
        const modeText = run.modeLabel || formatUpdateModeLabel(run.mode, run.operation || 'update');
        modeCell.title = modeText;
        const modeSpan = document.createElement('span');
        modeSpan.classList.add('mode-text');
        modeSpan.textContent = modeText;
        modeCell.appendChild(modeSpan);

        const statusCell = document.createElement('td');
        const statusBadge = document.createElement('span');
        const status = run.status || 'unknown';
        statusBadge.classList.add('status-pill', `status-${status}`);
        statusBadge.textContent = status;
        statusCell.appendChild(statusBadge);

        const updatedCell = document.createElement('td');
        updatedCell.textContent = String(Number.isFinite(run.modsUpdatedCount) ? run.modsUpdatedCount : 0);

        const notUpdatedCell = document.createElement('td');
        notUpdatedCell.textContent = String(Number.isFinite(run.modsNotUpdatedCount) ? run.modsNotUpdatedCount : 0);

        const noteCell = document.createElement('td');
        noteCell.classList.add('update-note-cell');
        if (run.summary && typeof run.summary === 'object') {
            updateHistorySummariesByRunId.set(run.id, run.summary);
            const summaryButton = document.createElement('button');
            summaryButton.type = 'button';
            summaryButton.classList.add('view-summary-button');
            summaryButton.textContent = 'View Summary';
            summaryButton.addEventListener('click', () => openUpdateSummaryFromRun(run));
            noteCell.appendChild(summaryButton);
        } else if (run.notes) {
            noteCell.textContent = run.notes;
        } else {
            noteCell.textContent = 'Summary unavailable';
        }

        row.appendChild(startedCell);
        row.appendChild(actorCell);
        row.appendChild(targetCell);
        row.appendChild(modeCell);
        row.appendChild(statusCell);
        row.appendChild(updatedCell);
        row.appendChild(notUpdatedCell);
        row.appendChild(noteCell);

        tbody.appendChild(row);
    });
}

function getStatusLabel(user) {
    if (user.disabled) {
        return 'Disabled';
    }
    if (user.lockedUntil && new Date(user.lockedUntil) > new Date()) {
        return `Locked until ${formatDate(user.lockedUntil)}`;
    }
    if (user.mustResetPassword) {
        return 'Onboarding required';
    }
    return 'User onboarded';
}

function renderUsers(users) {
    const tbody = document.getElementById('users-table-body');
    tbody.innerHTML = '';

    users.forEach(user => {
        const isProtected = user.username.toLowerCase() === 'admin' || user.id === currentUser.id;

        const row = document.createElement('tr');
        row.classList.add('user-row');

        const statusCell = document.createElement('td');
        statusCell.textContent = getStatusLabel(user);

        const tempCell = document.createElement('td');
        if (user.mustResetPassword && user.tempPassword) {
            tempCell.appendChild(buildTempPasswordRow(user.tempPassword));
        } else {
            tempCell.textContent = 'User onboarded';
        }

        const usernameCell = document.createElement('td');
        const usernameButton = document.createElement('button');
        usernameButton.type = 'button';
        usernameButton.classList.add('user-toggle');
        usernameButton.setAttribute('aria-expanded', 'false');
        usernameButton.innerHTML = `<span>${user.username}</span><span class="chevron">▸</span>`;
        usernameCell.appendChild(usernameButton);

        const lastLoginCell = document.createElement('td');
        if (user.lastLoginAt) {
            const lastLoginButton = document.createElement('button');
            lastLoginButton.type = 'button';
            lastLoginButton.classList.add('login-history-link', 'has-history');
            lastLoginButton.textContent = formatDate(user.lastLoginAt);
            lastLoginButton.addEventListener('click', () => openLoginHistory(user));
            lastLoginCell.appendChild(lastLoginButton);
        } else {
            const neverValue = document.createElement('span');
            neverValue.classList.add('never-value');
            neverValue.textContent = 'Never';
            lastLoginCell.appendChild(neverValue);
        }

        const lastResetCell = document.createElement('td');
        const lastReset = formatDate(user.lastPasswordResetAt);
        if (lastReset === 'Never') {
            const neverValue = document.createElement('span');
            neverValue.classList.add('never-value');
            neverValue.textContent = lastReset;
            lastResetCell.appendChild(neverValue);
        } else {
            lastResetCell.textContent = lastReset;
        }

        const createdCell = document.createElement('td');
        createdCell.textContent = formatDate(user.createdAt);

        row.appendChild(usernameCell);
        row.appendChild(statusCell);
        row.appendChild(tempCell);
        row.appendChild(lastLoginCell);
        row.appendChild(lastResetCell);
        row.appendChild(createdCell);
        tbody.appendChild(row);

        const actionsRow = document.createElement('tr');
        actionsRow.classList.add('user-actions-row', 'hidden');
        const actionsCell = document.createElement('td');
        actionsCell.colSpan = 6;

        const actionsPanel = document.createElement('div');
        actionsPanel.classList.add('actions-panel');

        if (isProtected) {
            const protectedTag = document.createElement('span');
            protectedTag.classList.add('protected-tag');
            protectedTag.textContent = 'Protected account';
            actionsPanel.appendChild(protectedTag);
        } else {
            const toggleBtn = document.createElement('button');
            toggleBtn.textContent = user.disabled ? 'Enable' : 'Disable';
            if (!user.disabled) {
                toggleBtn.classList.add('warning');
            }
            toggleBtn.addEventListener('click', () => toggleDisabled(user));

            const resetBtn = document.createElement('button');
            resetBtn.textContent = user.mustResetPassword ? 'Reset Temp Password' : 'Reset Password';
            resetBtn.addEventListener('click', () => resetTempPassword(user));

            const forceLogoutBtn = document.createElement('button');
            forceLogoutBtn.textContent = 'Force Logout';
            forceLogoutBtn.classList.add('neutral');
            forceLogoutBtn.addEventListener('click', () => forceLogout(user));

            const deleteBtn = document.createElement('button');
            deleteBtn.textContent = 'Delete';
            deleteBtn.classList.add('danger');
            deleteBtn.addEventListener('click', () => deleteUser(user));

            actionsPanel.appendChild(toggleBtn);
            actionsPanel.appendChild(resetBtn);
            if (user.lockedUntil && new Date(user.lockedUntil) > new Date()) {
                const unlockBtn = document.createElement('button');
                unlockBtn.textContent = 'Unlock';
                unlockBtn.classList.add('neutral');
                unlockBtn.addEventListener('click', () => unlockUser(user));
                actionsPanel.appendChild(unlockBtn);
            }
            actionsPanel.appendChild(forceLogoutBtn);
            actionsPanel.appendChild(deleteBtn);
        }

        actionsCell.appendChild(actionsPanel);
        actionsRow.appendChild(actionsCell);
        tbody.appendChild(actionsRow);

        usernameButton.addEventListener('click', () => {
            const isOpen = !actionsRow.classList.contains('hidden');
            actionsRow.classList.toggle('hidden');
            usernameButton.setAttribute('aria-expanded', String(!isOpen));
            if (!isOpen) {
                usernameButton.classList.add('expanded');
            } else {
                usernameButton.classList.remove('expanded');
            }
        });
    });
}


function openLoginHistory(user) {
    const params = new URLSearchParams();
    params.set('userId', user.id);
    params.set('username', user.username);
    window.location.href = `/admin-logins.html?${params.toString()}`;
}

async function createUser(username) {
    const token = localStorage.getItem('token');
    const res = await fetch('/admin/users', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + token
        },
        body: JSON.stringify({ username })
    });

    const data = await res.json().catch(() => null);
    if (!res.ok) {
        const message = data && data.message ? data.message : 'Failed to create user';
        throw new Error(message);
    }

    return data;
}

async function toggleDisabled(user) {
    const confirmMsg = user.disabled ? 'Enable this user?' : 'Disable this user?';
    if (!window.confirm(confirmMsg)) {
        return;
    }

    const token = localStorage.getItem('token');
    const res = await fetch(`/admin/users/${user.id}`, {
        method: 'PATCH',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + token
        },
        body: JSON.stringify({ disabled: !user.disabled })
    });

    if (!res.ok) {
        alert('Failed to update user.');
    } else {
        refreshUsers();
    }
}

async function resetTempPassword(user) {
    if (!window.confirm('Reset this user\'s temporary password?')) {
        return;
    }

    const token = localStorage.getItem('token');
    const res = await fetch(`/admin/users/${user.id}/reset-temp-password`, {
        method: 'POST',
        headers: {
            'Authorization': 'Bearer ' + token
        }
    });

    const data = await res.json().catch(() => null);
    if (!res.ok) {
        alert('Failed to reset temp password.');
        return;
    }

    if (data && data.tempPassword) {
        const message = document.getElementById('create-message');
        if (message) {
            message.innerHTML = '';
            const text = document.createElement('span');
            text.textContent = `Temp password reset for ${user.username}:`;
            message.appendChild(text);
            message.appendChild(buildTempPasswordRow(data.tempPassword));
        }
    }
    refreshUsers();
}

async function forceLogout(user) {
    if (!window.confirm(`Force logout ${user.username}?`)) {
        return;
    }

    const token = localStorage.getItem('token');
    const res = await fetch(`/admin/users/${user.id}/force-logout`, {
        method: 'POST',
        headers: {
            'Authorization': 'Bearer ' + token
        }
    });

    if (!res.ok) {
        alert('Failed to force logout.');
        return;
    }

    refreshUsers();
}

async function unlockUser(user) {
    if (!window.confirm(`Unlock ${user.username}?`)) {
        return;
    }

    const token = localStorage.getItem('token');
    const res = await fetch(`/admin/users/${user.id}/unlock`, {
        method: 'POST',
        headers: {
            'Authorization': 'Bearer ' + token
        }
    });

    if (!res.ok) {
        alert('Failed to unlock user.');
        return;
    }

    refreshUsers();
}

async function deleteUser(user) {
    if (!window.confirm('Are you sure you want to delete this user?')) {
        return;
    }
    if (!window.confirm('This cannot be undone. Delete user?')) {
        return;
    }

    const token = localStorage.getItem('token');
    const res = await fetch(`/admin/users/${user.id}`, {
        method: 'DELETE',
        headers: {
            'Authorization': 'Bearer ' + token
        }
    });

    if (!res.ok) {
        alert('Failed to delete user.');
    } else {
        refreshUsers();
    }
}

async function refreshUsers() {
    try {
        const users = await fetchUsers();
        renderUsers(users);
    } catch (err) {
        console.error(err);
        alert('Failed to load users.');
    }
}

async function refreshUpdateHistory() {
    try {
        const runs = await fetchUpdateHistory();
        renderUpdateHistory(runs);
    } catch (err) {
        console.error(err);
        const empty = document.getElementById('update-history-empty');
        if (empty) {
            empty.textContent = 'Failed to load update history.';
            empty.classList.remove('hidden');
        }
    }
}

async function logout() {
    const token = localStorage.getItem('token');
    if (!token) {
        redirectToLogin();
        return;
    }

    await fetch('/logout', {
        method: 'POST',
        headers: {
            'Authorization': 'Bearer ' + token
        }
    }).catch(() => {});

    redirectToLogin();
}

async function copyToClipboard(text, button, container) {
    try {
        await navigator.clipboard.writeText(text);
        if (button) {
            button.dataset.state = 'Copied';
            button.classList.add('copied');
            if (container) {
                container.classList.add('copied');
            }
            window.setTimeout(() => {
                button.classList.remove('copied');
                delete button.dataset.state;
                if (container) {
                    container.classList.remove('copied');
                }
            }, 1200);
        }
    } catch (err) {
        if (button) {
            button.dataset.state = 'Failed';
            button.classList.add('error');
            window.setTimeout(() => {
                button.classList.remove('error');
                delete button.dataset.state;
            }, 1200);
        }
    }
}

document.addEventListener('DOMContentLoaded', async function() {
    currentUser = await loadCurrentUser();
    if (!currentUser) {
        return;
    }
    if (window.Appearance && typeof window.Appearance.init === 'function') {
        window.Appearance.init({
            user: currentUser,
            options: { adminOnly: true }
        });
    }
    refreshUsers();
    refreshUpdateHistory();
    document.getElementById('audit-log-button').addEventListener('click', () => {
        window.location.href = '/admin-audit.html';
    });
    const refreshUpdateHistoryButton = document.getElementById('refresh-update-history-button');
    if (refreshUpdateHistoryButton) {
        refreshUpdateHistoryButton.addEventListener('click', () => {
            refreshUpdateHistory();
        });
    }
    const summaryCloseBtn = document.getElementById('update-summary-close-btn');
    if (summaryCloseBtn) {
        summaryCloseBtn.addEventListener('click', closeUpdateSummaryModal);
    }
    document.querySelectorAll('[data-close-update-summary="true"]').forEach(node => {
        node.addEventListener('click', closeUpdateSummaryModal);
    });

    const form = document.getElementById('create-user-form');
    const message = document.getElementById('create-message');
    form.addEventListener('submit', async function(event) {
        event.preventDefault();
        message.innerHTML = '';

        const usernameInput = document.getElementById('new-username');
        const username = usernameInput.value.trim();
        if (!username) {
            message.textContent = 'Username is required.';
            return;
        }

        try {
            const user = await createUser(username);
            const text = document.createElement('span');
            text.textContent = `User created. Temp password:`;
            message.appendChild(text);
            message.appendChild(buildTempPasswordRow(user.tempPassword));
            usernameInput.value = '';
            refreshUsers();
        } catch (err) {
            message.textContent = err.message;
        }
    });

});
