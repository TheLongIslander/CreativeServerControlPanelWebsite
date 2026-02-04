/*
 * Purpose: Admin user management UI logic.
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

function renderUsers(users) {
    const tbody = document.getElementById('users-table-body');
    tbody.innerHTML = '';

    users.forEach(user => {
        const row = document.createElement('tr');

        const isProtected = user.username.toLowerCase() === 'admin' || user.id === currentUser.id;

        const statusCell = document.createElement('td');
        if (user.disabled) {
            statusCell.textContent = 'Disabled';
        } else if (user.mustResetPassword) {
            statusCell.textContent = 'Onboarding required';
        } else {
            statusCell.textContent = 'User onboarded';
        }

        const tempCell = document.createElement('td');
        if (user.mustResetPassword && user.tempPassword) {
            const wrapper = document.createElement('div');
            wrapper.classList.add('temp-password');
            const code = document.createElement('span');
            code.textContent = user.tempPassword;
            const copyBtn = document.createElement('button');
            copyBtn.textContent = 'Copy';
            copyBtn.addEventListener('click', () => copyToClipboard(user.tempPassword));
            wrapper.appendChild(code);
            wrapper.appendChild(copyBtn);
            tempCell.appendChild(wrapper);
        } else {
            tempCell.textContent = 'User onboarded';
        }

        const actionsCell = document.createElement('td');
        actionsCell.classList.add('actions-cell');

        if (isProtected) {
            actionsCell.textContent = 'Protected';
        } else {
            const toggleBtn = document.createElement('button');
            toggleBtn.textContent = user.disabled ? 'Enable' : 'Disable';
            toggleBtn.addEventListener('click', () => toggleDisabled(user));

            const resetBtn = document.createElement('button');
            resetBtn.textContent = 'Reset Temp Password';
            resetBtn.addEventListener('click', () => resetTempPassword(user));

            const deleteBtn = document.createElement('button');
            deleteBtn.textContent = 'Delete';
            deleteBtn.classList.add('danger');
            deleteBtn.addEventListener('click', () => deleteUser(user));

            actionsCell.appendChild(toggleBtn);
            actionsCell.appendChild(resetBtn);
            actionsCell.appendChild(deleteBtn);
        }

        const usernameCell = document.createElement('td');
        usernameCell.textContent = user.username;

        const lastLoginCell = document.createElement('td');
        lastLoginCell.textContent = formatDate(user.lastLoginAt);

        row.appendChild(usernameCell);
        row.appendChild(statusCell);
        row.appendChild(tempCell);
        row.appendChild(lastLoginCell);
        row.appendChild(actionsCell);
        tbody.appendChild(row);
    });
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
        alert(`New temporary password: ${data.tempPassword}`);
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

async function copyToClipboard(text) {
    try {
        await navigator.clipboard.writeText(text);
        alert('Copied to clipboard.');
    } catch (err) {
        alert('Copy failed. Please copy manually.');
    }
}

document.addEventListener('DOMContentLoaded', async function() {
    currentUser = await loadCurrentUser();
    if (!currentUser) {
        return;
    }
    setupAccountMenu();
    refreshUsers();

    const form = document.getElementById('create-user-form');
    const message = document.getElementById('create-message');
    form.addEventListener('submit', async function(event) {
        event.preventDefault();
        message.textContent = '';

        const usernameInput = document.getElementById('new-username');
        const username = usernameInput.value.trim();
        if (!username) {
            message.textContent = 'Username is required.';
            return;
        }

        try {
            const user = await createUser(username);
            message.textContent = `User created. Temp password: ${user.tempPassword}`;
            usernameInput.value = '';
            refreshUsers();
        } catch (err) {
            message.textContent = err.message;
        }
    });
});
