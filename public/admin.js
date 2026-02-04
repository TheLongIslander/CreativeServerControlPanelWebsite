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

function renderUsers(users) {
    const tbody = document.getElementById('users-table-body');
    tbody.innerHTML = '';

    users.forEach(user => {
        const isProtected = user.username.toLowerCase() === 'admin' || user.id === currentUser.id;

        const row = document.createElement('tr');
        row.classList.add('user-row');

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
        const lastLoginButton = document.createElement('button');
        lastLoginButton.type = 'button';
        lastLoginButton.classList.add('login-history-link');
        lastLoginButton.textContent = formatDate(user.lastLoginAt);
        lastLoginButton.addEventListener('click', () => openLoginHistory(user));
        lastLoginCell.appendChild(lastLoginButton);

        const createdCell = document.createElement('td');
        createdCell.textContent = formatDate(user.createdAt);

        row.appendChild(usernameCell);
        row.appendChild(statusCell);
        row.appendChild(tempCell);
        row.appendChild(lastLoginCell);
        row.appendChild(createdCell);
        tbody.appendChild(row);

        const actionsRow = document.createElement('tr');
        actionsRow.classList.add('user-actions-row', 'hidden');
        const actionsCell = document.createElement('td');
        actionsCell.colSpan = 5;

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

            const deleteBtn = document.createElement('button');
            deleteBtn.textContent = 'Delete';
            deleteBtn.classList.add('danger');
            deleteBtn.addEventListener('click', () => deleteUser(user));

            actionsPanel.appendChild(toggleBtn);
            actionsPanel.appendChild(resetBtn);
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
    setupAccountMenu();
    refreshUsers();

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

    document.getElementById('cancel-reset').addEventListener('click', closePasswordModal);
    document.getElementById('confirm-reset').addEventListener('click', submitPasswordChange);
    document.querySelector('#password-modal .modal-backdrop').addEventListener('click', closePasswordModal);
});
