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
let currentUser = null;
let progressThemeObserver = null;
let socketReconnectTimer = null;
let socketStabilityTimer = null;
let socketReconnectAttempt = 0;
let socketStopped = false;
let socketPreOpenFailureCount = 0;
let socketPreOpenCheckInFlight = false;
let socketLifecycleGeneration = 0;
const SOCKET_MAX_PREOPEN_FAILURES = 3;

const SFTP_PROGRESS_BULGE = {
    viewW: 1000,
    viewH: 20,
    capSegments: 180,
    midSegments: 220,
    amp: 4.5,
    sigma: 90,
    hoverStrength: 0.7
};
let sftpProgressId = 0;

function isGlassThemeActive() {
    const stylesheetHref = document.getElementById('theme-stylesheet')?.getAttribute('href') || '';
    if (stylesheetHref.includes('style.flat.css')) {
        return false;
    }
    if (document.body.dataset.uiTheme === 'flat') {
        return false;
    }
    return true;
}

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
        alert('You are not authenticated.');
        redirectToLogin();
        return null;
    }

    const res = await fetch('/me', {
        headers: {
            'Authorization': 'Bearer ' + token
        }
    });

    if (!res.ok) {
        alert('Session expired. Please log in again.');
        redirectToLogin();
        return null;
    }

    const user = await res.json();
    if (user.mustResetPassword) {
        redirectToSetPassword();
        return null;
    }

    return user;
}


function handleAuthResponse(response) {
    if (response.status === 428) {
        alert('You must set a new password before continuing.');
        redirectToSetPassword();
        throw new Error('PASSWORD_RESET_REQUIRED');
    }
    if (response.status === 401 || response.status === 403) {
        alert('Session has expired, please log in again.');
        redirectToLogin();
        throw new Error('SESSION_EXPIRED');
    }
    return response;
}

function capsuleHalfHeight(x, width, radius) {
    if (x < radius) {
        return Math.sqrt(Math.max(0, radius * radius - Math.pow(x - radius, 2)));
    }
    if (x > width - radius) {
        return Math.sqrt(Math.max(0, radius * radius - Math.pow(x - (width - radius), 2)));
    }
    return radius;
}

function progressHalfHeight(x, centerX, strength) {
    const { viewW, viewH, amp, sigma } = SFTP_PROGRESS_BULGE;
    const radius = viewH / 2;
    const clampedX = Math.min(Math.max(x, 0), viewW);
    const dx = clampedX - centerX;
    const bump = (amp * strength) * Math.exp(-(dx * dx) / (2 * sigma * sigma));
    const baseHalf = capsuleHalfHeight(clampedX, viewW, radius);
    return baseHalf + bump;
}

function getProgressSampleXs() {
    if (SFTP_PROGRESS_BULGE._sampleXs) {
        return SFTP_PROGRESS_BULGE._sampleXs;
    }

    const { viewW, viewH, capSegments, midSegments } = SFTP_PROGRESS_BULGE;
    const radius = viewH / 2;
    const xs = [];

    const leftCapSteps = Math.max(6, capSegments);
    const rightCapSteps = Math.max(6, capSegments);
    const midSteps = Math.max(12, midSegments);

    for (let i = 0; i <= leftCapSteps; i += 1) {
        xs.push((i / leftCapSteps) * radius);
    }

    const midSpan = Math.max(0, viewW - 2 * radius);
    for (let i = 1; i <= midSteps; i += 1) {
        xs.push(radius + (i / midSteps) * midSpan);
    }

    for (let i = 1; i <= rightCapSteps; i += 1) {
        xs.push(viewW - radius + (i / rightCapSteps) * radius);
    }

    SFTP_PROGRESS_BULGE._sampleXs = xs;
    return xs;
}

