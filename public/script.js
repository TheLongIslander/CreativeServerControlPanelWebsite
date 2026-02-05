/*
 * Purpose: Control panel UI logic for server actions, backups, and maintenance redirects.
 * Functions: setupWebSocket, checkServerStatus, updateBackupProgress, setBackupState,
 *            handleFetchResponse, and action button handlers.
 */
let isBackingUp = false;
let ws;

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

function setupAccountMenu(user) {
    const accountButton = document.getElementById('account-button');
    const dropdown = document.getElementById('account-dropdown');
    const adminButton = document.getElementById('admin-management-button');
    const logoutButton = document.getElementById('logout-button');
    const manageButton = document.getElementById('manage-account-button');

    if (user) {
        accountButton.dataset.username = user.username || '';
    }

    if (user && user.role === 'admin') {
        adminButton.classList.remove('hidden');
        adminButton.addEventListener('click', () => {
            window.location.href = '/admin.html';
        });
    } else {
        adminButton.classList.add('hidden');
    }

    accountButton.addEventListener('click', (event) => {
        event.stopPropagation();
        dropdown.classList.toggle('hidden');
    });

    document.addEventListener('click', () => {
        if (!dropdown.classList.contains('hidden')) {
            dropdown.classList.add('hidden');
        }
    });

    logoutButton.addEventListener('click', function() {
        logout();
    });

    manageButton.addEventListener('click', function() {
        window.location.href = '/account.html';
    });
}

const PROGRESS_BULGE = {
    viewW: 1000,
    viewH: 20,
    capSegments: 180,
    midSegments: 220,
    amp: 4.5,
    sigma: 90,
    hoverStrength: 0.7
};

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
    const { viewW, viewH, amp, sigma } = PROGRESS_BULGE;
    const radius = viewH / 2;
    const clampedX = Math.min(Math.max(x, 0), viewW);
    const dx = clampedX - centerX;
    const bump = (amp * strength) * Math.exp(-(dx * dx) / (2 * sigma * sigma));
    const baseHalf = capsuleHalfHeight(clampedX, viewW, radius);
    return baseHalf + bump;
}

function getProgressSampleXs() {
    if (PROGRESS_BULGE._sampleXs) {
        return PROGRESS_BULGE._sampleXs;
    }

    const { viewW, viewH, capSegments, midSegments } = PROGRESS_BULGE;
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

    PROGRESS_BULGE._sampleXs = xs;
    return xs;
}

