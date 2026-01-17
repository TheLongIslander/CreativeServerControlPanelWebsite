/*
 * Purpose: SFTP browser UI logic for navigation, uploads/downloads, previews, and maintenance redirects.
 * Functions: setupWebSocket, fetchFiles, createDirectory, openDirectory, uploadFiles,
 *            preview helpers, and UI event handlers.
 */
const downloadWindows = {};
const progressStateMap = {};
let activityTimeout;
let refreshInterval;
let typingInProgress = false;
let currentDisplayedPath = null;
let lastMissingPathAlerted = null;

function setupWebSocket() {
    if (window.ws && window.ws.readyState !== WebSocket.CLOSED) {
        return;
    }

    const wsProtocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    window.ws = new WebSocket(`${wsProtocol}://${window.location.host}`);

    window.ws.onmessage = function (event) {
        let message;
        try {
            message = JSON.parse(event.data);
        } catch (error) {
            console.error('[ERROR] Failed to parse WebSocket message:', error.message, event.data);
            return;
        }

        if (message.type === 'maintenance') {
            window.location.href = '/maintenance.html';
            return;
        }

        if (!message.requestId) {
            return;
        }

        const requestId = message.requestId;
        if (message.type === 'progress') {
            updateZipProgress(requestId, message.progress);
        } else if (message.type === 'complete') {
            const form = document.querySelector(`form[data-request-id="${requestId}"]`);
            if (form) {
                hideLoadingSpinner(form);
            }

            const downloadUrl = `${window.location.origin}/downloads/${requestId}`;
            const popup = downloadWindows[requestId];

            if (popup && !popup.closed) {
                popup.location = downloadUrl;
            } else {
                window.open(downloadUrl, '_blank');
            }

            delete downloadWindows[requestId];
        }
    };

    window.ws.onerror = function () {
        window.ws.close();
    };

    window.ws.onclose = function () {
        setTimeout(() => {
            if (!window.ws || window.ws.readyState === WebSocket.CLOSED) {
                setupWebSocket();
            }
        }, 3000);
    };
}

function getInitialPath() {
    const params = new URLSearchParams(window.location.search);
    return params.get('path') || '/';
}

// Ensure the WebSocket is only initialized once on DOMContentLoaded
document.addEventListener('DOMContentLoaded', function () {
    setupWebSocket();
    fetchFiles(getInitialPath(), false, true);

    const logoutButton = document.getElementById('logout-button');
    logoutButton.addEventListener('click', function () {
        logout();
    });

    const pathInput = document.getElementById('path-input');
    pathInput.addEventListener('keypress', function (event) {
        if (event.key === 'Enter') {
            changeDirectory();
        }
    });

    pathInput.addEventListener('input', function () {
        typingInProgress = true;
    });

    pathInput.addEventListener('blur', function () {
        typingInProgress = false;
    });

    const createDirectoryButton = document.getElementById('create-directory-button');
    if (createDirectoryButton) {
        createDirectoryButton.addEventListener('click', function () {
            const directoryName = prompt('Enter the new directory name:');
            if (directoryName) {
                createDirectory(directoryName);
            }
        });
    }

    const uploadForm = document.getElementById('upload-form');
    uploadForm.addEventListener('submit', function (event) {
        event.preventDefault();
        uploadFiles();
    });

    const fileInput = document.getElementById('file-input');
    fileInput.addEventListener('change', function () {
        if (this.files.length > 0) {
            uploadFiles();
        }
    });

    const uploadButton = document.getElementById('upload-button');
    uploadButton.addEventListener('click', function () {
        triggerFileUpload();
    });

    detectUserActivity();
});

window.addEventListener('popstate', throttle(function (event) {
    if (event.state && event.state.path) {
        fetchFiles(event.state.path, false, true);
    }
}, 200));

function detectUserActivity() {
    document.addEventListener('mousemove', resetActivityTimeout);
    document.addEventListener('keypress', resetActivityTimeout);
    document.addEventListener('click', resetActivityTimeout);
    document.addEventListener('scroll', resetActivityTimeout);

    resetActivityTimeout();
}

