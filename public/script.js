if (!localStorage.getItem('token')) {
  alert('You are not authenticated.');
  window.location.href = '/'; // Redirect back to login
}
let isBackingUp = false;
document.addEventListener('DOMContentLoaded', function() {
  checkServerStatus();
});

function checkServerStatus() {
  fetch('/status')
      .then(response => response.json())
      .then(data => {
          const startButton = document.getElementById('start-server');
          const stopButton = document.getElementById('stop-server');
          const backupButton = document.getElementById('backup-server');

          // Update the disabled status based on server running state and backup state
          startButton.disabled = isBackingUp || (!isBackingUp && data.running);
          stopButton.disabled = isBackingUp || (!isBackingUp && !data.running);
          backupButton.disabled = isBackingUp;

          console.log(`Server running: ${data.running}, Is backing up: ${isBackingUp}`);
      })
      .catch(err => {
          console.error('Error checking server status: ', err);
      });
}
function setBackupState(isBacking) {
isBackingUp = isBacking;
checkServerStatus(); // Immediately update the button states
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
    checkServerStatus();
})
.catch(err => {
    alert('Error starting server: ' + err);
    checkServerStatus();
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
    checkServerStatus();
})
.catch(err => {
    alert('Error stopping server: ' + err);
    checkServerStatus();
});
});
document.getElementById('backup-server').addEventListener('click', function() {
const token = localStorage.getItem('token');
if (!token) {
    return alert('You are not authenticated.');
}

setBackupState(true); // Indicate backup is starting

fetch('/backup', {
    method: 'POST',
    headers: {
        'Authorization': 'Bearer ' + token
    }
})
.then(response => response.text())
.then(text => {
    alert(text);
    setBackupState(false); // Indicate backup has finished
})
.catch(err => {
    alert('Error performing backup: ' + err);
    setBackupState(false); // Ensure state is reset on error
});
});
