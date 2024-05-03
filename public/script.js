if (!localStorage.getItem('token')) {
    alert('You are not authenticated.');
    window.location.href = '/'; // Redirect back to login
  }
  let isBackingUp = false;
  let ws;
  document.addEventListener('DOMContentLoaded', function() {
    setupWebSocket();
    checkServerStatus();
  });
  
  function checkServerStatus() {
    fetch('/status')
        .then(response => response.json())
        .then(data => {
            const startButton = document.getElementById('start-server');
            const stopButton = document.getElementById('stop-server');
            const backupButton = document.getElementById('backup-server');
            const restartButton = document.getElementById('restart-server'); // Add reference to restart button

            // Server must be running to stop or restart, and should not be backing up or restarting
            const serverOperable = !isBackingUp && data.running;

            startButton.disabled = isBackingUp || data.running;
            stopButton.disabled = isBackingUp || !data.running;
            backupButton.disabled = isBackingUp;
            restartButton.disabled = isBackingUp || !data.running; // Disable if server is off or backup is in progress

            console.log(`Server running: ${data.running}, Is backing up: ${isBackingUp}`);
        })
        .catch(err => {
            console.error('Error checking server status: ', err);
        });
}
  function setupWebSocket() {
    ws = new WebSocket('wss://' + window.location.host);

    ws.onopen = function() {
        console.log('WebSocket connection established');
    };

    ws.onmessage = function (event) {
        const message = JSON.parse(event.data);
        if (message.type === 'progress') {
          updateBackupProgress(message.value); // Update the progress bar with this value
        } else if (message.type === 'complete') {
          // When backup is complete, ensure the progress bar shows 100%
          updateBackupProgress('100');
          setBackupState(false); // Reset the backup state
        }
      };
    ws.onclose = function(e) {
        console.error('Socket is closed. Reconnect will be attempted in 1 second.', e.reason);
        setTimeout(function() {
            setupWebSocket();
        }, 1000);
    };

    ws.onerror = function(err) {
        console.error('Socket encountered error: ', err.message, 'Closing socket');
        ws.close();
    };
}
function updateBackupProgress(progress) {
    const progressBar = document.getElementById('progress-bar');
    const progressPercentage = document.getElementById('progress-percentage'); // Make sure this ID matches the element in HTML
    const progressContainer = document.getElementById('progress-container'); // Make sure this ID matches the container element in HTML

    // Show the progress bar when the backup starts
    if (progress > 0) {
        progressContainer.style.display = 'block';
    }
    if (progress > 0 )
    {
        progressPercentage.style.display = 'block';
    }
    progressBar.style.width = progress + '%';
    progressPercentage.textContent = progress + '%'; // Set the percentage text

    // Hide the progress bar when the backup is complete
    if (progress == 100) {
        setTimeout(() => {
            progressContainer.style.display = 'none';
        }, 2000); // Or however long you want the bar to remain visible after reaching 100%
    }
}
function setBackupState(isBacking) {
    isBackingUp = isBacking;
    checkServerStatus(); // Immediately update the button states
    
    // Hide progress bar when backup is not in progress
    if (!isBackingUp) {
        const progressContainer = document.getElementById('progress-container');
        const progressPercentage = document.getElementById('progress-percentage');
        progressContainer.style.display = 'none';
        progressPercentage.style.display = 'none'; 
        const progressBar = document.getElementById('progress-bar');
        progressBar.style.width = '0%'; // Reset the progress bar width
        progressBar.textContent = '0%'; // Reset the text
    }
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
  document.getElementById('restart-server').addEventListener('click', function() {
    const token = localStorage.getItem('token');
    if (!token) {
        return alert('You are not authenticated.');
    }

    // Disable all buttons to prevent multiple operations during restart
    document.getElementById('start-server').disabled = true;
    document.getElementById('stop-server').disabled = true;
    document.getElementById('backup-server').disabled = true;
    document.getElementById('restart-server').disabled = true;

    fetch('/restart', {
        method: 'POST',
        headers: {
            'Authorization': 'Bearer ' + token
        }
    })
    .then(response => response.text())
    .then(text => {
        alert(text);
        // Wait for 3 seconds before re-enabling the buttons
        setTimeout(() => {
            checkServerStatus(); // Re-enable buttons based on server status
        }, 3000 + 3000); // Additional 3 seconds added to the existing delay
    })
    .catch(err => {
        alert('Error restarting server: ' + err);
        setTimeout(() => {
            checkServerStatus(); // Re-enable buttons based on server status
        }, 3000 + 3000); // Additional 3 seconds added to the existing delay
    });
});
