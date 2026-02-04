/*
 * Purpose: Admin audit log page logic.
 */
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

function setupAccountMenu() {
    const accountButton = document.getElementById('account-button');
    const dropdown = document.getElementById('account-dropdown');
    const logoutButton = document.getElementById('logout-button');
    const resetButton = document.getElementById('reset-password-button');

    accountButton.addEventListener('click', (event) => {
        event.stopPropagation();
        dropdown.classList.toggle('hidden');
    });

    document.addEventListener('click', () => {
        if (!dropdown.classList.contains('hidden')) {
            dropdown.classList.add('hidden');
        }
    });

    logoutButton.addEventListener('click', () => {
        logout();
    });

    resetButton.addEventListener('click', () => {
        openPasswordModal();
    });
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

function getFilterValues() {
    return {
        actor: document.getElementById('filter-actor').value.trim(),
        target: document.getElementById('filter-target').value.trim(),
        action: document.getElementById('filter-action').value.trim(),
        ip: document.getElementById('filter-ip').value.trim(),
        from: document.getElementById('filter-from').value,
        to: document.getElementById('filter-to').value,
        limit: document.getElementById('filter-limit').value
    };
}

function buildQuery(params) {
    const query = new URLSearchParams();
    if (params.actor) query.set('actor', params.actor);
    if (params.target) query.set('target', params.target);
    if (params.action) query.set('action', params.action);
    if (params.ip) query.set('ip', params.ip);
    if (params.from) {
        const fromDate = new Date(params.from);
        if (!Number.isNaN(fromDate.getTime())) {
            query.set('from', fromDate.toISOString());
        }
    }
    if (params.to) {
        const toDate = new Date(params.to);
        if (!Number.isNaN(toDate.getTime())) {
            query.set('to', toDate.toISOString());
        }
    }
    if (params.limit) query.set('limit', params.limit);
    const queryString = query.toString();
    return queryString ? `?${queryString}` : '';
}

function formatMetadata(metadata) {
    if (!metadata) {
        return '-';
    }
    try {
        const parsed = JSON.parse(metadata);
        if (parsed && typeof parsed === 'object') {
            return Object.entries(parsed)
                .map(([key, value]) => `${key}: ${value}`)
                .join(', ');
        }
    } catch (err) {
        // ignore
    }
    return metadata;
}

async function fetchAuditLog() {
    const filters = getFilterValues();
    const query = buildQuery(filters);
    const token = localStorage.getItem('token');
    const res = await fetch(`/admin/audit${query}`, {
        headers: {
            'Authorization': 'Bearer ' + token
        }
    });

    if (res.status === 428) {
        redirectToSetPassword();
        return null;
    }
    if (res.status === 401 || res.status === 403) {
        redirectToLogin();
        return null;
    }
    if (!res.ok) {
        throw new Error('Failed to load audit log');
    }

    return res.json();
}

function renderAuditLog(events) {
    const tbody = document.getElementById('audit-table-body');
    const empty = document.getElementById('audit-empty');
    tbody.innerHTML = '';

    if (!events || events.length === 0) {
        empty.classList.remove('hidden');
        return;
    }
    empty.classList.add('hidden');

    events.forEach(event => {
        const row = document.createElement('tr');

        const timeCell = document.createElement('td');
        timeCell.textContent = formatDate(event.created_at);

        const actorCell = document.createElement('td');
        actorCell.textContent = event.actor_username || 'System';

        const actionCell = document.createElement('td');
        actionCell.textContent = event.action;

        const targetCell = document.createElement('td');
        targetCell.textContent = event.target_username || '-';

        const detailsCell = document.createElement('td');
        detailsCell.textContent = formatMetadata(event.metadata);

        const ipCell = document.createElement('td');
        ipCell.textContent = event.ip_address || '-';

        row.appendChild(timeCell);
        row.appendChild(actorCell);
        row.appendChild(actionCell);
        row.appendChild(targetCell);
        row.appendChild(detailsCell);
        row.appendChild(ipCell);
        tbody.appendChild(row);
    });
}

function openPasswordModal() {
    const modal = document.getElementById('password-modal');
    const message = document.getElementById('password-message');
    message.textContent = '';
    modal.classList.remove('hidden');
}

function closePasswordModal() {
    const modal = document.getElementById('password-modal');
    modal.classList.add('hidden');
    document.getElementById('current-password').value = '';
    document.getElementById('new-password').value = '';
    document.getElementById('confirm-new-password').value = '';
}

async function submitPasswordChange() {
    const message = document.getElementById('password-message');
    message.textContent = '';

    const currentPassword = document.getElementById('current-password').value;
    const newPassword = document.getElementById('new-password').value;
    const confirm = document.getElementById('confirm-new-password').value;

    if (!currentPassword || !newPassword) {
        message.textContent = 'All fields are required.';
        return;
    }
    if (newPassword !== confirm) {
        message.textContent = 'Passwords do not match.';
        return;
    }

    const token = localStorage.getItem('token');
    if (!token) {
        redirectToLogin();
        return;
    }

    try {
        const res = await fetch('/change-password', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + token
            },
            body: JSON.stringify({ currentPassword, newPassword })
        });

        const data = await res.json().catch(() => null);
        if (!res.ok) {
            const errMessage = data && data.message ? data.message : 'Failed to update password.';
            message.textContent = errMessage;
            return;
        }

        if (data && data.token) {
            localStorage.setItem('token', data.token);
        }
        message.textContent = 'Password updated.';
        setTimeout(() => closePasswordModal(), 600);
    } catch (err) {
        message.textContent = 'Failed to update password.';
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

document.addEventListener('DOMContentLoaded', async () => {
    const user = await loadCurrentUser();
    if (!user) {
        return;
    }
    setupAccountMenu();

    async function loadAudit() {
        try {
            const events = await fetchAuditLog();
            renderAuditLog(events);
        } catch (err) {
            console.error(err);
            const empty = document.getElementById('audit-empty');
            empty.textContent = 'Failed to load audit log.';
            empty.classList.remove('hidden');
        }
    }

    await loadAudit();

    document.getElementById('apply-filters').addEventListener('click', () => {
        loadAudit();
    });

    document.getElementById('clear-filters').addEventListener('click', () => {
        document.getElementById('filter-actor').value = '';
        document.getElementById('filter-target').value = '';
        document.getElementById('filter-action').value = '';
        document.getElementById('filter-ip').value = '';
        document.getElementById('filter-from').value = '';
        document.getElementById('filter-to').value = '';
        document.getElementById('filter-limit').value = '200';
        loadAudit();
    });

    document.getElementById('cancel-reset').addEventListener('click', closePasswordModal);
    document.getElementById('confirm-reset').addEventListener('click', submitPasswordChange);
    document.querySelector('#password-modal .modal-backdrop').addEventListener('click', closePasswordModal);
});
