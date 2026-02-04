/*
 * Purpose: Admin login history page logic.
 */
let currentUser = null;

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

async function fetchLoginHistory(userId) {
    const token = localStorage.getItem('token');
    const res = await fetch(`/admin/users/${userId}/logins`, {
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
        throw new Error('Failed to load login history');
    }

    return res.json();
}

function renderHistory(data) {
    const tbody = document.getElementById('logins-table-body');
    const empty = document.getElementById('logins-empty');
    tbody.innerHTML = '';

    if (!data || !Array.isArray(data.logins) || data.logins.length === 0) {
        empty.classList.remove('hidden');
        return;
    }
    empty.classList.add('hidden');

    data.logins.forEach(entry => {
        const row = document.createElement('tr');
        const timeCell = document.createElement('td');
        timeCell.textContent = formatDate(entry.logged_in_at);
        const ipCell = document.createElement('td');
        ipCell.textContent = entry.ip_address || 'Unknown';
        row.appendChild(timeCell);
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
    currentUser = await loadCurrentUser();
    if (!currentUser) {
        return;
    }
    setupAccountMenu();

    const params = new URLSearchParams(window.location.search);
    const userId = params.get('userId');
    const username = params.get('username');
    const title = document.getElementById('history-title');
    if (username) {
        title.textContent = `Login History - ${username}`;
    }

    if (!userId) {
        return;
    }

    try {
        const data = await fetchLoginHistory(userId);
        renderHistory(data);
    } catch (err) {
        console.error(err);
        const empty = document.getElementById('logins-empty');
        empty.textContent = 'Failed to load login history.';
        empty.classList.remove('hidden');
    }

    document.getElementById('cancel-reset').addEventListener('click', closePasswordModal);
    document.getElementById('confirm-reset').addEventListener('click', submitPasswordChange);
    document.querySelector('#password-modal .modal-backdrop').addEventListener('click', closePasswordModal);
});