function resetActivityTimeout() {
    clearTimeout(activityTimeout);
    activityTimeout = setTimeout(setUserInactive, 300000);

    if (!refreshInterval) {
        refreshInterval = setInterval(() => {
            fetchFiles(currentDisplayedPath || '/', false, true);
        }, 1000);
    }
}

function setUserInactive() {
    clearInterval(refreshInterval);
    refreshInterval = null;
}

function triggerFileUpload() {
    document.getElementById('file-input').click();
}

function fetchFiles(path, shouldPushState = true, forceUpdate = false) {
    if (!forceUpdate && currentDisplayedPath === path) {
        return;
    }

    currentDisplayedPath = path;

    const token = localStorage.getItem('token');
    toggleUpDirectoryButton(path);

    if (!typingInProgress) {
        updatePathInput(path);
    }

    if (!token) {
        alert('You are not authenticated.');
        window.location.href = '/';
        return;
    }

    if (shouldPushState) {
        history.pushState({ path }, null, `/sftp.html?path=${encodeURIComponent(path)}`);
    }

    fetch(`/sftp/list?path=${encodeURIComponent(path)}`, {
        headers: {
            'Authorization': 'Bearer ' + token
        }
    })
        .then(async response => {
            if (response.status === 403) {
                alert('Session has expired, please log in again.');
                localStorage.removeItem('token');
                window.location.href = '/';
                throw new Error('Session expired');
            }
            if (response.status === 404) {
                const data = await response.json().catch(() => null);
                if (data && data.fallbackPath) {
                    const targetPath = data.fallbackPath === path ? '/' : data.fallbackPath;
                    if (lastMissingPathAlerted !== data.deletedPath) {
                        alert(`Directory was deleted remotely. Moving you to ${targetPath}.`);
                        lastMissingPathAlerted = data.deletedPath;
                    }
                    fetchFiles(targetPath, true, true);
                    return null;
                }
            }
            if (!response.ok) {
                throw new Error('Failed to fetch files');
            }
            return response.json();
        })
        .then(files => {
            if (!files) {
                return;
            }
            const fileList = document.getElementById('file-list');
            const existingItems = Array.from(fileList.children);
            const existingFileMap = {};

            existingItems.forEach(item => {
                const name = item.querySelector('span').textContent;
                existingFileMap[name] = item;
            });

            files.forEach(file => {
                const existingItem = existingFileMap[file.name];

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
                        fileName.classList.add('file-name');
                        fileName.classList.add('directory');
                        fileName.textContent = file.name;
                        fileName.onclick = () => openDirectory(path, file.name);

                        fileItem.appendChild(fileIcon);
                        fileItem.appendChild(fileName);
                    } else {
                        const fileName = document.createElement('span');
                        fileName.textContent = file.name;

                        if (isImage(file.name)) {
                            fileIcon = createImagePreview(file, path);
                        } else if (isVideo(file.name)) {
                            fileIcon = createVideoPreview(file, path);
                        } else if (file.name.endsWith('.pdf')) {
                            fileIcon = createPDFPreview(file, path);
                        } else if (file.name.endsWith('.jar')) {
                            fileIcon = document.createElement('img');
                            fileIcon.src = 'assets/jar.png';
                            fileIcon.alt = 'JAR File';
                        } else if (file.name.endsWith('.gz')) {
                            fileIcon = document.createElement('img');
                            fileIcon.src = 'assets/gz.png';
                            fileIcon.alt = 'GZ File';
                        } else if (file.name.endsWith('.png')) {
                            fileIcon = document.createElement('img');
                            fileIcon.src = 'assets/png.png';
                            fileIcon.alt = 'PNG File';
                        } else if (file.name.endsWith('.zip')) {
                            fileIcon = document.createElement('img');
                            fileIcon.src = 'assets/zip-icon.png';
                            fileIcon.alt = 'ZIP File';
                        } else {
                            fileIcon = document.createElement('img');
                            fileIcon.src = 'assets/file.png';
                            fileIcon.alt = 'File';
                        }

                        fileIcon.classList.add('file-icon');
                        fileItem.appendChild(fileIcon);
                        fileName.classList.add('file-name');
                        fileItem.appendChild(fileName);
                    }

                    const downloadForm = document.createElement('form');
                    downloadForm.method = 'POST';
                    downloadForm.action = '/download';
                    downloadForm.onsubmit = async function (event) {
                        event.preventDefault();

                        const token = localStorage.getItem('token');
                        if (!token) {
                            alert('Authentication required. Please log in again.');
                            return false;
                        }

                        const filePath = this.querySelector('input[name="path"]').value;
                        const requestId = generateUniqueId();
                        this.dataset.requestId = requestId;

                        const popup = window.open('', '', 'width=600,height=400');
                        if (popup && popup.document) {
                            popup.document.title = 'Preparing download';
                            popup.document.body.innerHTML = '<p style=\"font-family: Arial, sans-serif; padding: 16px;\">Preparing download…</p>';
                        }
                        downloadWindows[requestId] = popup;

                        showLoadingSpinner(this, requestId);

                        try {
                            const res = await fetch('/download', {
                                method: 'POST',
                                headers: {
                                    'Content-Type': 'application/json',
                                    'Authorization': 'Bearer ' + token
                                },
                                body: JSON.stringify({ token, path: filePath, requestId })
                            });

                            if (!res.ok) {
                                throw new Error(res.statusText);
                            }

                            const responseData = await res.json();
                            this.dataset.requestId = responseData.requestId || requestId;
                        } catch (err) {
                            console.error('Failed to initiate download:', err);
                            hideLoadingSpinner(this);
                            alert('Download initiation failed: ' + err.message);
                            if (popup && !popup.closed) popup.close();
                            delete downloadWindows[requestId];
                        }

                        return false;
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
                } else {
                    delete existingFileMap[file.name];
                }
            });

            Object.values(existingFileMap).forEach(item => {
                fileList.removeChild(item);
            });
        })
        .catch(error => {
            console.error('Error fetching files:', error);
            if (error.message !== 'Session expired') {
                alert('Error fetching files. Please try again.');
            }
        });
}

