/*
 * Purpose: Manage account page logic (password + passkeys).
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
    return user;
}

function setupAccountMenu(user) {
    const accountButton = document.getElementById('account-button');
    const dropdown = document.getElementById('account-dropdown');
    const adminButton = document.getElementById('admin-management-button');
    const logoutButton = document.getElementById('logout-button');

    if (user) {
        accountButton.dataset.username = user.username || '';
    }

    if (adminButton) {
        if (user && user.role === 'admin') {
            adminButton.classList.remove('hidden');
            adminButton.addEventListener('click', () => {
                window.location.href = '/admin.html';
            });
        } else {
            adminButton.classList.add('hidden');
        }
    }

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

function shortCredential(id) {
    if (!id) {
        return '-';
    }
    if (id.length <= 16) {
        return id;
    }
    return `${id.slice(0, 8)}…${id.slice(-6)}`;
}

async function fetchPasskeys() {
    const token = localStorage.getItem('token');
    const res = await fetch('/webauthn/credentials', {
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
        throw new Error('Failed to load passkeys');
    }
    return res.json();
}

function renderPasskeys(passkeys) {
    const tbody = document.getElementById('passkeys-table-body');
    const empty = document.getElementById('passkeys-empty');
    tbody.innerHTML = '';

    if (!passkeys || passkeys.length === 0) {
        empty.classList.remove('hidden');
        return;
    }
    empty.classList.add('hidden');

    passkeys.forEach((passkey) => {
        const row = document.createElement('tr');
        const credCell = document.createElement('td');
        credCell.textContent = shortCredential(passkey.credentialId);

        const createdCell = document.createElement('td');
        createdCell.textContent = formatDate(passkey.createdAt);

        const lastUsedCell = document.createElement('td');
        lastUsedCell.textContent = formatDate(passkey.lastUsedAt);

        const actionCell = document.createElement('td');
        const deleteBtn = document.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.textContent = 'Delete';
        deleteBtn.classList.add('danger');
        deleteBtn.addEventListener('click', () => deletePasskey(passkey.credentialId));
        actionCell.appendChild(deleteBtn);

        row.appendChild(credCell);
        row.appendChild(createdCell);
        row.appendChild(lastUsedCell);
        row.appendChild(actionCell);
        tbody.appendChild(row);
    });
}

async function refreshPasskeys() {
    try {
        const passkeys = await fetchPasskeys();
        renderPasskeys(passkeys);
    } catch (err) {
        console.error(err);
        const empty = document.getElementById('passkeys-empty');
        empty.textContent = 'Failed to load passkeys.';
        empty.classList.remove('hidden');
    }
}

async function addPasskey() {
    const token = localStorage.getItem('token');
    if (!token) {
        redirectToLogin();
        return;
    }
    if (!window.PublicKeyCredential) {
        alert('Passkeys are not supported on this device.');
        return;
    }
    try {
        await window.webauthn.startPasskeyRegistration(token);
        await refreshPasskeys();
    } catch (err) {
        alert(err.message || 'Passkey registration failed.');
    }
}

async function deletePasskey(credentialId) {
    if (!window.confirm('Delete this passkey?')) {
        return;
    }
    const token = localStorage.getItem('token');
    const res = await fetch(`/webauthn/credentials/${encodeURIComponent(credentialId)}`, {
        method: 'DELETE',
        headers: {
            'Authorization': 'Bearer ' + token
        }
    });
    if (!res.ok) {
        alert('Failed to delete passkey.');
        return;
    }
    refreshPasskeys();
}

async function submitPasswordChange(event) {
    event.preventDefault();
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
        document.getElementById('current-password').value = '';
        document.getElementById('new-password').value = '';
        document.getElementById('confirm-new-password').value = '';
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

    setupAccountMenu(user);
    refreshPasskeys();

    document.getElementById('change-password-form').addEventListener('submit', submitPasswordChange);
    const addButton = document.getElementById('add-passkey-button');
    if (!window.PublicKeyCredential) {
        addButton.disabled = true;
        addButton.textContent = 'Passkeys not supported';
    } else {
        addButton.addEventListener('click', addPasskey);
    }
});
