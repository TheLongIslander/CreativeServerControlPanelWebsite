/*
 * Purpose: Force onboarding password reset.
 */
function redirectToLogin() {
    localStorage.removeItem('token');
    window.location.href = '/';
}

async function ensureSession() {
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
    return user;
}

document.addEventListener('DOMContentLoaded', async function() {
    const user = await ensureSession();
    if (!user) {
        return;
    }

    const form = document.getElementById('set-password-form');
    const message = document.getElementById('message');

    form.addEventListener('submit', async function(event) {
        event.preventDefault();
        message.textContent = '';

        const password = document.getElementById('password').value;
        const confirmPassword = document.getElementById('confirm-password').value;

        if (password !== confirmPassword) {
            message.textContent = 'Passwords do not match.';
            return;
        }

        const token = localStorage.getItem('token');
        if (!token) {
            redirectToLogin();
            return;
        }

        try {
            const res = await fetch('/set-password', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + token
                },
                body: JSON.stringify({ password })
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

            window.location.href = '/index.html';
        } catch (err) {
            message.textContent = 'Failed to update password.';
        }
    });
});