function buildProgressBulgePath(centerX, strength, extra = 0) {
    const { viewW, viewH } = SFTP_PROGRESS_BULGE;
    const radius = viewH / 2;
    const cy = radius;
    const top = [];
    const bottom = [];

    const xs = getProgressSampleXs();
    for (let i = 0; i < xs.length; i += 1) {
        const x = Math.min(Math.max(xs[i], 0), viewW);
        const half = progressHalfHeight(x, centerX, strength) + extra;
        top.push([x, cy - half]);
        bottom.push([x, cy + half]);
    }

    let d = `M ${top[0][0].toFixed(2)} ${top[0][1].toFixed(2)}`;
    for (let i = 1; i < top.length; i += 1) {
        d += ` L ${top[i][0].toFixed(2)} ${top[i][1].toFixed(2)}`;
    }
    for (let i = bottom.length - 1; i >= 0; i -= 1) {
        d += ` L ${bottom[i][0].toFixed(2)} ${bottom[i][1].toFixed(2)}`;
    }
    d += ' Z';
    return d;
}

function buildProgressFillPath(centerX, strength, progress) {
    const { viewW, viewH } = SFTP_PROGRESS_BULGE;
    const progressValue = Math.max(0, Math.min(100, Number(progress) || 0));
    const progressX = (progressValue / 100) * viewW;

    if (progressValue <= 0.1) {
        return '';
    }
    if (progressValue >= 99.9) {
        return buildProgressBulgePath(centerX, strength);
    }

    const radius = viewH / 2;
    const cy = radius;
    let capRadius = progressHalfHeight(progressX, centerX, strength);
    capRadius = Math.min(capRadius, progressX);
    let capStartX = Math.max(0, progressX - capRadius);
    for (let i = 0; i < 3; i += 1) {
        capRadius = progressHalfHeight(capStartX, centerX, strength);
        capRadius = Math.min(capRadius, progressX);
        capStartX = Math.max(0, progressX - capRadius);
    }

    const top = [];
    const bottom = [];

    const xs = getProgressSampleXs();
    for (let i = 0; i < xs.length; i += 1) {
        const x = xs[i];
        if (x > capStartX) {
            break;
        }
        const half = progressHalfHeight(x, centerX, strength);
        top.push([x, cy - half]);
        bottom.push([x, cy + half]);
    }

    if (!top.length || Math.abs(top[top.length - 1][0] - capStartX) > 0.01) {
        top.push([capStartX, cy - capRadius]);
        bottom.push([capStartX, cy + capRadius]);
    }

    const arcPoints = [];
    const arcSteps = 36;
    if (capRadius > 0.01) {
        for (let i = 1; i <= arcSteps; i += 1) {
            const theta = (-Math.PI / 2) + (i / arcSteps) * Math.PI;
            const x = capStartX + capRadius * Math.cos(theta);
            const y = cy + capRadius * Math.sin(theta);
            arcPoints.push([x, y]);
        }
    }

    let d = `M ${top[0][0].toFixed(2)} ${top[0][1].toFixed(2)}`;
    for (let i = 1; i < top.length; i += 1) {
        d += ` L ${top[i][0].toFixed(2)} ${top[i][1].toFixed(2)}`;
    }
    arcPoints.forEach(([x, y]) => {
        d += ` L ${x.toFixed(2)} ${y.toFixed(2)}`;
    });
    for (let i = bottom.length - 1; i >= 0; i -= 1) {
        d += ` L ${bottom[i][0].toFixed(2)} ${bottom[i][1].toFixed(2)}`;
    }
    d += ' Z';
    return d;
}

function refreshProgressVisual(container) {
    if (!container || !container._progressTrackOutline || !container._progressTrackFill || !container._progressFill) {
        return;
    }

    const centerX = container._progressCenter ?? (SFTP_PROGRESS_BULGE.viewW / 2);
    const strength = container._progressStrength ?? 0;
    const progressValue = container._progressValue ?? 0;

    const trackPath = buildProgressBulgePath(centerX, strength);
    const outlinePath = buildProgressBulgePath(centerX, strength, 1.5);
    container._progressTrackOutline.setAttribute('d', outlinePath);
    container._progressTrackFill.setAttribute('d', trackPath);
    if (container._progressTrackSpec) {
        container._progressTrackSpec.setAttribute('d', trackPath);
    }
    if (container._progressTrackGloss) {
        container._progressTrackGloss.setAttribute('d', trackPath);
    }

    const fillPath = buildProgressFillPath(centerX, strength, progressValue);
    container._progressFill.setAttribute('d', fillPath);
    container._progressFill.style.opacity = fillPath ? '1' : '0';
    if (container._progressFillSpec) {
        container._progressFillSpec.setAttribute('d', fillPath);
        container._progressFillSpec.style.opacity = fillPath ? '1' : '0';
    }
    if (container._progressFillGloss) {
        container._progressFillGloss.setAttribute('d', fillPath);
    }
}

