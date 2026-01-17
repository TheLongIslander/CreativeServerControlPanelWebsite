/*
 * Purpose: Login page logic and maintenance redirect via WebSocket.
 * Functions: setupWebSocket, login submit handler.
 */
let ws;

function setupWebSocket() {
    const wsProtocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(wsProtocol + '://' + window.location.host);

    ws.onmessage = function (event) {
        let message;
        try {
            message = JSON.parse(event.data);
        } catch (error) {
            console.error('[ERROR] Failed to parse WebSocket message:', error.message, event.data);
            return;
        }

        if (message.type === 'maintenance') {
            window.location.href = '/maintenance.html';
        }
    };

    ws.onclose = function() {
        setTimeout(setupWebSocket, 1000);
    };

    ws.onerror = function(err) {
        console.error('Socket encountered error: ', err.message, 'Closing socket');
        ws.close();
    };
}

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
    .then(response => response.json())
    .then(data => 
        {
        if (data.token) 
        {
            // Store the token in localStorage
            localStorage.setItem('token', data.token);
            // Redirect to the control panel page
            window.location.href = '/index.html';
        } 
        else 
        {
            alert('Login failed: Incorrect Password');
        }
    })
    .catch(err => {
        alert('Login failed');
    });
});
