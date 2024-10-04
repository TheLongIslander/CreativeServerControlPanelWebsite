document.addEventListener('DOMContentLoaded', function() {
    fetchFiles('/');

    const logoutButton = document.getElementById('logout-button');
    logoutButton.addEventListener('click', function() {
        logout();
    });

    const pathInput = document.getElementById('path-input');
    pathInput.addEventListener('keypress', function(event) {
        if (event.key === 'Enter') {
            changeDirectory();
        }
    });

    // Add event listener for file upload
    const uploadForm = document.getElementById('upload-form');
    uploadForm.addEventListener('submit', function(event) {
        event.preventDefault();
        uploadFiles();
    });

    // Trigger upload when files are selected
    const fileInput = document.getElementById('file-input');
    fileInput.addEventListener('change', function() {
        if (this.files.length > 0) {
            uploadFiles();
        }
    });

    const uploadButton = document.getElementById('upload-button');
    uploadButton.addEventListener('click', function() {
        triggerFileUpload();
    });

    // Detect user activity
    detectUserActivity();
});

let activityTimeout;
let refreshInterval;

function detectUserActivity() {
    document.addEventListener('mousemove', resetActivityTimeout);
    document.addEventListener('keypress', resetActivityTimeout);
    document.addEventListener('click', resetActivityTimeout);
    document.addEventListener('scroll', resetActivityTimeout);

    resetActivityTimeout(); // Initialize activity detection
}

function resetActivityTimeout() {
    clearTimeout(activityTimeout);
    activityTimeout = setTimeout(setUserInactive, 300000); // 5 minutes of inactivity

    if (!refreshInterval) {
        refreshInterval = setInterval(() => {
            const currentPath = document.getElementById('path-input').value;
            fetchFiles(currentPath);
        }, 1000); // Refresh every 1 minute
    }
}

function setUserInactive() {
    clearInterval(refreshInterval);
    refreshInterval = null;
}

function triggerFileUpload() {
    document.getElementById('file-input').click();
}

function fetchFiles(path) {
    const token = localStorage.getItem('token');
    updatePathInput(path);
    toggleUpDirectoryButton(path);

    if (!token) {
        alert('You are not authenticated.');
        window.location.href = '/';
        return;
    }

    fetch(`/sftp/list?path=${encodeURIComponent(path)}`, {
        headers: {
            'Authorization': 'Bearer ' + token
        }
    })
    .then(response => {
        if (!response.ok) {
            throw new Error('Failed to fetch files');
        }
        return response.json();
    })
    .then(files => {
        const fileList = document.getElementById('file-list');
        const existingItems = Array.from(fileList.children);
        
        // Remove items that are not in the new list
        existingItems.forEach(item => {
            const fileName = item.querySelector('span').textContent;
            if (!files.some(file => file.name === fileName)) {
                fileList.removeChild(item);
            }
        });
        
        files.forEach(file => {
            const existingItem = existingItems.find(item => item.querySelector('span').textContent === file.name);
            
            if (!existingItem) {
                const fileItem = document.createElement('li');
                fileItem.classList.add('directory-item');

                let fileIcon;
                if (file.type === 'directory') {
                    fileIcon = document.createElement('img');
                    fileIcon.src = 'assets/folder-icon.png';
                    fileIcon.alt = 'Folder';
                    fileIcon.classList.add('folder-icon');
                    fileIcon.onclick = () => openDirectory(path, file.name);

                    const fileName = document.createElement('span');
                    fileName.classList.add('file-name'); // Ensure the class is applied here
                    fileName.classList.add('directory');
                    fileName.textContent = file.name;
                    fileName.onclick = () => openDirectory(path, file.name);

                    fileItem.appendChild(fileIcon);
                    fileItem.appendChild(fileName);
                } else {
                    const fileName = document.createElement('span');
                    fileName.textContent = file.name;

                    if (file.name.endsWith('.jar')) {
                        fileIcon = document.createElement('img');
                        fileIcon.src = 'assets/jar.png'; // Path to your JAR file icon
                        fileIcon.alt = 'JAR File';
                    } else if (file.name.endsWith('.gz')) {
                        fileIcon = document.createElement('img');
                        fileIcon.src = 'assets/gz.png'; // Path to your GZ file icon
                        fileIcon.alt = 'GZ File';
                    } else if (file.name.endsWith('.png')) {
                        fileIcon = document.createElement('img');
                        fileIcon.src = 'assets/png.png'; // Path to your PNG file icon
                        fileIcon.alt = 'PNG File';
                    } 
                    else if (file.name.endsWith('.zip')){
                        fileIcon = document.createElement('img');
                        fileIcon.src = 'assets/zip-icon.png'; // Path to your ZIP file icon
                        fileIcon.alt = 'ZIP File';
                    }else {
                        fileIcon = document.createElement('img');
                        fileIcon.src = 'assets/file.png'; // Path to your default file icon
                        fileIcon.alt = 'File';
                    }
                    fileIcon.classList.add('file-icon');
                    fileItem.appendChild(fileIcon);
                    fileName.classList.add('file-name'); // Ensure the class is applied here
                    fileItem.appendChild(fileName);
                }

                const downloadForm = document.createElement('form');
                downloadForm.method = 'POST';
                downloadForm.action = '/download';
                downloadForm.onsubmit = function() {
                    const tokenInput = document.createElement('input');
                    tokenInput.type = 'hidden';
                    tokenInput.name = 'token';
                    tokenInput.value = localStorage.getItem('token');
                    downloadForm.appendChild(tokenInput);

                    showLoadingSpinner(downloadForm);

                    // Set a timeout to hide the spinner and show the download button again
                    setTimeout(() => {
                        hideLoadingSpinner(downloadForm);
                    }, 1000);

                    return true;
                };

                const pathInput = document.createElement('input');
                pathInput.type = 'hidden';
                pathInput.name = 'path';
                pathInput.value = path.endsWith('/') ? path + file.name : path + '/' + file.name;

                const downloadButton = document.createElement('button');
                downloadButton.type = 'submit';
                downloadButton.classList.add('download-button');
                downloadButton.textContent = 'Download';

                downloadForm.appendChild(pathInput);
                downloadForm.appendChild(downloadButton);

                fileItem.appendChild(downloadForm);
                fileList.appendChild(fileItem);
            }
        });
    })
    .catch(error => {
        console.error('Error fetching files:', error);
        alert('Error fetching files. Please try again.');
    });
}


