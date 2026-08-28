/*
 * Purpose: Login page logic and maintenance redirect via WebSocket.
 * Functions: setupWebSocket, login submit handler.
 */
let ws;
let wsReconnectTimer = null;
let wsStabilityTimer = null;
let wsReconnectAttempt = 0;
let wsStopped = false;
let wsPreOpenFailureCount = 0;
const WS_MAX_PREOPEN_FAILURES = 5;

function scheduleWebSocketReconnect() {
    if (wsStopped || wsReconnectTimer) return;
    const base = Math.min(1000 * (2 ** wsReconnectAttempt), 30000);
    wsReconnectAttempt = Math.min(wsReconnectAttempt + 1, 5);
    const delay = Math.min(30000, Math.round(base * (0.75 + Math.random() * 0.5)));
    wsReconnectTimer = setTimeout(() => {
        wsReconnectTimer = null;
        setupWebSocket();
    }, delay);
}

function setupWebSocket() {
    if (wsStopped || (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING))) return;
    const wsProtocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(wsProtocol + '://' + window.location.host + '/ws/public');
    ws = socket;
    let opened = false;

    socket.onopen = function () {
        if (ws !== socket) {
            socket.close();
            return;
        }
        opened = true;
        if (wsStabilityTimer) clearTimeout(wsStabilityTimer);
        wsStabilityTimer = setTimeout(() => {
            wsReconnectAttempt = 0;
            wsPreOpenFailureCount = 0;
            wsStabilityTimer = null;
        }, 10000);
    };

    socket.onmessage = function (event) {
        if (ws !== socket) {
            return;
        }
        let message;
        try {
            message = JSON.parse(event.data);
        } catch (error) {
            console.error('[ERROR] Failed to parse WebSocket message:', error.message);
            return;
        }

        if (message.type === 'maintenance') {
            window.location.href = '/maintenance.html';
        }
    };

    socket.onclose = function() {
        if (ws !== socket) {
            return;
        }
        ws = null;
        if (wsStabilityTimer) {
            clearTimeout(wsStabilityTimer);
            wsStabilityTimer = null;
        }
        if (wsStopped) return;
        if (!opened) {
            wsPreOpenFailureCount += 1;
            if (wsPreOpenFailureCount >= WS_MAX_PREOPEN_FAILURES) {
                wsStopped = true;
                console.error('Public maintenance WebSocket upgrade failed repeatedly; automatic reconnect stopped until reload.');
                return;
            }
        }
        scheduleWebSocketReconnect();
    };

    socket.onerror = function(err) {
        console.error('Socket encountered error: ', err.message, 'Closing socket');
        socket.close();
    };
}

window.addEventListener('pagehide', function () {
    wsStopped = true;
    if (wsReconnectTimer) {
        clearTimeout(wsReconnectTimer);
        wsReconnectTimer = null;
    }
    if (wsStabilityTimer) {
        clearTimeout(wsStabilityTimer);
        wsStabilityTimer = null;
    }
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        ws.close(1000, 'page hidden');
    }
});

window.addEventListener('pageshow', function (event) {
    if (event.persisted) {
        wsStopped = false;
        wsReconnectAttempt = 0;
        wsPreOpenFailureCount = 0;
        const passwordInput = document.getElementById('password');
        if (passwordInput) {
            passwordInput.value = '';
        }
        setupWebSocket();
    }
});

document.addEventListener('DOMContentLoaded', function() {
    setupWebSocket();
});

document.getElementById('login-form').addEventListener('submit', function(e) {
    e.preventDefault();

    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;

    fetch('/login', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ username, password })
    })
    .then(async response => {
        const data = await response.json().catch(() => null);
        if (!response.ok) {
            const message = (data && data.message) ? data.message : 'Login failed';
            throw new Error(message);
        }
        return data;
    })
    .then(data => {
        if (data && data.token) {
            localStorage.setItem('token', data.token);
            if (data.mustResetPassword) {
                window.location.href = '/set-password.html';
            } else {
                window.location.href = '/index.html';
            }
        } else {
            alert('Login failed');
        }
    })
    .catch(err => {
        alert('Login failed: ' + err.message);
    });
});

const passkeyButton = document.getElementById('passkey-button');
if (window.PublicKeyCredential) {
    passkeyButton.addEventListener('click', async function() {
        try {
            const data = await window.webauthn.startPasskeyAuthentication();
            if (data && data.token) {
                localStorage.setItem('token', data.token);
                if (data.mustResetPassword) {
                    window.location.href = '/set-password.html';
                } else {
                    window.location.href = '/index.html';
                }
            } else {
                alert('Passkey login failed.');
            }
        } catch (err) {
            alert('Passkey login failed: ' + err.message);
        }
    });
} else {
    passkeyButton.style.display = 'none';
}