function createDirectory(directoryName) {
    const token = localStorage.getItem('token');
    const currentPath = document.getElementById('path-input').value;

    fetch('/sftp/create-directory', {
        method: 'POST',
        headers: {
            'Authorization': 'Bearer ' + token,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            path: currentPath,
            directoryName: directoryName
        })
    })
        .then(response => {
            if (!response.ok) {
                return response.json().then(data => {
                    throw new Error(data.message || 'Error creating directory. Please try again.');
                });
            }
            return response.json();
        })
        .then(data => {
            alert('Directory created successfully');
            fetchFiles(data.path);
        })
        .catch(error => {
            if (error.message === 'A directory with that name already exists') {
                alert('A directory with that name already exists. Please choose a different name.');
            } else {
                console.error('Error creating directory:', error);
                alert('Error creating directory. Please try again.');
            }
        });
}

function showLoadingSpinner(form, requestId) {
    let progressBar = form.querySelector('.zip-progress-bar');
    if (!progressBar) {
        progressBar = document.createElement('progress');
        progressBar.classList.add('zip-progress-bar');
        progressBar.value = 0;
        progressBar.max = 100;
        progressBar.style.display = 'block';
        progressBar.style.width = '100%';
        progressBar.style.height = '10px';
        form.appendChild(progressBar);
    } else {
        progressBar.value = 0;
        progressBar.style.display = 'block';
    }

    form.dataset.requestId = requestId;
}

function hideLoadingSpinner(form) {
    const progressBar = form.querySelector('.zip-progress-bar');
    if (progressBar) {
        progressBar.remove();
    }

    const progressLabel = form.querySelector('.zip-progress-label');
    if (progressLabel) {
        progressLabel.remove();
    }

    if (form.dataset.requestId) {
        delete progressStateMap[form.dataset.requestId];
    }

    const spinner = form.querySelector('.spinner');
    if (spinner) {
        spinner.remove();
    }

    const downloadButton = form.querySelector('.download-button');
    if (downloadButton) {
        downloadButton.style.display = 'inline-block';
    }
}

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
                localStorage.removeItem('token');
                window.location.href = '/';
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
    }

    if (!response.ok) {
        throw new Error('Failed to fetch data');
    }

    return response;
}