function showLoadingSpinner(form) {
    const downloadButton = form.querySelector('.download-button');
    downloadButton.style.display = 'none';

    // Create spinner
    const spinner = document.createElement('div');
    spinner.classList.add('spinner');
    
    // Create the loading message
    const loadingMessage = document.createElement('div');
    loadingMessage.classList.add('loading-message');
    loadingMessage.textContent = 'This may take a minute! Please wait till the download starts!';

    // Append spinner and message to the form
    form.appendChild(spinner);
    form.appendChild(loadingMessage);
}


function hideLoadingSpinner() {
    const spinners = document.querySelectorAll('.spinner');
    spinners.forEach(spinner => {
        const form = spinner.parentElement;
        spinner.remove();

        // Remove the loading message as well
        const loadingMessage = form.querySelector('.loading-message');
        if (loadingMessage) {
            loadingMessage.remove();
        }

        const downloadButton = form.querySelector('.download-button');
        if (downloadButton) {
            downloadButton.style.display = 'inline-block';
        }
    });
}


window.addEventListener('message', function(event) {
    if (event.data === 'hideLoadingSpinner') {
        hideLoadingSpinner();
    }
});

function logout() {
    const token = localStorage.getItem('token');
    if (!token) {
        alert('No active session.');
        window.location.href = '/';
        return;
    }

    fetch('/logout', {
        method: 'POST',
        headers: {
            'Authorization': 'Bearer ' + token
        }
    })
    .then(handleFetchResponse)
    .then(response => {
        if (response && response.ok) {
            console.log('Logout successful on server.');
            localStorage.removeItem('token'); // Clear the token
            window.location.href = '/'; // Redirect to login
        } else {
            console.log('Server responded with an error during logout.');
        }
    })
    .catch(error => {
        console.error('Error during logout:', error);
        alert('Error logging out.');
    });
}

function handleFetchResponse(response) {
    if (response.status === 403) {
        alert('Session has expired, please log in again.');
        localStorage.removeItem('token');
        window.location.href = '/';
        return null;
    } else if (!response.ok) {
        throw new Error('Failed to fetch data');
    }
    return response;
}

function changeDirectory() {
    const path = document.getElementById('path-input').value;
    const token = localStorage.getItem('token');
    fetch('/change-directory', {
        method: 'POST',
        headers: {
            'Authorization': 'Bearer ' + token,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ path: path })
    })
    .then(handleFetchResponse)
    .then(response => response.json())
    .then(data => fetchFiles(data.path))
    .catch(error => console.error('Error changing directory:', error));
}

