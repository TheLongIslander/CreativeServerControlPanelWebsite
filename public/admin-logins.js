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
    if (window.Appearance && typeof window.Appearance.init === 'function') {
        window.Appearance.init({
            user: currentUser,
            options: { adminOnly: true }
        });
    }

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

});