function buildProgressBulgePath(centerX, strength, extra = 0) {
    const { viewW, viewH } = PROGRESS_BULGE;
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
    const { viewW, viewH } = PROGRESS_BULGE;
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

function setupProgressBulge() {
    const container = document.getElementById('progress-container');
    if (!container) {
        return;
    }

    if (container._progressVisual) {
        return;
    }

    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.classList.add('progress-visual');
    svg.setAttribute('viewBox', `0 0 ${PROGRESS_BULGE.viewW} ${PROGRESS_BULGE.viewH}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('aria-hidden', 'true');

    const defs = document.createElementNS(ns, 'defs');
    const gradient = document.createElementNS(ns, 'linearGradient');
    gradient.setAttribute('id', 'progressGradient');
    gradient.setAttribute('x1', '0');
    gradient.setAttribute('y1', '0');
    gradient.setAttribute('x2', '0');
    gradient.setAttribute('y2', '1');

    const stops = [
        { offset: '0%', color: '#4CAF50', opacity: '0.95' },
        { offset: '60%', color: '#4CAF50', opacity: '0.75' },
        { offset: '100%', color: '#388E3C', opacity: '0.95' }
    ];

    stops.forEach(({ offset, color, opacity }) => {
        const stop = document.createElementNS(ns, 'stop');
        stop.setAttribute('offset', offset);
        stop.setAttribute('stop-color', color);
        stop.setAttribute('stop-opacity', opacity);
        gradient.appendChild(stop);
    });

    const gloss = document.createElementNS(ns, 'radialGradient');
    gloss.setAttribute('id', 'progressGloss');
    gloss.setAttribute('gradientUnits', 'userSpaceOnUse');
    gloss.setAttribute('cx', String(PROGRESS_BULGE.viewW / 2));
    gloss.setAttribute('cy', String(PROGRESS_BULGE.viewH * 0.5));
    gloss.setAttribute('r', String(PROGRESS_BULGE.viewW * 0.05));
    const glossStops = [
        { offset: '0%', color: '#ffffff', opacity: '0.42' },
        { offset: '55%', color: '#ffffff', opacity: '0.12' },
        { offset: '100%', color: '#ffffff', opacity: '0' }
    ];
    glossStops.forEach(({ offset, color, opacity }) => {
        const stop = document.createElementNS(ns, 'stop');
        stop.setAttribute('offset', offset);
        stop.setAttribute('stop-color', color);
        stop.setAttribute('stop-opacity', opacity);
        gloss.appendChild(stop);
    });

    const trackGradient = document.createElementNS(ns, 'linearGradient');
    trackGradient.setAttribute('id', 'progressTrackGradient');
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
    trackSpec.setAttribute('id', 'progressTrackSpec');
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
    fillSpec.setAttribute('id', 'progressFillSpec');
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

    const basePathD = buildProgressBulgePath(PROGRESS_BULGE.viewW / 2, 0);
    const trackOutline = document.createElementNS(ns, 'path');
    trackOutline.classList.add('progress-track-outline');
    trackOutline.setAttribute('d', basePathD);

    const trackGloss = document.createElementNS(ns, 'path');
    trackGloss.classList.add('progress-track-gloss');
    trackGloss.setAttribute('d', basePathD);
    trackGloss.setAttribute('fill', 'url(#progressGloss)');

    const trackFill = document.createElementNS(ns, 'path');
    trackFill.classList.add('progress-track-fill');
    trackFill.setAttribute('d', basePathD);
    trackFill.setAttribute('fill', 'url(#progressTrackGradient)');

    const trackSpecPath = document.createElementNS(ns, 'path');
    trackSpecPath.classList.add('progress-track-spec');
    trackSpecPath.setAttribute('d', basePathD);
    trackSpecPath.setAttribute('fill', 'url(#progressTrackSpec)');

    const fillPath = document.createElementNS(ns, 'path');
    fillPath.classList.add('progress-fill');
    fillPath.setAttribute('d', basePathD);

    const fillGloss = document.createElementNS(ns, 'path');
    fillGloss.classList.add('progress-fill-gloss');
    fillGloss.setAttribute('d', basePathD);
    fillGloss.setAttribute('fill', 'url(#progressGloss)');

    const fillSpecPath = document.createElementNS(ns, 'path');
    fillSpecPath.classList.add('progress-fill-spec');
    fillSpecPath.setAttribute('d', basePathD);
    fillSpecPath.setAttribute('fill', 'url(#progressFillSpec)');

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
    container._progressCenter = PROGRESS_BULGE.viewW / 2;
    container._progressStrength = 0;
    refreshProgressVisual(container);
}

function refreshProgressVisual(container) {
    if (!container || !container._progressTrackOutline || !container._progressTrackFill || !container._progressFill) {
        return;
    }

    const centerX = container._progressCenter ?? (PROGRESS_BULGE.viewW / 2);
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

function setProgressLighting(x, y, intensity = 1) {
    const container = document.getElementById('progress-container');
    if (!container || !container._progressGloss) {
        return;
    }
    const rect = container.getBoundingClientRect();
    if (!rect.width || !rect.height) {
        return;
    }
    const cx = (x / rect.width) * PROGRESS_BULGE.viewW;
    const cy = (y / rect.height) * PROGRESS_BULGE.viewH;
    container._progressGloss.setAttribute('cx', cx.toFixed(2));
    container._progressGloss.setAttribute('cy', cy.toFixed(2));
    container.style.setProperty('--light', intensity.toFixed(2));
    container.classList.add('progress-lit');
}

function clearProgressLighting() {
    const container = document.getElementById('progress-container');
    if (!container || !container._progressGloss) {
        return;
    }
    container.style.setProperty('--light', '0');
    container.classList.remove('progress-lit');
}

function startProgressAnimation(container) {
    if (!container || container._progressAnimating) {
        return;
    }

    const step = () => {
        const target = container._progressTarget ?? 0;
        const currentValue = container._progressCurrent ?? container._progressValue ?? 0;
        const diff = target - currentValue;
        const smoothing = 0.18;
        const nextValue = Math.abs(diff) < 0.05 ? target : currentValue + diff * smoothing;

        container._progressCurrent = nextValue;
        container._progressValue = nextValue;
        refreshProgressVisual(container);

        if (Math.abs(diff) < 0.05) {
            container._progressAnimating = false;
            container._progressAnimFrame = null;
            return;
        }

        container._progressAnimFrame = requestAnimationFrame(step);
    };

    container._progressAnimating = true;
    container._progressAnimFrame = requestAnimationFrame(step);
}

function setProgressBulge(centerPx, strength) {
    const container = document.getElementById('progress-container');
    if (!container || !container._progressTrackOutline || !container._progressTrackFill || !container._progressFill) {
        return;
    }

    const containerRect = container.getBoundingClientRect();
    if (!containerRect.width) {
        return;
    }

    const clampedTrackX = Math.min(Math.max(centerPx, 0), containerRect.width);
    const trackCx = (clampedTrackX / containerRect.width) * PROGRESS_BULGE.viewW;
    container._progressCenter = trackCx;
    container._progressStrength = Math.min(0.7, Math.max(0, strength));
    refreshProgressVisual(container);
}

function setupPointerLighting() {
    const targets = [
        ...document.querySelectorAll('button'),
        document.getElementById('progress-container')
    ].filter(Boolean);

    const progressContainer = document.getElementById('progress-container');
    if (progressContainer && !progressContainer._progressLeaveHandler) {
        const handler = () => {
            setProgressBulge(0, 0);
            clearProgressLighting();
        };
        progressContainer.addEventListener('pointerleave', handler);
        progressContainer.addEventListener('pointercancel', handler);
        progressContainer._progressLeaveHandler = handler;
    }

    const resetTarget = (target) => {
        target.classList.remove('is-lit');
        const isProgress = target.id === 'progress-container';
        target.style.setProperty('--mx', '50%');
        target.style.setProperty('--my', isProgress ? '50%' : '20%');
        target.style.setProperty('--pop', '0');
        target.style.setProperty('--tx', '0px');
        target.style.setProperty('--ty', '0px');
        target.style.setProperty('--sx', '0px');
        target.style.setProperty('--sy', '0px');
        target.style.setProperty('--skx', '0deg');
        target.style.setProperty('--sky', '0deg');
        target.style.setProperty('--scale', '1');
        if (isProgress) {
            setProgressBulge(0, 0);
            clearProgressLighting();
            // No default highlight when not hovering.
        }
    };

    targets.forEach(resetTarget);

    let currentTarget = null;

    const updateTarget = (event) => {
        const el = document.elementFromPoint(event.clientX, event.clientY);
        const target = el ? el.closest('button, #progress-container') : null;

        if (currentTarget && currentTarget !== target) {
            resetTarget(currentTarget);
        }

        if (!target) {
            clearProgressLighting();
            currentTarget = null;
            return;
        }

        if (currentTarget && currentTarget.id === 'progress-container' && target.id !== 'progress-container') {
            clearProgressLighting();
        }

        const rect = target.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const y = event.clientY - rect.top;
        const nx = (x - rect.width / 2) / (rect.width / 2);
        const ny = (y - rect.height / 2) / (rect.height / 2);
        const isProgress = target.id === 'progress-container';
        const dist = Math.min(Math.sqrt(nx * nx + ny * ny), 1);
        const lightPop = Math.max(0, 1 - dist);
        const pop = isProgress ? lightPop * 0.55 : lightPop;
        const translateMax = isProgress ? 0 : 14;
        const shadowMax = isProgress ? 0 : 20;
        const skewMax = isProgress ? 0 : 3;
        const scaleMax = isProgress ? 1 : 1.03;
        const tx = nx * translateMax * pop;
        const ty = ny * translateMax * pop;
        const sx = -nx * shadowMax * pop;
        const sy = -ny * shadowMax * pop;
        const skx = (ny * skewMax * pop).toFixed(2);
        const sky = (-nx * skewMax * pop).toFixed(2);
        const scale = (1 + (scaleMax - 1) * pop).toFixed(3);

        target.style.setProperty('--mx', `${x}px`);
        target.style.setProperty('--my', `${y}px`);
        target.style.setProperty('--pop', pop.toFixed(3));
        target.style.setProperty('--tx', `${tx.toFixed(2)}px`);
        target.style.setProperty('--ty', `${ty.toFixed(2)}px`);
        target.style.setProperty('--sx', `${sx.toFixed(2)}px`);
        target.style.setProperty('--sy', `${sy.toFixed(2)}px`);
        target.style.setProperty('--skx', `${skx}deg`);
        target.style.setProperty('--sky', `${sky}deg`);
        target.style.setProperty('--scale', scale);

        if (isProgress) {
            const bar = document.getElementById('progress-bar');
            if (bar) {
                const containerRect = target.getBoundingClientRect();
                const withinX = event.clientX >= containerRect.left && event.clientX <= containerRect.right;
                const withinY = event.clientY >= containerRect.top && event.clientY <= containerRect.bottom;
                if (withinX && withinY) {
                    const cx = event.clientX - containerRect.left;
                    setProgressBulge(cx, PROGRESS_BULGE.hoverStrength);
                    setProgressLighting(cx, event.clientY - containerRect.top, lightPop * 0.8);
                } else {
                    setProgressBulge(0, 0);
                    clearProgressLighting();
                }
            }
        } else {
            clearProgressLighting();
        }
        target.classList.add('is-lit');
        currentTarget = target;
    };

    const clearTarget = () => {
        if (currentTarget) {
            resetTarget(currentTarget);
            currentTarget = null;
        }
    };

    document.addEventListener('pointermove', updateTarget);
    document.addEventListener('pointerdown', updateTarget);
    document.addEventListener('pointerleave', clearTarget);
}

document.addEventListener('DOMContentLoaded', async function() {
    const user = await loadCurrentUser();
    if (!user) {
        return;
    }
    setupAccountMenu(user);
    setupProgressBulge();
    setupPointerLighting();
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
    const wsProtocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(wsProtocol + '://' + window.location.host);

    ws.onopen = function() {
        console.log('WebSocket connection established');
    };

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
            return;
        }

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
    const numericProgress = Number(progress) || 0;

    // Show the progress bar when the backup starts
    if (numericProgress > 0) {
        progressContainer.style.display = 'block';
    }
    if (numericProgress > 0 )
    {
        progressPercentage.style.display = 'block';
    }
    progressBar.style.width = numericProgress + '%';
    progressPercentage.textContent = Math.round(numericProgress) + '%'; // Set the percentage text
    if (progressContainer) {
        progressContainer._progressTarget = numericProgress;
        if (progressContainer._progressCurrent == null) {
            progressContainer._progressCurrent = numericProgress;
            progressContainer._progressValue = numericProgress;
            refreshProgressVisual(progressContainer);
        }
        startProgressAnimation(progressContainer);
    }

    // Hide the progress bar when the backup is complete
    if (numericProgress == 100) {
        setTimeout(() => {
            progressContainer.style.display = 'none';
            progressPercentage.style.display = 'none';
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
        if (progressContainer) {
            if (progressContainer._progressAnimFrame) {
                cancelAnimationFrame(progressContainer._progressAnimFrame);
                progressContainer._progressAnimFrame = null;
            }
            progressContainer._progressAnimating = false;
            progressContainer._progressTarget = 0;
            progressContainer._progressCurrent = 0;
            progressContainer._progressValue = 0;
            refreshProgressVisual(progressContainer);
        }
    }
}
function handleFetchResponse(response) {
    if (response.status === 428) {
        alert('You must set a new password before continuing.');
        redirectToSetPassword();
        return null;
    } else if (response.status === 401 || response.status === 403) {
        alert('Session has expired, please log in again.');
        localStorage.removeItem('token'); // Clear the token as it's no longer valid
        window.location.href = '/'; // Redirect to login
        return null; // Stop further processing
    } else if (response.status === 429) {
        // Handle backup frequency error specifically
        alert('A backup has already been performed this hour.');
        return null; // Stop further processing and do not throw a session expired message
    }
    return response; // Continue processing for other status codes
}

  document.getElementById('start-server').addEventListener('click', function() {
    const token = localStorage.getItem('token');
    if (!token) {
        alert('You are not authenticated.');
        window.location.href = '/';
        return;
    }

    fetch('/start', {
        method: 'POST',
        headers: {
            'Authorization': 'Bearer ' + token
        }
    })
    .then(handleFetchResponse)
    .then(response => response ? response.text() : null)
    .then(text => {
        if (text) {
            alert(text);
            checkServerStatus();
        }
    })
    .catch(err => {
        console.error('Error starting server:', err);
        alert('Error starting server.');
    });
});
document.getElementById('stop-server').addEventListener('click', function() {
    const token = localStorage.getItem('token');
    if (!token) {
        alert('You are not authenticated.');
        window.location.href = '/';
        return;
    }

    fetch('/stop', {
        method: 'POST',
        headers: {
            'Authorization': 'Bearer ' + token
        }
    })
    .then(handleFetchResponse)
    .then(response => response ? response.text() : null)
    .then(text => {
        if (text) {
            alert(text);
            checkServerStatus();
        }
    })
    .catch(err => {
        console.error('Error stopping server:', err);
        alert('Error stopping server.');
    });
});
document.getElementById('backup-server').addEventListener('click', function() {
    const token = localStorage.getItem('token');
    if (!token) {
        alert('You are not authenticated.');
        window.location.href = '/';
        return;
    }
    
    setBackupState(true); // Indicate backup is starting
    
    fetch('/backup', {
        method: 'POST',
        headers: {
            'Authorization': 'Bearer ' + token
        }
    })
    .then(handleFetchResponse)
    .then(response => {
        if (response && response.ok) {
            return response.text();
        } else {
            return null; // This prevents the next .then from executing with a null response
        }
    })
    .then(text => {
        if (text) {
            alert(text);
        }
        setBackupState(false); // Indicate backup has finished or failed
        checkServerStatus(); // Check server status to update button states
    })
    .catch(err => {
        console.error('Error performing backup:', err);
        alert('Error performing backup.');
        setBackupState(false); // Ensure state is reset on error
        checkServerStatus(); // Ensure buttons are re-enabled even after an error
    });
});
document.getElementById('restart-server').addEventListener('click', function() {
    const token = localStorage.getItem('token');
    if (!token) {
        alert('You are not authenticated.');
        window.location.href = '/';
        return;
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
    .then(handleFetchResponse)
    .then(response => response ? response.text() : null)
    .then(text => {
        if (text) {
            alert(text);
            setTimeout(() => {
                checkServerStatus(); // Re-enable buttons based on server status
            }, 6000); // Additional 3 seconds added to the existing delay
        }
    })
    .catch(err => {
        console.error('Error restarting server:', err);
        alert('Error restarting server.');
        setTimeout(() => {
            checkServerStatus(); // Re-enable buttons based on server status
        }, 6000); // Additional 3 seconds added to the existing delay
    });
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
        } else {
            console.log('Server responded with an error during logout.');
        }
        localStorage.removeItem('token');
        window.location.href = '/';
        alert('You have been logged out.');
    })
    .catch(error => {
        console.error('Error during logout:', error);
        alert('Error logging out.');
    });
}
