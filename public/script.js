if (!localStorage.getItem('token')) {
    alert('You are not authenticated.');
    window.location.href = '/'; // Redirect back to login
  }
  document.addEventListener('DOMContentLoaded', function() {
    checkServerStatus();
  });
  
  function checkServerStatus() {
    fetch('/status')
      .then(response => response.json())
      .then(data => {
        const startButton = document.getElementById('start-server');
        const stopButton = document.getElementById('stop-server');
        if (data.running) {
          startButton.disabled = true;
          stopButton.disabled = false;
        } else {
          startButton.disabled = false;
          stopButton.disabled = true;
        }
      })
      .catch(err => {
        console.error('Error checking server status: ', err);
      });
  }
  document.getElementById('start-server').addEventListener('click', function() {
    const token = localStorage.getItem('token');
    if (!token) {
        return alert('You are not authenticated.');
    }

    fetch('/start', {
        method: 'POST',
        headers: {
            'Authorization': 'Bearer ' + token
        }
    })
    .then(response => response.text())
    .then(text => {
        alert(text);
        checkServerStatus(); // Update this line
    })
    .catch(err => {
        alert('Error starting server: ' + err);
        checkServerStatus(); // And this line, in case of error
    });
});

document.getElementById('stop-server').addEventListener('click', function() {
    const token = localStorage.getItem('token');
    if (!token) {
        return alert('You are not authenticated.');
    }

    fetch('/stop', {
        method: 'POST',
        headers: {
            'Authorization': 'Bearer ' + token
        }
    })
    .then(response => response.text())
    .then(text => {
        alert(text);
        checkServerStatus(); // Update this line
    })
    .catch(err => {
        alert('Error stopping server: ' + err);
        checkServerStatus(); // And this line, in case of error
    });
});