function setProgressBulge(container, centerPx, strength) {
    if (!container) {
        return;
    }
    const rect = container.getBoundingClientRect();
    if (!rect.width) {
        return;
    }
    const clampedTrackX = Math.min(Math.max(centerPx, 0), rect.width);
    const trackCx = (clampedTrackX / rect.width) * SFTP_PROGRESS_BULGE.viewW;
    container._progressCenter = trackCx;
    container._progressStrength = Math.min(0.7, Math.max(0, strength));
    refreshProgressVisual(container);
}

function setProgressLighting(container, x, y, intensity = 1) {
    if (!container || !container._progressGloss) {
        return;
    }
    const rect = container.getBoundingClientRect();
    if (!rect.width || !rect.height) {
        return;
    }
    const cx = (x / rect.width) * SFTP_PROGRESS_BULGE.viewW;
    const cy = (y / rect.height) * SFTP_PROGRESS_BULGE.viewH;
    container._progressGloss.setAttribute('cx', cx.toFixed(2));
    container._progressGloss.setAttribute('cy', cy.toFixed(2));
    container.style.setProperty('--light', intensity.toFixed(2));
    container.classList.add('progress-lit');
}

function clearProgressLighting(container) {
    if (!container || !container._progressGloss) {
        return;
    }
    container.style.setProperty('--light', '0');
    container.classList.remove('progress-lit');
}