function changeDirectory() {
    const path = document.getElementById('path-input').value;

    if (!path || path.trim() === '') {
        return;
    }

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
        .catch(error => {
            console.error('Error changing directory:', error);
            alert('Error fetching files. Please try again.');
        });
}

function openDirectory(currentPath, dirName) {
    const token = localStorage.getItem('token');
    const newPath = currentPath.endsWith('/') ? currentPath + dirName : currentPath + '/' + dirName;

    fetch('/open-directory', {
        method: 'POST',
        headers: {
            'Authorization': 'Bearer ' + token,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ path: newPath })
    })
        .then(handleFetchResponse)
        .then(response => response.json())
        .then(data => {
            fetchFiles(data.path);
        })
        .catch(error => {
            console.error('Error opening directory:', error);
        });
}

function upDirectory() {
    let currentPath = document.getElementById('path-input').value;
    if (currentPath === '/' || currentPath === '') {
        return;
    }

    const newPath = currentPath.split('/').slice(0, -1).join('/') || '/';

    const token = localStorage.getItem('token');
    fetch('/open-directory', {
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
    if (!upDirectoryButton) {
        return;
    }

    if (path === '/' || path === '') {
        upDirectoryButton.style.display = 'none';
    } else {
        upDirectoryButton.style.display = 'inline';
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
        formData.append('lastModified', file.lastModified);
    });

    formData.append('path', currentPath);

    const uploadButton = document.getElementById('upload-button');
    const progressContainer = document.getElementById('progress-container');
    const progressBar = document.getElementById('upload-progress');
    const uploadPercentage = document.getElementById('upload-percentage');
    uploadButton.style.display = 'none';
    progressContainer.style.display = 'block';

    progressBar.value = 0;
    uploadPercentage.textContent = 'Uploading...';

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/upload', true);
    xhr.setRequestHeader('Authorization', 'Bearer ' + token);

    let progressDetected = false;

    xhr.upload.onprogress = function (event) {
        if (event.lengthComputable) {
            progressDetected = true;
            progressBar.value = 0;
            const percentComplete = (event.loaded / event.total) * 100;
            if (percentComplete >= 1) {
                progressBar.value = percentComplete;
                uploadPercentage.textContent = `${Math.round(percentComplete)}%`;
            }

            if (percentComplete === 100) {
                uploadPercentage.textContent = 'Processing...';
            }
        }
    };

    xhr.onload = function () {
        if (xhr.status === 200) {
            alert('Upload successful!');
            fetchFiles(currentPath, false, true);
        } else {
            alert('Upload failed: ' + xhr.statusText);
        }

        progressContainer.style.display = 'none';
        progressBar.value = 0;
        progressBar.removeAttribute('value');
        uploadPercentage.textContent = '';
        uploadButton.style.display = 'block';
    };

    xhr.onerror = function () {
        alert('Upload failed: ' + xhr.statusText);

        progressContainer.style.display = 'none';
        progressBar.value = 0;
        progressBar.removeAttribute('value');
        uploadPercentage.textContent = '';
        uploadButton.style.display = 'block';
    };

    setTimeout(() => {
        if (!progressDetected) {
            progressBar.removeAttribute('value');
            uploadPercentage.textContent = 'Uploading...';
        }
    }, 500);

    xhr.send(formData);
}

function generateUniqueId() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        const r = Math.random() * 16 | 0,
            v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

function goToRoot() {
    fetchFiles('/');
}

function isImage(filename) {
    return /\.(jpg|jpeg|png|gif|bmp|webp|heic)$/i.test(filename);
}

function isVideo(filename) {
    return /\.(mp4|mov|avi|webm|mkv)$/i.test(filename);
}

function createImagePreview(file, path) {
    const imageElement = document.createElement('img');
    const filePath = joinPath(path, file.name);

    fetch(`/download-preview?path=${encodeURIComponent(filePath)}`, {
        headers: {
            'Authorization': 'Bearer ' + localStorage.getItem('token')
        }
    })
        .then(response => response.blob())
        .then(blob => {
            const url = URL.createObjectURL(blob);
            imageElement.src = url;
            imageElement.classList.add('image-preview');
            imageElement.alt = file.name;
        })
        .catch(err => console.error('Error fetching image preview:', err));

    return imageElement;
}

function createVideoPreview(file, path) {
    const videoThumbnail = document.createElement('img');
    const filePath = joinPath(path, file.name);

    fetch(`/download-preview?path=${encodeURIComponent(filePath)}`, {
        headers: {
            'Authorization': 'Bearer ' + localStorage.getItem('token')
        }
    })
        .then(response => response.blob())
        .then(blob => {
            const url = URL.createObjectURL(blob);
            videoThumbnail.src = url;
            videoThumbnail.classList.add('video-thumbnail');
            videoThumbnail.alt = `Thumbnail for ${file.name}`;
        })
        .catch(err => console.error('Error fetching video thumbnail:', err));

    return videoThumbnail;
}

function createPDFPreview(file, path) {
    const pdfThumbnail = document.createElement('img');
    const filePath = joinPath(path, file.name);

    fetch(`/download-preview?path=${encodeURIComponent(filePath)}`, {
        headers: {
            'Authorization': 'Bearer ' + localStorage.getItem('token')
        }
    })
        .then(response => response.blob())
        .then(blob => {
            const url = URL.createObjectURL(blob);
            pdfThumbnail.src = url;
            pdfThumbnail.classList.add('pdf-thumbnail');
            pdfThumbnail.alt = `Thumbnail for ${file.name}`;
        })
        .catch(err => console.error('Error fetching PDF thumbnail:', err));

    return pdfThumbnail;
}

function updateZipProgress(requestId, progress) {
    const forms = document.querySelectorAll('form');
    let formFound = false;

    if (!progressStateMap[requestId]) {
        progressStateMap[requestId] = { lastProgress: -1, phase: 'retrieving' };
    }

    const state = progressStateMap[requestId];

    if (state.phase === 'retrieving' && progress <= 1 && state.lastProgress >= 98) {
        state.phase = 'compressing';
    }

    state.lastProgress = progress;

    forms.forEach(form => {
        const formRequestId = form.dataset.requestId;
        if (!formRequestId) {
            return;
        }

        if (formRequestId === requestId) {
            formFound = true;
            let progressBar = form.querySelector('.zip-progress-bar');

            if (!progressBar) {
                progressBar = document.createElement('progress');
                progressBar.classList.add('zip-progress-bar');
                progressBar.value = 0;
                progressBar.max = 100;
                progressBar.style.width = '100%';
                progressBar.style.height = '10px';
                form.appendChild(progressBar);
            }

            let progressLabel = form.querySelector('.zip-progress-label');
            if (!progressLabel) {
                progressLabel = document.createElement('div');
                progressLabel.classList.add('zip-progress-label');
                form.appendChild(progressLabel);
            }

            progressLabel.textContent = `${capitalize(state.phase)} ${Math.round(progress)}%`;

            progressBar.style.display = 'none';
            progressBar.value = progress;
            progressBar.style.display = 'block';

            requestAnimationFrame(() => {
                progressBar.style.display = 'block';
                progressBar.offsetHeight;
            });

            if (progress >= 100 && state.phase === 'compressing') {
                hideLoadingSpinner(form);
            }
        }
    });

    if (!formFound) {
        return;
    }
}

function capitalize(str) {
    return str.charAt(0).toUpperCase() + str.slice(1);
}

function throttle(func, limit) {
    let inThrottle;
    return function (...args) {
        if (!inThrottle) {
            func.apply(this, args);
            inThrottle = true;
            setTimeout(() => (inThrottle = false), limit);
        }
    };
}

function updatePathInput(path) {
    const pathInput = document.getElementById('path-input');
    pathInput.value = path;
}

function joinPath(basePath, name) {
    if (basePath.endsWith('/')) {
        return `${basePath}${name}`;
    }
    return `${basePath}/${name}`;
}