function openDirectory(currentPath, dirName) {
    const token = localStorage.getItem('token');
    const newPath = currentPath.endsWith('/') ? currentPath + dirName : currentPath + '/' + dirName;
    fetch(`/open-directory`, {
        method: 'POST',
        headers: {
            'Authorization': 'Bearer ' + token,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ path: newPath })
    })
    .then(handleFetchResponse)
    .then(response => response.json())
    .then(data => fetchFiles(data.path))
    .catch(error => console.error('Error opening directory:', error));
}

function updatePathInput(path) {
    const pathInput = document.getElementById('path-input');
    pathInput.value = path; // Update the path in the search bar
}

function upDirectory() {
    let currentPath = document.getElementById('path-input').value;
    if (currentPath === '/' || currentPath === '') {
        return; // Already at the root, cannot go up
    }
    const newPath = currentPath.split('/').slice(0, -1).join('/') || '/';
    const token = localStorage.getItem('token');
    fetch(`/open-directory`, {
        method: 'POST',
        headers: {
            'Authorization': 'Bearer ' + token,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ path: newPath })
    })
    .then(handleFetchResponse)
    .then(response => response.json())
    .then(data => fetchFiles(data.path))
    .catch(error => console.error('Error going up directory:', error));
}

function toggleUpDirectoryButton(path) {
    const upDirectoryButton = document.getElementById('up-directory-button');
    if (path === '/' || path === '') {
        upDirectoryButton.style.display = 'none'; // Hide button at root
    } else {
        upDirectoryButton.style.display = 'inline'; // Show button otherwise
    }
}

function uploadFiles() {
    const token = localStorage.getItem('token');
    const fileInput = document.getElementById('file-input');
    const currentPath = document.getElementById('path-input').value;
    const files = Array.from(fileInput.files);
    const formData = new FormData();

    files.forEach(file => {
        formData.append('files', file, file.webkitRelativePath || file.name);
    });

    formData.append('path', currentPath);

    // Hide the upload button and show the progress bar
    const uploadButton = document.getElementById('upload-button');
    const progressContainer = document.getElementById('progress-container');
    const progressBar = document.getElementById('upload-progress');
    const uploadPercentage = document.getElementById('upload-percentage');
    uploadButton.style.display = 'none';
    progressContainer.style.display = 'block';

    // Set the progress bar to 100% by default and show "Uploading..."
    progressBar.value = 100;
    uploadPercentage.textContent = 'Uploading...';  // Default text

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/upload', true);
    xhr.setRequestHeader('Authorization', 'Bearer ' + token);

    let progressDetected = false;

    // Monitor the upload progress
    xhr.upload.onprogress = function(event) {
        if (event.lengthComputable) {
            progressDetected = true;
            const percentComplete = (event.loaded / event.total) * 100;

            if (percentComplete >= 1) {
                progressBar.value = percentComplete;  // Update the progress bar with actual progress
                uploadPercentage.textContent = `${Math.round(percentComplete)}%`;  // Update the text
            }

            if (percentComplete === 100) {
                uploadPercentage.textContent = 'Processing...';
            }
        }
    };

    // Handle the response after upload completion
    xhr.onload = function() {
        if (xhr.status === 200) {
            alert('Upload successful!');
            fetchFiles(currentPath); // Refresh the file list
        } else {
            alert('Upload failed: ' + xhr.statusText);
        }

        // Hide the progress bar and percentage, show the upload button
        progressContainer.style.display = 'none';
        progressBar.value = 0;
        uploadPercentage.textContent = '';
        uploadButton.style.display = 'block';
    };

    // Handle errors during upload
    xhr.onerror = function() {
        alert('Upload failed: ' + xhr.statusText);

        // Hide the progress bar and percentage, show the upload button
        progressContainer.style.display = 'none';
        progressBar.value = 0;
        uploadPercentage.textContent = '';
        uploadButton.style.display = 'block';
    };

    // If no progress is detected after a short delay, keep the bar full and show "Uploading..."
    setTimeout(() => {
        if (!progressDetected) {
            progressBar.value = 100;  // Keep the bar full
            uploadPercentage.textContent = 'Uploading...';  // Keep "Uploading..." if no progress events fired
        }
    }, 500);  // Adjust this delay as necessary

    xhr.send(formData);
}









function generateUniqueId() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0,
            v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

function goToRoot() {
    fetchFiles('/');
}