function createProgressVisual(container) {
    if (!container || container._progressVisual) {
        return;
    }

    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.classList.add('sftp-progress-visual');
    svg.setAttribute('viewBox', `0 0 ${SFTP_PROGRESS_BULGE.viewW} ${SFTP_PROGRESS_BULGE.viewH}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('aria-hidden', 'true');

    const uid = `sftp-progress-${sftpProgressId++}`;
    const defs = document.createElementNS(ns, 'defs');

    const gradient = document.createElementNS(ns, 'linearGradient');
    gradient.setAttribute('id', `${uid}-fill`);
    gradient.setAttribute('x1', '0');
    gradient.setAttribute('y1', '0');
    gradient.setAttribute('x2', '0');
    gradient.setAttribute('y2', '1');
    [
        { offset: '0%', color: '#4CAF50', opacity: '0.95' },
        { offset: '60%', color: '#4CAF50', opacity: '0.75' },
        { offset: '100%', color: '#388E3C', opacity: '0.95' }
    ].forEach(({ offset, color, opacity }) => {
        const stop = document.createElementNS(ns, 'stop');
        stop.setAttribute('offset', offset);
        stop.setAttribute('stop-color', color);
        stop.setAttribute('stop-opacity', opacity);
        gradient.appendChild(stop);
    });

    const gloss = document.createElementNS(ns, 'radialGradient');
    gloss.setAttribute('id', `${uid}-gloss`);
    gloss.setAttribute('gradientUnits', 'userSpaceOnUse');
    gloss.setAttribute('cx', String(SFTP_PROGRESS_BULGE.viewW / 2));
    gloss.setAttribute('cy', String(SFTP_PROGRESS_BULGE.viewH * 0.5));
    gloss.setAttribute('r', String(SFTP_PROGRESS_BULGE.viewW * 0.05));
    [
        { offset: '0%', color: '#ffffff', opacity: '0.42' },
        { offset: '55%', color: '#ffffff', opacity: '0.12' },
        { offset: '100%', color: '#ffffff', opacity: '0' }
    ].forEach(({ offset, color, opacity }) => {
        const stop = document.createElementNS(ns, 'stop');
        stop.setAttribute('offset', offset);
        stop.setAttribute('stop-color', color);
        stop.setAttribute('stop-opacity', opacity);
        gloss.appendChild(stop);
    });

    const trackGradient = document.createElementNS(ns, 'linearGradient');
    trackGradient.setAttribute('id', `${uid}-track`);
    trackGradient.setAttribute('x1', '0');
    trackGradient.setAttribute('y1', '0');
    trackGradient.setAttribute('x2', '0');
    trackGradient.setAttribute('y2', '1');
    [
        { offset: '0%', color: '#2f2f2f', opacity: '0.95' },
        { offset: '45%', color: '#1f1f1f', opacity: '0.95' },
        { offset: '100%', color: '#121212', opacity: '1' }
    ].forEach(({ offset, color, opacity }) => {
        const stop = document.createElementNS(ns, 'stop');
        stop.setAttribute('offset', offset);
        stop.setAttribute('stop-color', color);
        stop.setAttribute('stop-opacity', opacity);
        trackGradient.appendChild(stop);
    });

    const trackSpec = document.createElementNS(ns, 'linearGradient');
    trackSpec.setAttribute('id', `${uid}-track-spec`);
    trackSpec.setAttribute('x1', '0');
    trackSpec.setAttribute('y1', '0');
    trackSpec.setAttribute('x2', '0');
    trackSpec.setAttribute('y2', '1');
    [
        { offset: '0%', color: '#ffffff', opacity: '0.45' },
        { offset: '35%', color: '#ffffff', opacity: '0.12' },
        { offset: '70%', color: '#ffffff', opacity: '0' }
    ].forEach(({ offset, color, opacity }) => {
        const stop = document.createElementNS(ns, 'stop');
        stop.setAttribute('offset', offset);
        stop.setAttribute('stop-color', color);
        stop.setAttribute('stop-opacity', opacity);
        trackSpec.appendChild(stop);
    });

    const fillSpec = document.createElementNS(ns, 'linearGradient');
    fillSpec.setAttribute('id', `${uid}-fill-spec`);
    fillSpec.setAttribute('x1', '0');
    fillSpec.setAttribute('y1', '0');
    fillSpec.setAttribute('x2', '0');
    fillSpec.setAttribute('y2', '1');
    [
        { offset: '0%', color: '#ffffff', opacity: '0.5' },
        { offset: '35%', color: '#ffffff', opacity: '0.18' },
        { offset: '70%', color: '#ffffff', opacity: '0' }
    ].forEach(({ offset, color, opacity }) => {
        const stop = document.createElementNS(ns, 'stop');
        stop.setAttribute('offset', offset);
        stop.setAttribute('stop-color', color);
        stop.setAttribute('stop-opacity', opacity);
        fillSpec.appendChild(stop);
    });

    defs.appendChild(gradient);
    defs.appendChild(gloss);
    defs.appendChild(trackGradient);
    defs.appendChild(trackSpec);
    defs.appendChild(fillSpec);
    svg.appendChild(defs);

    const basePathD = buildProgressBulgePath(SFTP_PROGRESS_BULGE.viewW / 2, 0);
    const trackOutline = document.createElementNS(ns, 'path');
    trackOutline.classList.add('sftp-progress-track-outline');
    trackOutline.setAttribute('d', basePathD);

    const trackGloss = document.createElementNS(ns, 'path');
    trackGloss.classList.add('sftp-progress-track-gloss');
    trackGloss.setAttribute('d', basePathD);
    trackGloss.setAttribute('fill', `url(#${uid}-gloss)`);

    const trackFill = document.createElementNS(ns, 'path');
    trackFill.classList.add('sftp-progress-track-fill');
    trackFill.setAttribute('d', basePathD);
    trackFill.setAttribute('fill', `url(#${uid}-track)`);

    const trackSpecPath = document.createElementNS(ns, 'path');
    trackSpecPath.classList.add('sftp-progress-track-spec');
    trackSpecPath.setAttribute('d', basePathD);
    trackSpecPath.setAttribute('fill', `url(#${uid}-track-spec)`);

    const fillPath = document.createElementNS(ns, 'path');
    fillPath.classList.add('sftp-progress-fill');
    fillPath.setAttribute('d', basePathD);
    fillPath.setAttribute('fill', `url(#${uid}-fill)`);

    const fillGloss = document.createElementNS(ns, 'path');
    fillGloss.classList.add('sftp-progress-fill-gloss');
    fillGloss.setAttribute('d', basePathD);
    fillGloss.setAttribute('fill', `url(#${uid}-gloss)`);

    const fillSpecPath = document.createElementNS(ns, 'path');
    fillSpecPath.classList.add('sftp-progress-fill-spec');
    fillSpecPath.setAttribute('d', basePathD);
    fillSpecPath.setAttribute('fill', `url(#${uid}-fill-spec)`);

    svg.appendChild(trackOutline);
    svg.appendChild(trackFill);
    svg.appendChild(trackSpecPath);
    svg.appendChild(trackGloss);
    svg.appendChild(fillPath);
    svg.appendChild(fillSpecPath);
    svg.appendChild(fillGloss);

    container.insertBefore(svg, container.firstChild);

    container._progressVisual = svg;
    container._progressTrackOutline = trackOutline;
    container._progressTrackFill = trackFill;
    container._progressTrackSpec = trackSpecPath;
    container._progressTrackGloss = trackGloss;
    container._progressFill = fillPath;
    container._progressFillSpec = fillSpecPath;
    container._progressFillGloss = fillGloss;
    container._progressGloss = gloss;
    container._progressValue = 0;
    container._progressCenter = SFTP_PROGRESS_BULGE.viewW / 2;
    container._progressStrength = 0;
    refreshProgressVisual(container);
}

function attachProgressPointer(container) {
    if (!container || container._progressPointerAttached) {
        return;
    }

    const handleMove = (event) => {
        if (document.body.dataset.uiTheme !== 'glass') {
            return;
        }
        const rect = container.getBoundingClientRect();
        if (!rect.width || !rect.height) {
            return;
        }
        const x = event.clientX - rect.left;
        const y = event.clientY - rect.top;
        const nx = (x - rect.width / 2) / (rect.width / 2);
        const ny = (y - rect.height / 2) / (rect.height / 2);
        const dist = Math.min(Math.sqrt(nx * nx + ny * ny), 1);
        const lightPop = Math.max(0, 1 - dist);
        setProgressBulge(container, x, SFTP_PROGRESS_BULGE.hoverStrength);
        setProgressLighting(container, x, y, lightPop * 0.8);
    };

    const handleLeave = () => {
        setProgressBulge(container, 0, 0);
        clearProgressLighting(container);
    };

    container.addEventListener('pointermove', handleMove);
    container.addEventListener('pointerleave', handleLeave);
    container.addEventListener('pointercancel', handleLeave);
    container._progressPointerAttached = true;
}

function ensureGlassProgress(progressEl) {
    if (!progressEl) {
        return null;
    }
    if (!Object.prototype.hasOwnProperty.call(progressEl.dataset, 'origWidth')) {
        progressEl.dataset.origWidth = progressEl.style.width || '';
    }

    let wrapper = progressEl.closest('.glass-progress');
    if (!wrapper) {
        wrapper = document.createElement('div');
        wrapper.classList.add('glass-progress');
        const width = progressEl.dataset.origWidth || progressEl.style.width || '100%';
        wrapper.style.width = width;
        wrapper.style.margin = '0 auto';
        progressEl.parentNode.insertBefore(wrapper, progressEl);
        wrapper.appendChild(progressEl);
    }
    progressEl.style.width = '100%';
    if (!wrapper._progressVisual) {
        createProgressVisual(wrapper);
    }
    attachProgressPointer(wrapper);
    progressEl._glassWrapper = wrapper;
    return wrapper;
}

function updateGlassProgressValue(progressEl, value) {
    if (!progressEl) {
        return;
    }
    const wrapper = progressEl._glassWrapper || ensureGlassProgress(progressEl);
    if (!wrapper) {
        return;
    }
    wrapper._progressValue = Number(value) || 0;
    refreshProgressVisual(wrapper);
}

function teardownGlassProgress(progressEl) {
    if (!progressEl) {
        return;
    }
    const wrapper = progressEl._glassWrapper || progressEl.closest('.glass-progress');
    if (!wrapper) {
        return;
    }
    if (wrapper.parentNode) {
        wrapper.parentNode.insertBefore(progressEl, wrapper);
        wrapper.remove();
    }
    const originalWidth = Object.prototype.hasOwnProperty.call(progressEl.dataset, 'origWidth')
        ? progressEl.dataset.origWidth
        : '';
    if (originalWidth) {
        progressEl.style.width = originalWidth;
    } else {
        progressEl.style.removeProperty('width');
    }
    delete progressEl._glassWrapper;
}

function getProgressBarsForSync() {
    const bars = [];
    const upload = document.getElementById('upload-progress');
    if (upload) {
        bars.push(upload);
    }
    document.querySelectorAll('.zip-progress-bar').forEach((bar) => bars.push(bar));
    return bars;
}

function syncProgressMode() {
    const useGlass = isGlassThemeActive();
    document.body.classList.toggle('sftp-progress-flat', !useGlass);
    getProgressBarsForSync().forEach((bar) => {
        if (useGlass) {
            ensureGlassProgress(bar);
            updateGlassProgressValue(bar, Number(bar.value) || 0);
            return;
        }
        teardownGlassProgress(bar);
    });
}

function observeProgressThemeChanges() {
    if (progressThemeObserver) {
        return;
    }
    progressThemeObserver = new MutationObserver((mutations) => {
        if (mutations.some((m) =>
            m.type === 'attributes' &&
            (m.attributeName === 'data-ui-theme' || m.attributeName === 'href')
        )) {
            syncProgressMode();
        }
    });
    progressThemeObserver.observe(document.body, {
        attributes: true,
        attributeFilter: ['data-ui-theme']
    });

    const themeStylesheet = document.getElementById('theme-stylesheet');
    if (themeStylesheet) {
        progressThemeObserver.observe(themeStylesheet, {
            attributes: true,
            attributeFilter: ['href']
        });
    }
}

async function handleSocketPreOpenFailure() {
    if (socketPreOpenCheckInFlight || socketStopped) {
        return;
    }
    socketPreOpenCheckInFlight = true;
    const generation = socketLifecycleGeneration;
    try {
        const token = localStorage.getItem('token');
        const response = await fetch('/me', {
            headers: token ? { 'Authorization': 'Bearer ' + token } : {},
            cache: 'no-store',
            credentials: 'same-origin'
        });
        if (generation !== socketLifecycleGeneration) {
            return;
        }
        if (response.status === 428) {
            redirectToSetPassword();
            return;
        }
        if (response.status === 401 || response.status === 403) {
            redirectToLogin();
            return;
        }
        socketStopped = true;
        console.error('WebSocket upgrade failed repeatedly; automatic reconnect stopped until reload.');
    } catch (error) {
        if (generation !== socketLifecycleGeneration) {
            return;
        }
        socketStopped = true;
        console.error('WebSocket upgrade and authentication revalidation both failed; automatic reconnect stopped.');
    } finally {
        if (generation === socketLifecycleGeneration) {
            socketPreOpenCheckInFlight = false;
        }
    }
}

function setupWebSocket() {
    if (socketStopped || (window.ws && (
        window.ws.readyState === WebSocket.OPEN || window.ws.readyState === WebSocket.CONNECTING
    ))) {
        return;
    }

    const wsProtocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${wsProtocol}://${window.location.host}/ws`);
    window.ws = socket;
    let opened = false;

    socket.onopen = function () {
        if (window.ws !== socket) {
            socket.close();
            return;
        }
        opened = true;
        if (socketStabilityTimer) {
            clearTimeout(socketStabilityTimer);
        }
        socketStabilityTimer = setTimeout(() => {
            socketReconnectAttempt = 0;
            socketPreOpenFailureCount = 0;
            socketStabilityTimer = null;
        }, 10000);
    };

    socket.onmessage = function (event) {
        if (window.ws !== socket) {
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
            return;
        }

        if (typeof message.requestId !== 'string' || !message.requestId) {
            return;
        }

        const requestId = message.requestId;
        if (message.type === 'progress') {
            updateZipProgress(requestId, message.progress);
        } else if (message.type === 'complete') {
            const form = findDownloadForm(requestId);
            const tracked = Object.prototype.hasOwnProperty.call(downloadWindows, requestId);
            if (!form && !tracked) {
                return;
            }
            if (form) {
                hideLoadingSpinner(form);
                delete form.dataset.requestId;
            }

            const downloadUrl = `${window.location.origin}/downloads/${requestId}`;
            const popup = downloadWindows[requestId];

            if (popup && !popup.closed) {
                popup.location = downloadUrl;
            } else {
                window.open(downloadUrl, '_blank');
            }

            delete downloadWindows[requestId];
        } else if (message.type === 'download-error') {
            const form = findDownloadForm(requestId);
            const tracked = Object.prototype.hasOwnProperty.call(downloadWindows, requestId);
            if (!form && !tracked) {
                return;
            }
            if (form) {
                hideLoadingSpinner(form);
                delete form.dataset.requestId;
            }
            const popup = downloadWindows[requestId];
            if (popup && !popup.closed) {
                popup.close();
            }
            delete downloadWindows[requestId];
            delete progressStateMap[requestId];
            alert('Download preparation failed. The file may have changed; refresh the directory and try again.');
        }
    };

    socket.onerror = function () {
        socket.close();
    };

    socket.onclose = function (event) {
        if (window.ws !== socket) {
            return;
        }
        window.ws = null;
        if (socketStabilityTimer) {
            clearTimeout(socketStabilityTimer);
            socketStabilityTimer = null;
        }
        if (socketStopped) return;
        if (event.code === 1008) {
            redirectToLogin();
            return;
        }
        if (!opened) {
            socketPreOpenFailureCount += 1;
            if (socketPreOpenFailureCount >= SOCKET_MAX_PREOPEN_FAILURES) {
                handleSocketPreOpenFailure();
                return;
            }
        }
        if (socketReconnectTimer) return;
        const base = Math.min(1000 * (2 ** socketReconnectAttempt), 30000);
        socketReconnectAttempt = Math.min(socketReconnectAttempt + 1, 5);
        const delay = Math.min(30000, Math.round(base * (0.75 + Math.random() * 0.5)));
        socketReconnectTimer = setTimeout(() => {
            socketReconnectTimer = null;
            setupWebSocket();
        }, delay);
    };
}

window.addEventListener('pagehide', () => {
    socketLifecycleGeneration += 1;
    socketPreOpenCheckInFlight = false;
    socketStopped = true;
    if (socketReconnectTimer) {
        clearTimeout(socketReconnectTimer);
        socketReconnectTimer = null;
    }
    if (socketStabilityTimer) {
        clearTimeout(socketStabilityTimer);
        socketStabilityTimer = null;
    }
    if (window.ws && (window.ws.readyState === WebSocket.OPEN || window.ws.readyState === WebSocket.CONNECTING)) {
        window.ws.close(1000, 'page hidden');
    }
});

window.addEventListener('pageshow', async (event) => {
    if (event.persisted) {
        socketReconnectAttempt = 0;
        socketPreOpenFailureCount = 0;
        const restoredUser = await loadCurrentUser().catch(() => null);
        if (!restoredUser) {
            socketStopped = true;
            return;
        }
        if (currentUser && (
            currentUser.id !== restoredUser.id
            || currentUser.role !== restoredUser.role
            || currentUser.username !== restoredUser.username
        )) {
            window.location.reload();
            return;
        }
        currentUser = restoredUser;
        socketStopped = false;
        setupWebSocket();
        fetchFiles(currentDisplayedPath || getInitialPath(), false, true);
    }
});

function getInitialPath() {
    const params = new URLSearchParams(window.location.search);
    return params.get('path') || '/';
}

// Ensure the WebSocket is only initialized once on DOMContentLoaded
document.addEventListener('DOMContentLoaded', async function () {
    currentUser = await loadCurrentUser();
    if (!currentUser) {
        return;
    }
    if (window.Appearance && typeof window.Appearance.init === 'function') {
        window.Appearance.init({ user: currentUser });
    }
    observeProgressThemeChanges();
    syncProgressMode();
    setupWebSocket();
    fetchFiles(getInitialPath(), false, true);

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
            handleAuthResponse(response);
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

                            handleAuthResponse(res);
                            if (!res.ok) {
                                throw new Error(res.statusText);
                            }

                            const responseData = await res.json();
                            const acceptedRequestId = typeof responseData.requestId === 'string' && responseData.requestId
                                ? responseData.requestId
                                : requestId;
                            if (acceptedRequestId !== requestId
                                && Object.prototype.hasOwnProperty.call(downloadWindows, requestId)) {
                                downloadWindows[acceptedRequestId] = downloadWindows[requestId];
                                delete downloadWindows[requestId];
                                delete progressStateMap[requestId];
                            }
                            if (Object.prototype.hasOwnProperty.call(downloadWindows, acceptedRequestId)) {
                                this.dataset.requestId = acceptedRequestId;
                            }
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
            handleAuthResponse(response);
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
        progressBar.style.height = '20px';
        form.appendChild(progressBar);
    } else {
        progressBar.value = 0;
        progressBar.max = 100;
        progressBar.style.display = 'block';
    }

    if (isGlassThemeActive()) {
        ensureGlassProgress(progressBar);
        updateGlassProgressValue(progressBar, 0);
    } else {
        teardownGlassProgress(progressBar);
    }

    form.dataset.requestId = requestId;
}

function hideLoadingSpinner(form) {
    const progressBar = form.querySelector('.zip-progress-bar');
    if (progressBar) {
        progressBar.remove();
    }

    const glassWrapper = form.querySelector('.glass-progress');
    if (glassWrapper) {
        glassWrapper.remove();
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

function findDownloadForm(requestId) {
    return Array.from(document.querySelectorAll('form[data-request-id]'))
        .find((form) => form.dataset.requestId === requestId) || null;
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
    handleAuthResponse(response);

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
    if (isGlassThemeActive()) {
        ensureGlassProgress(progressBar);
        updateGlassProgressValue(progressBar, 0);
    } else {
        teardownGlassProgress(progressBar);
    }
    uploadPercentage.textContent = 'Uploading...';

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/upload', true);
    xhr.setRequestHeader('Authorization', 'Bearer ' + token);

    xhr.upload.onprogress = function (event) {
        if (event.lengthComputable) {
            const percentComplete = (event.loaded / event.total) * 100;
            progressBar.value = percentComplete;
            if (isGlassThemeActive()) {
                updateGlassProgressValue(progressBar, percentComplete);
            }
            uploadPercentage.textContent = `${Math.round(percentComplete)}%`;

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
        if (isGlassThemeActive()) {
            updateGlassProgressValue(progressBar, 0);
        }
        uploadPercentage.textContent = '';
        uploadButton.style.display = 'block';
    };

    xhr.onerror = function () {
        alert('Upload failed: ' + xhr.statusText);

        progressContainer.style.display = 'none';
        progressBar.value = 0;
        if (isGlassThemeActive()) {
            updateGlassProgressValue(progressBar, 0);
        }
        uploadPercentage.textContent = '';
        uploadButton.style.display = 'block';
    };

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
        .then(response => {
            handleAuthResponse(response);
            return response.blob();
        })
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
        .then(response => {
            handleAuthResponse(response);
            return response.blob();
        })
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
        .then(response => {
            handleAuthResponse(response);
            return response.blob();
        })
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
    const safeProgress = Math.max(0, Math.min(100, Number(progress) || 0));
    const form = findDownloadForm(requestId);
    if (!form) {
        return;
    }

    if (!progressStateMap[requestId]) {
        progressStateMap[requestId] = { lastProgress: -1, phase: 'retrieving' };
    }

    const state = progressStateMap[requestId];

    if (state.phase === 'retrieving' && safeProgress <= 1 && state.lastProgress >= 98) {
        state.phase = 'compressing';
    }

    state.lastProgress = safeProgress;

    let progressBar = form.querySelector('.zip-progress-bar');

    if (!progressBar) {
        progressBar = document.createElement('progress');
        progressBar.classList.add('zip-progress-bar');
        progressBar.value = 0;
        progressBar.max = 100;
        progressBar.style.width = '100%';
        progressBar.style.height = '20px';
        form.appendChild(progressBar);
    }

    let progressLabel = form.querySelector('.zip-progress-label');
    if (!progressLabel) {
        progressLabel = document.createElement('div');
        progressLabel.classList.add('zip-progress-label');
        form.appendChild(progressLabel);
    }

    progressLabel.textContent = `${capitalize(state.phase)} ${Math.round(safeProgress)}%`;

    progressBar.value = safeProgress;
    if (isGlassThemeActive()) {
        ensureGlassProgress(progressBar);
        updateGlassProgressValue(progressBar, safeProgress);
    } else {
        teardownGlassProgress(progressBar);
    }

    if (safeProgress >= 100 && state.phase === 'compressing') {
        hideLoadingSpinner(form);
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
