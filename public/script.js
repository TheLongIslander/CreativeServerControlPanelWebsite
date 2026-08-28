/*
 * Purpose: Control panel UI logic for server actions, backups, and maintenance redirects.
 * Functions: setupWebSocket, checkServerStatus, updateBackupProgress, setBackupState,
 *            handleFetchResponse, and action button handlers.
 */
let isBackingUp = false;
let ws;
let wsReconnectTimer = null;
let wsStabilityTimer = null;
let wsReconnectAttempt = 0;
let wsStopped = false;
let wsPolicyCloseCount = 0;
let wsPreOpenFailureCount = 0;
let wsPreOpenCheckInFlight = false;
let wsLifecycleGeneration = 0;
const WS_MAX_PREOPEN_FAILURES = 3;
let latestUpdateStatus = null;
let activeUpdateCheck = null;
let isApplyingUpdate = false;
let updateButtonAnimationTimer = null;
let updateButtonAnimationBase = null;
let currentUser = null;
let updateButtonSeverity = 'none';
let backgroundPreflightInFlight = false;
let backgroundPreflightLastTarget = null;
let backgroundPreflightLastAt = 0;
const BACKGROUND_PREFLIGHT_TTL_MS = 10 * 60 * 1000;
const UPDATE_STATUS_POLL_INTERVAL_MS = 5 * 60 * 1000;
let updateStatusPollTimer = null;
let updateStatusPollInFlight = false;
let advancedUpdateDirection = 'update';
const advancedVersionCache = {
    all: null
};
const serverInfoState = {
    payload: null,
    groupIndex: 0,
    imageIndex: 0,
    zoomScale: 1,
    zoomX: 0,
    zoomY: 0,
    zoomDragging: false,
    zoomPointerX: 0,
    zoomPointerY: 0
};

function clearAdvancedVersionCache() {
    advancedVersionCache.all = null;
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

function getAuthToken() {
    return localStorage.getItem('token');
}

function getAuthHeaders(includeJson = false) {
    const token = getAuthToken();
    const headers = {};
    if (includeJson) {
        headers['Content-Type'] = 'application/json';
    }
    if (token) {
        headers.Authorization = 'Bearer ' + token;
    }
    return headers;
}

function getActiveColorScheme() {
    const explicit = document.body ? document.body.getAttribute('data-color-scheme') : null;
    if (explicit === 'dark' || explicit === 'light') {
        return explicit;
    }
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
        return 'dark';
    }
    return 'light';
}

function setUpdateStatusMessage(message, isError = false) {
    const el = document.getElementById('update-status-message');
    if (!el) {
        return;
    }
    if (!message) {
        el.textContent = '';
        el.classList.add('hidden');
        return;
    }
    el.textContent = message;
    el.classList.remove('hidden');
    if (isError) {
        el.style.color = '#b91c1c';
        return;
    }
    el.style.color = getActiveColorScheme() === 'light' ? '#111111' : '';
}

function formatIsoDateLabel(isoDate) {
    const match = String(isoDate || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) {
        return null;
    }
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
        return null;
    }
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    if (month < 1 || month > 12) {
        return null;
    }
    return `${monthNames[month - 1]} ${day}, ${year}`;
}

function formatReleaseDateLabel(releaseTime, releaseDate) {
    const dateLabel = formatIsoDateLabel(releaseDate);
    if (dateLabel) {
        return dateLabel;
    }
    if (!releaseTime) {
        return null;
    }
    const parsed = new Date(releaseTime);
    if (!Number.isFinite(parsed.getTime())) {
        return null;
    }
    return formatIsoDateLabel(parsed.toISOString().slice(0, 10));
}

function formatVersionWithRelease(versionInfo, fallbackVersion) {
    const version = (versionInfo && versionInfo.version) || fallbackVersion || 'unknown';
    const releaseLabel = formatReleaseDateLabel(
        versionInfo && versionInfo.releaseTime,
        versionInfo && versionInfo.releaseDate
    );
    if (!releaseLabel) {
        return `${version} (release date unknown)`;
    }
    return `${version} (released ${releaseLabel})`;
}

function formatLoaderVersionLabel(loader, loaderVersion) {
    const loaderName = loader === 'fabric' ? 'Fabric Loader' : 'Mod Loader';
    return loaderVersion ? `${loaderName} ${loaderVersion}` : `${loaderName} unknown`;
}

function getCheckOperation(check) {
    return check && check.operation === 'downgrade' ? 'downgrade' : 'update';
}

function getOperationVerb(operation, lower = false) {
    const text = operation === 'downgrade' ? 'Downgrade' : 'Update';
    return lower ? text.toLowerCase() : text;
}

function formatCompatibleTargetButtonLabel(target, operation) {
    const version = target && target.targetVersion ? target.targetVersion : 'target';
    const releaseLabel = formatReleaseDateLabel(
        target && target.targetReleaseTime,
        target && target.targetReleaseDate
    );
    const prefix = operation === 'downgrade' ? 'Downgrade Compatible Version' : 'Update Compatible Version';
    return releaseLabel
        ? `${prefix} (${version} - ${releaseLabel})`
        : `${prefix} (${version})`;
}

function setUpdateButtonSeverity(severity) {
    const allowed = new Set(['none', 'warning', 'java']);
    updateButtonSeverity = allowed.has(severity) ? severity : 'none';
}

function applySeverityFromCheck(check) {
    const hasConflicts = getConflictMods(check).length > 0;
    const blockingReasons = Array.isArray(check && check.blockingReasons) ? check.blockingReasons : [];
    const hasJavaBlock = blockingReasons.includes('blocked_by_java') || blockingReasons.includes('blocked_by_java_detection');
    if (hasJavaBlock) {
        setUpdateButtonSeverity('java');
        return;
    }
    if (hasConflicts) {
        setUpdateButtonSeverity('warning');
        return;
    }
    setUpdateButtonSeverity('none');
}

function setUpdateButtonLabel(label, { includeSeverityIcon = true } = {}) {
    const button = document.getElementById('update-server');
    if (!button) {
        return;
    }

    button.innerHTML = '';
    if (includeSeverityIcon && updateButtonSeverity !== 'none') {
        const icon = document.createElement('span');
        icon.className = `update-button-alert update-button-alert-${updateButtonSeverity}`;
        icon.setAttribute('aria-hidden', 'true');
        button.appendChild(icon);
    }

    const text = document.createElement('span');
    text.className = 'update-button-label';
    text.textContent = label;
    button.appendChild(text);
}

function startUpdateButtonAnimation(baseText = 'Updating') {
    const button = document.getElementById('update-server');
    if (!button) {
        return;
    }
    if (updateButtonAnimationTimer && updateButtonAnimationBase === baseText) {
        button.disabled = true;
        return;
    }

    if (updateButtonAnimationTimer) {
        clearInterval(updateButtonAnimationTimer);
        updateButtonAnimationTimer = null;
    }

    updateButtonAnimationBase = baseText;
    let dots = 0;
    const render = () => {
        const suffix = '.'.repeat(dots);
        setUpdateButtonLabel(`${baseText}${suffix}`);
        dots = (dots + 1) % 4;
    };
    render();
    updateButtonAnimationTimer = setInterval(render, 360);
    button.disabled = true;
}

function stopUpdateButtonAnimation({ restoreLabel = true } = {}) {
    if (updateButtonAnimationTimer) {
        clearInterval(updateButtonAnimationTimer);
        updateButtonAnimationTimer = null;
    }
    updateButtonAnimationBase = null;
    if (restoreLabel) {
        updateUpdateButtonLabel();
    }
}

function updateUpdateButtonLabel() {
    const button = document.getElementById('update-server');
    if (!button) {
        return;
    }
    if (updateButtonAnimationTimer) {
        return;
    }
    if (!latestUpdateStatus || !latestUpdateStatus.updateAvailable) {
        button.classList.add('hidden');
        setUpdateButtonSeverity('none');
        setUpdateButtonLabel('Update Available');
        return;
    }
    button.classList.remove('hidden');
    setUpdateButtonLabel(`Update to ${latestUpdateStatus.latestVersion}`);
}

async function runBackgroundUpdateRiskCheck({ force = false } = {}) {
    if (isApplyingUpdate || backgroundPreflightInFlight) {
        return;
    }
    if (!latestUpdateStatus || !latestUpdateStatus.updateAvailable || latestUpdateStatus.updateInProgress) {
        return;
    }

    const targetVersion = latestUpdateStatus.latestVersion || null;
    if (!targetVersion) {
        return;
    }

    const now = Date.now();
    if (
        !force
        && backgroundPreflightLastTarget === targetVersion
        && (now - backgroundPreflightLastAt) < BACKGROUND_PREFLIGHT_TTL_MS
    ) {
        return;
    }

    backgroundPreflightInFlight = true;
    try {
        const response = await fetch('/updates/check', {
            method: 'POST',
            headers: getAuthHeaders(true),
            body: JSON.stringify({ targetVersion })
        });
        if (!response.ok) {
            return;
        }

        const check = await response.json();
        if (!check || !check.updateAvailable) {
            setUpdateButtonSeverity('none');
            updateUpdateButtonLabel();
            return;
        }

        applySeverityFromCheck(check);
        updateUpdateButtonLabel();
    } catch (err) {
        console.warn('Background update preflight failed:', err.message);
    } finally {
        backgroundPreflightInFlight = false;
        backgroundPreflightLastTarget = targetVersion;
        backgroundPreflightLastAt = now;
    }
}

async function loadUpdateStatus({ forceRefresh = false } = {}) {
    const button = document.getElementById('update-server');
    if (!button) {
        return null;
    }

    const token = getAuthToken();
    if (!token) {
        button.classList.add('hidden');
        return null;
    }

    let endpoint = '/updates/status';
    if (forceRefresh) {
        endpoint += '?refresh=1';
    }

    try {
        const response = await fetch(endpoint, {
            headers: getAuthHeaders(false)
        });
        if (!response.ok) {
            if (response.status === 401 || response.status === 403) {
                return null;
            }
            throw new Error(`Failed to load update status (${response.status})`);
        }
        const previousUpdateStatus = latestUpdateStatus;
        latestUpdateStatus = await response.json();
        if (forceRefresh
            || (previousUpdateStatus && previousUpdateStatus.currentVersion !== latestUpdateStatus.currentVersion)
            || (previousUpdateStatus && previousUpdateStatus.latestVersion !== latestUpdateStatus.latestVersion)) {
            clearAdvancedVersionCache();
        }
        if (latestUpdateStatus.updateAvailable) {
            button.classList.remove('hidden');
            if (latestUpdateStatus.updateInProgress) {
                startUpdateButtonAnimation('Updating');
                setUpdateStatusMessage('Update in progress. Server actions are temporarily locked.');
            } else {
                stopUpdateButtonAnimation({ restoreLabel: false });
                updateUpdateButtonLabel();
                button.disabled = Boolean(isBackingUp) || isApplyingUpdate;
                setUpdateStatusMessage('');
                runBackgroundUpdateRiskCheck().catch(() => {});
            }
        } else {
            button.classList.add('hidden');
            setUpdateButtonSeverity('none');
            stopUpdateButtonAnimation({ restoreLabel: false });
            setUpdateStatusMessage('');
        }
        return latestUpdateStatus;
    } catch (err) {
        console.error('Failed to fetch update status:', err);
        button.classList.add('hidden');
        setUpdateButtonSeverity('none');
        stopUpdateButtonAnimation({ restoreLabel: false });
        setUpdateStatusMessage('Failed to load update status.', true);
        return null;
    }
}

async function pollUpdateStatusNow({ forceRefresh = false } = {}) {
    if (updateStatusPollInFlight || isApplyingUpdate) {
        return;
    }
    updateStatusPollInFlight = true;
    try {
        await loadUpdateStatus({ forceRefresh });
        checkServerStatus();
    } catch (_) {
        // loadUpdateStatus/checkServerStatus already handle their own logging.
    } finally {
        updateStatusPollInFlight = false;
    }
}

function setupUpdateStatusPolling() {
    if (updateStatusPollTimer) {
        clearInterval(updateStatusPollTimer);
    }

    updateStatusPollTimer = setInterval(() => {
        if (document.hidden) {
            return;
        }
        pollUpdateStatusNow().catch(() => {});
    }, UPDATE_STATUS_POLL_INTERVAL_MS);

    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            return;
        }
        pollUpdateStatusNow().catch(() => {});
    });
}

function getConflictMods(check) {
    if (!check || !check.mods || !Array.isArray(check.mods.mods)) {
        return [];
    }
    return check.mods.mods.filter(mod => mod.status === 'blocked' || mod.status === 'unknown');
}

function setUpdateActionDisabled(disabled) {
    const cancelBtn = document.getElementById('update-cancel-btn');
    const compatibleBtn = document.getElementById('update-compatible-btn');
    const serverOnlyBtn = document.getElementById('update-server-only-btn');
    const compatibleVersionBtn = document.getElementById('update-compatible-version-btn');
    if (cancelBtn) {
        cancelBtn.disabled = disabled;
    }
    if (compatibleBtn) {
        compatibleBtn.disabled = disabled;
    }
    if (serverOnlyBtn) {
        serverOnlyBtn.disabled = disabled;
    }
    if (compatibleVersionBtn) {
        compatibleVersionBtn.disabled = disabled;
    }
    document.querySelectorAll('.compatible-version-option-btn').forEach(node => {
        node.disabled = disabled;
    });
}

function setMainServerControlsDisabled(disabled) {
    const startButton = document.getElementById('start-server');
    const stopButton = document.getElementById('stop-server');
    const backupButton = document.getElementById('backup-server');
    const restartButton = document.getElementById('restart-server');
    const updateButton = document.getElementById('update-server');
    const versionButton = document.getElementById('server-version-button');

    if (startButton) {
        startButton.disabled = disabled;
    }
    if (stopButton) {
        stopButton.disabled = disabled;
    }
    if (backupButton) {
        backupButton.disabled = disabled;
    }
    if (restartButton) {
        restartButton.disabled = disabled;
    }
    if (updateButton && !updateButton.classList.contains('hidden')) {
        updateButton.disabled = disabled || Boolean(updateButtonAnimationTimer) || isApplyingUpdate;
    }
    if (versionButton) {
        versionButton.disabled = disabled || isApplyingUpdate;
    }
}

function isModalVisible(modalId) {
    const modal = document.getElementById(modalId);
    return Boolean(modal && !modal.classList.contains('hidden'));
}

function syncModalOpenState() {
    const hasVisibleModal = isModalVisible('update-modal')
        || isModalVisible('update-summary-modal')
        || isModalVisible('update-advanced-modal')
        || isModalVisible('server-info-modal');
    document.body.classList.toggle('modal-open', hasVisibleModal);
}

function closeUpdateModal() {
    const modal = document.getElementById('update-modal');
    if (!modal) {
        return;
    }
    modal.classList.add('hidden');
    modal.setAttribute('aria-hidden', 'true');
    syncModalOpenState();
}

function closeUpdateSummaryModal() {
    const modal = document.getElementById('update-summary-modal');
    if (!modal) {
        return;
    }
    modal.classList.add('hidden');
    modal.setAttribute('aria-hidden', 'true');
    syncModalOpenState();
}

function closeUpdateAdvancedModal() {
    const modal = document.getElementById('update-advanced-modal');
    if (!modal) {
        return;
    }
    modal.classList.add('hidden');
    modal.setAttribute('aria-hidden', 'true');
    syncModalOpenState();
}

function closeServerInfoModal() {
    const modal = document.getElementById('server-info-modal');
    if (!modal) {
        return;
    }
    closeServerInfoImageViewer();
    modal.classList.add('hidden');
    modal.setAttribute('aria-hidden', 'true');
    syncModalOpenState();
}

function closeServerManagementDropdown() {
    const button = document.getElementById('server-management-button');
    const dropdown = document.getElementById('server-management-dropdown');
    if (!dropdown) {
        return;
    }
    dropdown.classList.add('hidden');
    dropdown.setAttribute('aria-hidden', 'true');
    if (button) {
        button.setAttribute('aria-expanded', 'false');
    }
}

function closeAccountDropdown() {
    const dropdown = document.getElementById('account-dropdown');
    const appearancePanel = document.getElementById('appearance-panel');
    if (dropdown) {
        dropdown.classList.add('hidden');
    }
    if (appearancePanel) {
        appearancePanel.classList.add('hidden');
    }
}

function setServerInfoStatus(message, isError = false) {
    const status = document.getElementById('server-info-status');
    if (!status) {
        return;
    }
    if (!message) {
        status.textContent = '';
        status.classList.add('hidden');
        status.classList.remove('is-error');
        return;
    }
    status.textContent = message;
    status.classList.remove('hidden');
    status.classList.toggle('is-error', Boolean(isError));
}

function createServerInfoNode(tagName, className, text) {
    const node = document.createElement(tagName);
    if (className) {
        node.className = className;
    }
    if (text != null) {
        node.textContent = text;
    }
    return node;
}

function scrollServerInfoModsIntoView() {
    const section = document.getElementById('server-info-mods-section');
    if (!section) {
        return;
    }
    section.scrollIntoView({ behavior: 'smooth', block: 'start' });
    const filter = document.getElementById('server-info-mod-filter');
    if (filter) {
        window.setTimeout(() => filter.focus({ preventScroll: true }), 350);
    }
}

function getServerInfoGalleryGroups() {
    const payload = serverInfoState.payload || {};
    return Array.isArray(payload.gallery)
        ? payload.gallery.filter(group => group && Array.isArray(group.images) && group.images.length > 0)
        : [];
}

function clampServerInfoGallerySelection() {
    const groups = getServerInfoGalleryGroups();
    if (!groups.length) {
        serverInfoState.groupIndex = 0;
        serverInfoState.imageIndex = 0;
        return null;
    }
    serverInfoState.groupIndex = Math.min(Math.max(serverInfoState.groupIndex, 0), groups.length - 1);
    const group = groups[serverInfoState.groupIndex];
    serverInfoState.imageIndex = Math.min(Math.max(serverInfoState.imageIndex, 0), group.images.length - 1);
    return group;
}

function getActiveServerInfoImage() {
    const group = clampServerInfoGallerySelection();
    if (!group) {
        return null;
    }
    return {
        group,
        image: group.images[serverInfoState.imageIndex]
    };
}

function clampServerInfoZoom(value) {
    return Math.min(6, Math.max(1, Number(value) || 1));
}

function applyServerInfoZoomTransform() {
    const img = document.getElementById('server-info-image-viewer-img');
    if (!img) {
        return;
    }
    img.style.transform = `translate(${serverInfoState.zoomX}px, ${serverInfoState.zoomY}px) scale(${serverInfoState.zoomScale})`;
}

function resetServerInfoZoom() {
    serverInfoState.zoomScale = 1;
    serverInfoState.zoomX = 0;
    serverInfoState.zoomY = 0;
    applyServerInfoZoomTransform();
}

function setServerInfoZoom(scale, anchorX, anchorY) {
    const nextScale = clampServerInfoZoom(scale);
    const previousScale = serverInfoState.zoomScale || 1;
    if (anchorX != null && anchorY != null && previousScale > 0) {
        const factor = nextScale / previousScale;
        serverInfoState.zoomX = anchorX - ((anchorX - serverInfoState.zoomX) * factor);
        serverInfoState.zoomY = anchorY - ((anchorY - serverInfoState.zoomY) * factor);
    }
    serverInfoState.zoomScale = nextScale;
    if (serverInfoState.zoomScale === 1) {
        serverInfoState.zoomX = 0;
        serverInfoState.zoomY = 0;
    }
    applyServerInfoZoomTransform();
}

function closeServerInfoImageViewer() {
    const viewer = document.getElementById('server-info-image-viewer');
    if (!viewer) {
        return;
    }
    viewer.classList.add('hidden');
    viewer.setAttribute('aria-hidden', 'true');
    serverInfoState.zoomDragging = false;
    resetServerInfoZoom();
}

function openServerInfoImageViewer() {
    const active = getActiveServerInfoImage();
    const viewer = document.getElementById('server-info-image-viewer');
    const img = document.getElementById('server-info-image-viewer-img');
    const title = document.getElementById('server-info-image-viewer-title');
    if (!active || !viewer || !img) {
        return;
    }

    const { group, image } = active;
    resetServerInfoZoom();
    img.src = image.src || image.fullSrc || '';
    img.alt = `${group.title || 'Server'} screenshot${image.label ? ` from ${image.label}` : ''}`;
    if (title) {
        title.textContent = `${group.title || 'Screenshot'}${image.label ? ` | ${image.label}` : ''}`;
    }
    viewer.classList.remove('hidden');
    viewer.setAttribute('aria-hidden', 'false');
}

function renderServerInfoOverview(payload) {
    const overview = document.getElementById('server-info-overview');
    if (!overview) {
        return;
    }
    overview.innerHTML = '';
    const mods = Array.isArray(payload && payload.mods) ? payload.mods : [];
    const facts = [
        { label: 'Current Version', value: payload && payload.currentVersion ? payload.currentVersion : 'Unknown' },
        { label: 'Current Mods', value: String(mods.length) },
        { label: 'Founded', value: payload && payload.startedLabel ? payload.startedLabel : 'April 23, 2020' },
        { label: 'Start Version', value: payload && payload.startVersion ? payload.startVersion : '1.15.2' }
    ];

    facts.forEach(fact => {
        const card = createServerInfoNode('article', 'server-info-fact');
        const value = createServerInfoNode('div', 'server-info-fact-value', fact.value);
        const label = createServerInfoNode('div', 'server-info-fact-label', fact.label);
        card.appendChild(value);
        card.appendChild(label);
        if (fact.label === 'Current Mods') {
            card.classList.add('server-info-fact-action');
            card.setAttribute('role', 'button');
            card.tabIndex = 0;
            card.title = 'Jump to installed mods';
            card.addEventListener('click', scrollServerInfoModsIntoView);
            card.addEventListener('keydown', event => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    scrollServerInfoModsIntoView();
                }
            });
        }
        overview.appendChild(card);
    });
}

function renderServerInfoTabs() {
    const tabs = document.getElementById('server-info-era-tabs');
    if (!tabs) {
        return;
    }
    tabs.innerHTML = '';
    const groups = getServerInfoGalleryGroups();
    groups.forEach((group, index) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'server-info-era-tab';
        button.setAttribute('role', 'tab');
        button.setAttribute('aria-selected', index === serverInfoState.groupIndex ? 'true' : 'false');
        button.classList.toggle('active', index === serverInfoState.groupIndex);

        const title = createServerInfoNode('span', 'server-info-era-title', group.title || 'Era');
        const meta = createServerInfoNode('span', 'server-info-era-meta', `${group.eyebrow || ''}${group.eyebrow ? ' | ' : ''}${group.images.length} image${group.images.length === 1 ? '' : 's'}`);
        button.appendChild(title);
        button.appendChild(meta);
        button.addEventListener('click', () => {
            serverInfoState.groupIndex = index;
            serverInfoState.imageIndex = 0;
            renderServerInfoGallery();
        });
        tabs.appendChild(button);
    });
}

function moveServerInfoImage(delta) {
    const group = clampServerInfoGallerySelection();
    if (!group || group.images.length < 2) {
        return;
    }
    const next = (serverInfoState.imageIndex + delta + group.images.length) % group.images.length;
    serverInfoState.imageIndex = next;
    renderServerInfoGallery();
}

function updateServerInfoThumbnailOverflow(rail) {
    if (!rail) {
        return;
    }
    const thumbs = rail.querySelector('.server-info-thumbnails');
    const topFlow = rail.querySelector('.server-info-thumb-flow-top');
    const bottomFlow = rail.querySelector('.server-info-thumb-flow-bottom');
    const topTrack = topFlow ? topFlow.querySelector('.server-info-thumb-flow-track') : null;
    const bottomTrack = bottomFlow ? bottomFlow.querySelector('.server-info-thumb-flow-track') : null;
    if (!thumbs || !topFlow || !bottomFlow || !topTrack || !bottomTrack) {
        return;
    }

    const top = thumbs.scrollTop;
    const overflowRemaining = thumbs.scrollHeight - thumbs.scrollTop - thumbs.clientHeight;
    const hasMoreAbove = top > 4;
    const hasMoreBelow = overflowRemaining > 4;
    const railStyles = getComputedStyle(rail);
    const topEdgeHeight = parseFloat(railStyles.getPropertyValue('--server-info-thumb-flow-top-height')) || 54;
    const bottomEdgeHeight = parseFloat(railStyles.getPropertyValue('--server-info-thumb-flow-bottom-height')) || 86;
    const featherHeight = parseFloat(railStyles.getPropertyValue('--server-info-thumb-flow-feather')) || 56;
    rail.classList.toggle('has-more-above', hasMoreAbove);
    rail.classList.toggle('has-more-below', hasMoreBelow);
    topTrack.style.transform = `translateY(${topEdgeHeight - top}px)`;
    bottomTrack.style.transform = `translateY(${featherHeight - top - thumbs.clientHeight}px)`;
}

function syncServerInfoThumbnailRails() {
    document.querySelectorAll('.server-info-thumbnail-rail').forEach(rail => {
        const layout = rail.closest('.server-info-gallery-layout');
        const stage = layout ? layout.querySelector('.server-info-stage') : null;
        const thumbs = rail.querySelector('.server-info-thumbnails');
        const isMobile = window.matchMedia && window.matchMedia('(max-width: 768px)').matches;
        if (!stage || !thumbs || isMobile) {
            rail.style.height = '';
            thumbs.style.height = '';
            rail.classList.remove('has-more-above', 'has-more-below');
            return;
        }
        const stageHeight = Math.round(stage.getBoundingClientRect().height);
        if (stageHeight > 0) {
            rail.style.height = `${stageHeight}px`;
            thumbs.style.height = `${stageHeight}px`;
        }
        updateServerInfoThumbnailOverflow(rail);
    });
}

function renderServerInfoGallery() {
    const content = document.getElementById('server-info-gallery-content');
    const fullLink = document.getElementById('server-info-full-link');
    if (!content) {
        return;
    }
    const group = clampServerInfoGallerySelection();
    renderServerInfoTabs();
    content.innerHTML = '';

    if (!group) {
        if (fullLink) {
            fullLink.classList.add('hidden');
            fullLink.removeAttribute('href');
        }
        content.appendChild(createServerInfoNode('p', 'server-info-empty', 'No screenshots were found.'));
        return;
    }

    const image = group.images[serverInfoState.imageIndex];
    if (fullLink) {
        fullLink.classList.remove('hidden');
        fullLink.href = image.fullSrc || image.src || '#';
    }

    const layout = createServerInfoNode('div', 'server-info-gallery-layout');
    const stage = createServerInfoNode('div', 'server-info-stage');

    const previous = createServerInfoNode('button', 'server-info-gallery-nav server-info-gallery-nav-prev', 'Prev');
    previous.type = 'button';
    previous.setAttribute('aria-label', 'Previous screenshot');
    previous.disabled = group.images.length < 2;
    previous.addEventListener('click', () => moveServerInfoImage(-1));

    const next = createServerInfoNode('button', 'server-info-gallery-nav server-info-gallery-nav-next', 'Next');
    next.type = 'button';
    next.setAttribute('aria-label', 'Next screenshot');
    next.disabled = group.images.length < 2;
    next.addEventListener('click', () => moveServerInfoImage(1));

    const img = document.createElement('img');
    img.className = 'server-info-stage-image';
    img.src = image.src || image.fullSrc || '';
    img.alt = `${group.title || 'Server'} screenshot${image.label ? ` from ${image.label}` : ''}`;
    img.decoding = 'async';
    img.loading = 'eager';
    img.addEventListener('click', openServerInfoImageViewer);

    const caption = createServerInfoNode('div', 'server-info-stage-caption');
    const captionTitle = createServerInfoNode('div', 'server-info-stage-title', group.title || 'Screenshot');
    const captionText = createServerInfoNode('div', 'server-info-stage-text', `${image.label || image.fileName || 'Screenshot'}${group.description ? ` | ${group.description}` : ''}`);
    caption.appendChild(captionTitle);
    caption.appendChild(captionText);

    stage.appendChild(img);
    stage.appendChild(previous);
    stage.appendChild(next);
    stage.appendChild(caption);

    const thumbRail = createServerInfoNode('div', 'server-info-thumbnail-rail');
    const thumbs = createServerInfoNode('div', 'server-info-thumbnails');
    group.images.forEach((item, index) => {
        const thumb = document.createElement('button');
        thumb.type = 'button';
        thumb.className = 'server-info-thumb';
        thumb.classList.toggle('active', index === serverInfoState.imageIndex);
        thumb.setAttribute('aria-label', item.label || item.fileName || 'Screenshot');
        const thumbImg = document.createElement('img');
        thumbImg.src = item.thumbSrc || item.src || item.fullSrc || '';
        thumbImg.alt = '';
        thumbImg.loading = 'lazy';
        thumbImg.decoding = 'async';
        thumb.appendChild(thumbImg);
        thumb.addEventListener('click', () => {
            serverInfoState.imageIndex = index;
            renderServerInfoGallery();
        });
        thumbs.appendChild(thumb);
    });
    thumbs.addEventListener('scroll', () => updateServerInfoThumbnailOverflow(thumbRail));

    const createFlowPreview = className => {
        const preview = createServerInfoNode('div', `server-info-thumb-flow ${className}`);
        const track = createServerInfoNode('div', 'server-info-thumb-flow-track');
        Array.from(thumbs.children).forEach(thumb => {
            const clone = thumb.cloneNode(true);
            clone.classList.remove('active');
            clone.setAttribute('aria-hidden', 'true');
            clone.tabIndex = -1;
            track.appendChild(clone);
        });
        preview.setAttribute('aria-hidden', 'true');
        preview.appendChild(track);
        return preview;
    };

    thumbRail.appendChild(createFlowPreview('server-info-thumb-flow-top'));
    thumbRail.appendChild(thumbs);
    thumbRail.appendChild(createFlowPreview('server-info-thumb-flow-bottom'));

    layout.appendChild(stage);
    layout.appendChild(thumbRail);
    content.appendChild(layout);
    img.addEventListener('load', syncServerInfoThumbnailRails, { once: true });
    window.requestAnimationFrame(() => {
        const activeThumb = thumbs.querySelector('.server-info-thumb.active');
        if (activeThumb) {
            activeThumb.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        }
        syncServerInfoThumbnailRails();
    });
}

function renderServerInfoLore(payload) {
    const content = document.getElementById('server-info-lore-content');
    if (!content) {
        return;
    }
    content.innerHTML = '';
    const sections = Array.isArray(payload && payload.loreSections) ? payload.loreSections : [];
    if (!sections.length) {
        content.appendChild(createServerInfoNode('p', 'server-info-empty', 'No server history has been added yet.'));
        return;
    }

    sections.forEach(section => {
        const item = createServerInfoNode('article', 'server-info-lore-item');
        const marker = createServerInfoNode('div', 'server-info-lore-marker');
        const body = createServerInfoNode('div', 'server-info-lore-body');
        const eyebrow = createServerInfoNode('div', 'server-info-lore-eyebrow', section.eyebrow || '');
        const title = createServerInfoNode('h4', null, section.title || 'History');
        const paragraph = createServerInfoNode('p', null, section.body || '');
        body.appendChild(eyebrow);
        body.appendChild(title);
        body.appendChild(paragraph);
        item.appendChild(marker);
        item.appendChild(body);
        content.appendChild(item);
    });
}

function getFilteredServerInfoMods(payload) {
    const input = document.getElementById('server-info-mod-filter');
    const query = input ? input.value.trim().toLowerCase() : '';
    const mods = Array.isArray(payload && payload.mods) ? payload.mods : [];
    if (!query) {
        return mods;
    }
    return mods.filter(mod => {
        const haystack = [
            mod.name,
            mod.id,
            mod.version,
            mod.fileName,
            mod.description,
            ...(Array.isArray(mod.authors) ? mod.authors : [])
        ].filter(Boolean).join(' ').toLowerCase();
        return haystack.includes(query);
    });
}

function renderServerInfoMods(payload) {
    const list = document.getElementById('server-info-mod-list');
    if (!list) {
        return;
    }
    list.innerHTML = '';

    if (payload && payload.modsError) {
        list.appendChild(createServerInfoNode('p', 'server-info-empty is-error', payload.modsError));
        return;
    }

    const mods = getFilteredServerInfoMods(payload);
    if (!mods.length) {
        list.appendChild(createServerInfoNode('p', 'server-info-empty', 'No matching mods.'));
        return;
    }

    mods.forEach(mod => {
        const card = createServerInfoNode('article', 'server-info-mod-card');
        const name = createServerInfoNode('div', 'server-info-mod-name', mod.name || mod.id || mod.fileName || 'Unknown mod');
        const meta = createServerInfoNode('div', 'server-info-mod-meta');
        const pieces = [];
        if (mod.version) {
            pieces.push(mod.version);
        }
        if (mod.id && mod.id !== mod.name) {
            pieces.push(mod.id);
        }
        pieces.push(mod.fileName || 'unknown file');
        meta.textContent = pieces.join(' | ');
        card.appendChild(name);
        card.appendChild(meta);
        list.appendChild(card);
    });
}

function renderServerInfo(payload) {
    const body = document.getElementById('server-info-body');
    if (!body) {
        return;
    }
    renderServerInfoOverview(payload);
    renderServerInfoGallery();
    renderServerInfoLore(payload);
    renderServerInfoMods(payload);
    body.classList.remove('hidden');
    setServerInfoStatus('');
}

async function openServerInfoModal() {
    closeUpdateAdvancedMenu();
    closeServerManagementDropdown();
    const modal = document.getElementById('server-info-modal');
    const body = document.getElementById('server-info-body');
    const filter = document.getElementById('server-info-mod-filter');
    if (!modal) {
        return;
    }
    if (filter) {
        filter.value = '';
    }
    if (body) {
        body.classList.add('hidden');
    }
    setServerInfoStatus('Loading server info...');
    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');
    syncModalOpenState();

    try {
        const response = await fetch('/server-info', {
            headers: getAuthHeaders(false)
        });
        if (response.status === 428) {
            redirectToSetPassword();
            return;
        }
        if (response.status === 401 || response.status === 403) {
            redirectToLogin();
            return;
        }
        if (!response.ok) {
            const payload = await response.json().catch(() => ({}));
            throw new Error(payload.message || `Failed to load server info (${response.status})`);
        }
        serverInfoState.payload = await response.json();
        serverInfoState.groupIndex = 0;
        serverInfoState.imageIndex = 0;
        renderServerInfo(serverInfoState.payload);
    } catch (err) {
        console.error('Server info load failed:', err);
        setServerInfoStatus(err.message || 'Failed to load server info.', true);
    }
}

function setupServerInfoModalHandlers() {
    const closeBtn = document.getElementById('server-info-close-btn');
    if (closeBtn) {
        closeBtn.addEventListener('click', closeServerInfoModal);
    }

    document.querySelectorAll('[data-close-server-info="true"]').forEach(node => {
        node.addEventListener('click', closeServerInfoModal);
    });

    const filter = document.getElementById('server-info-mod-filter');
    if (filter) {
        filter.addEventListener('input', () => {
            renderServerInfoMods(serverInfoState.payload || {});
        });
    }

    window.addEventListener('resize', syncServerInfoThumbnailRails);

    const imageCloseBtn = document.getElementById('server-info-image-close-btn');
    if (imageCloseBtn) {
        imageCloseBtn.addEventListener('click', closeServerInfoImageViewer);
    }

    document.querySelectorAll('[data-close-server-info-image="true"]').forEach(node => {
        node.addEventListener('click', closeServerInfoImageViewer);
    });

    const zoomInBtn = document.getElementById('server-info-zoom-in-btn');
    if (zoomInBtn) {
        zoomInBtn.addEventListener('click', () => setServerInfoZoom(serverInfoState.zoomScale + 0.35));
    }

    const zoomOutBtn = document.getElementById('server-info-zoom-out-btn');
    if (zoomOutBtn) {
        zoomOutBtn.addEventListener('click', () => setServerInfoZoom(serverInfoState.zoomScale - 0.35));
    }

    const zoomResetBtn = document.getElementById('server-info-zoom-reset-btn');
    if (zoomResetBtn) {
        zoomResetBtn.addEventListener('click', resetServerInfoZoom);
    }

    const panArea = document.getElementById('server-info-image-pan-area');
    if (panArea) {
        panArea.addEventListener('wheel', event => {
            event.preventDefault();
            const rect = panArea.getBoundingClientRect();
            const anchorX = event.clientX - rect.left - (rect.width / 2);
            const anchorY = event.clientY - rect.top - (rect.height / 2);
            const delta = event.deltaY < 0 ? 0.25 : -0.25;
            setServerInfoZoom(serverInfoState.zoomScale + delta, anchorX, anchorY);
        }, { passive: false });

        panArea.addEventListener('pointerdown', event => {
            if (serverInfoState.zoomScale <= 1) {
                return;
            }
            serverInfoState.zoomDragging = true;
            serverInfoState.zoomPointerX = event.clientX;
            serverInfoState.zoomPointerY = event.clientY;
            panArea.classList.add('is-dragging');
            panArea.setPointerCapture(event.pointerId);
        });

        panArea.addEventListener('pointermove', event => {
            if (!serverInfoState.zoomDragging) {
                return;
            }
            serverInfoState.zoomX += event.clientX - serverInfoState.zoomPointerX;
            serverInfoState.zoomY += event.clientY - serverInfoState.zoomPointerY;
            serverInfoState.zoomPointerX = event.clientX;
            serverInfoState.zoomPointerY = event.clientY;
            applyServerInfoZoomTransform();
        });

        const stopDrag = event => {
            if (!serverInfoState.zoomDragging) {
                return;
            }
            serverInfoState.zoomDragging = false;
            panArea.classList.remove('is-dragging');
            try {
                panArea.releasePointerCapture(event.pointerId);
            } catch (_) {
                // Pointer may already have been released by the browser.
            }
        };

        panArea.addEventListener('pointerup', stopDrag);
        panArea.addEventListener('pointercancel', stopDrag);
        panArea.addEventListener('pointerleave', stopDrag);
    }

    document.addEventListener('keydown', event => {
        if (!document.getElementById('server-info-image-viewer')?.classList.contains('hidden')) {
            if (event.key === 'Escape') {
                closeServerInfoImageViewer();
            } else if (event.key === '+' || event.key === '=') {
                setServerInfoZoom(serverInfoState.zoomScale + 0.35);
            } else if (event.key === '-') {
                setServerInfoZoom(serverInfoState.zoomScale - 0.35);
            } else if (event.key === '0') {
                resetServerInfoZoom();
            }
            return;
        }
        if (!isModalVisible('server-info-modal')) {
            return;
        }
        if (event.key === 'Escape') {
            closeServerInfoModal();
        } else if (event.key === 'ArrowLeft') {
            moveServerInfoImage(-1);
        } else if (event.key === 'ArrowRight') {
            moveServerInfoImage(1);
        }
    });
}

function extractFileName(filePath) {
    if (!filePath) {
        return 'unknown-file';
    }
    const parts = String(filePath).split(/[\\/]/g);
    return parts[parts.length - 1] || String(filePath);
}

function extractParentFolderName(filePath) {
    if (!filePath) {
        return 'archive';
    }
    const parts = String(filePath).split(/[\\/]/g).filter(Boolean);
    if (parts.length < 2) {
        return 'archive';
    }
    return parts[parts.length - 2];
}

function isAdminUser() {
    return Boolean(currentUser && currentUser.role === 'admin');
}

function formatUpdateMode(mode, operation = 'update') {
    if (operation === 'downgrade') {
        if (mode === 'server_only_move_all_mods') {
            return 'Downgrade server only and move all mods';
        }
        if (mode === 'server_and_compatible_mods') {
            return 'Downgrade server and keep only compatible mods';
        }
    }
    if (mode === 'server_only_move_all_mods') {
        return 'Update server only and move all mods';
    }
    if (mode === 'server_and_compatible_mods') {
        return 'Update server and keep only compatible mods';
    }
    return mode || 'Unknown mode';
}

function formatMoveReason(reason) {
    const map = {
        blocked: 'incompatible with target',
        unknown: 'compatibility unknown',
        server_only_mode: 'server-only mode',
        replaced_by_update: 'replaced by newer version'
    };
    return map[reason] || reason || 'moved';
}

function appendSummarySection(container, title, items, tone = '') {
    const section = document.createElement('section');
    section.className = `update-summary-section${tone ? ` ${tone}` : ''}`;
    const heading = document.createElement('h3');
    heading.textContent = title;
    section.appendChild(heading);

    if (!items || items.length === 0) {
        const emptyText = document.createElement('p');
        emptyText.className = 'update-summary-empty';
        emptyText.textContent = 'None.';
        section.appendChild(emptyText);
        container.appendChild(section);
        return;
    }

    const list = document.createElement('ul');
    items.forEach(itemText => {
        const li = document.createElement('li');
        li.textContent = itemText;
        list.appendChild(li);
    });
    section.appendChild(list);
    container.appendChild(section);
}

function openUpdateSummaryModal(result) {
    const modal = document.getElementById('update-summary-modal');
    const content = document.getElementById('update-summary-content');
    const title = document.getElementById('update-summary-title');
    if (!modal || !content || !title) {
        return;
    }

    content.innerHTML = '';
    const updatedMods = Array.isArray(result && result.updatedMods) ? result.updatedMods : [];
    const movedMods = Array.isArray(result && result.movedMods) ? result.movedMods : [];
    const notUpdatedMods = movedMods.filter(mod => mod.reason !== 'replaced_by_update');
    const preCount = Array.isArray(result && result.preModManifest) ? result.preModManifest.length : null;
    const postCount = Array.isArray(result && result.postModManifest) ? result.postModManifest.length : null;
    const adminView = isAdminUser();
    const archiveFolderName = result && result.archiveDir ? extractFileName(result.archiveDir) : null;
    const operation = result && result.operation === 'downgrade' ? 'downgrade' : 'update';

    title.textContent = result && result.succeeded === false
        ? `${getOperationVerb(operation)} Failed Summary`
        : `${getOperationVerb(operation)} Summary`;

    const overview = document.createElement('section');
    overview.className = 'update-summary-section';
    const overviewTitle = document.createElement('h3');
    overviewTitle.textContent = 'Overview';
    overview.appendChild(overviewTitle);

    const overviewLines = [
        `Server version: ${result && result.targetVersion ? result.targetVersion : 'unknown'}`,
        `Operation: ${operation}`,
        `Mode: ${formatUpdateMode(result && result.mode, operation)}`,
        `Mods updated: ${updatedMods.length}`,
        `Mods not updated: ${notUpdatedMods.length}`,
        `Archive folder: ${result && result.archiveDir ? (adminView ? result.archiveDir : `${archiveFolderName} (inside server directory)`) : 'Not created'}`,
        `Snapshot: ${result && result.snapshotPath ? (adminView ? result.snapshotPath : 'Created in backup storage before update') : 'Not recorded'}`
    ];
    if (preCount != null && postCount != null) {
        overviewLines.push(`Mods folder count: ${preCount} before -> ${postCount} after`);
    }
    overviewLines.forEach(line => {
        const p = document.createElement('p');
        p.className = 'update-summary-meta';
        p.textContent = line;
        overview.appendChild(p);
    });
    content.appendChild(overview);

    appendSummarySection(
        content,
        'Mods Updated',
        updatedMods.map(mod => {
            const name = mod.modId || mod.fileName || 'mod';
            const fromVersion = mod.fromVersion || 'unknown';
            const toVersion = mod.toVersion || 'latest';
            const fileName = mod.fileName || 'unknown-file';
            return `${name}: ${fromVersion} -> ${toVersion} (${fileName})`;
        }),
        'is-updated'
    );

    if (notUpdatedMods.length > 0) {
        appendSummarySection(
            content,
            'Mods Not Updated',
            notUpdatedMods.map(mod => {
                const fileName = extractFileName(mod.from);
                const reason = formatMoveReason(mod.reason);
                const destination = mod.to || 'unknown destination';
                if (adminView) {
                    return `${fileName}: ${reason} -> ${destination}`;
                }
                const destinationFolder = extractParentFolderName(destination);
                const destinationFile = extractFileName(destination);
                return `${fileName}: ${reason} -> ${destinationFolder}/${destinationFile}`;
            }),
            'is-not-updated'
        );
    }

    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');
    syncModalOpenState();
}

function describeBlockingReasons(reasons) {
    const lookup = {
        blocked_by_java: 'Java version is too old for the target Minecraft release.',
        blocked_by_java_detection: 'Java runtime could not be detected from the launch script.',
        blocked_by_disk: 'Insufficient disk space for safe update + rollback.',
        blocked_by_fabric_support: 'Fabric loader support for the target version was not found.',
        blocked_by_mod_scan_failure: 'Mod compatibility scan failed.',
        blocked_by_minecraft_manifest: 'Minecraft version metadata lookup failed.',
        blocked_by_version_direction: 'Selected target is not an eligible version change.'
    };
    return (reasons || []).map(reason => lookup[reason] || reason);
}

function getVersionInfo(check, key, fallbackVersion) {
    const info = check && check.versionInfo && check.versionInfo[key] ? check.versionInfo[key] : null;
    return {
        version: (info && info.version) || fallbackVersion || null,
        releaseTime: info && info.releaseTime ? info.releaseTime : null,
        releaseDate: info && info.releaseDate ? info.releaseDate : null
    };
}

function renderCompatibleTargetOptions(check, container) {
    if (!container) {
        return false;
    }
    container.innerHTML = '';
    const operation = getCheckOperation(check);
    const targets = Array.isArray(check && check.compatibleTargets)
        ? check.compatibleTargets
        : [];
    const usableTargets = targets.filter(target => target && target.targetVersion);
    if (!usableTargets.length) {
        container.classList.add('hidden');
        return false;
    }

    usableTargets.forEach(target => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'compatible-version-option-btn';
        button.textContent = formatCompatibleTargetButtonLabel(target, operation);
        button.dataset.targetVersion = target.targetVersion;
        button.dataset.direction = operation;
        button.dataset.advanced = 'true';
        button.disabled = target.javaCompatible === false;
        if (button.disabled) {
            button.title = 'Java is too old for this target.';
        }
        button.addEventListener('click', useCompatibleVersionTarget);
        container.appendChild(button);
    });
    container.classList.remove('hidden');
    return true;
}

function openUpdateModal(check) {
    activeUpdateCheck = check;
    const modal = document.getElementById('update-modal');
    const summary = document.getElementById('update-modal-summary');
    const modWarning = document.getElementById('update-mod-warning');
    const javaWarning = document.getElementById('update-java-warning');
    const downgradeWarning = document.getElementById('update-downgrade-warning');
    const conflicts = document.getElementById('update-conflicts');
    const conflictList = document.getElementById('update-conflict-list');
    const compatibleBtn = document.getElementById('update-compatible-btn');
    const serverOnlyBtn = document.getElementById('update-server-only-btn');
    const compatibleVersionBtn = document.getElementById('update-compatible-version-btn');
    const compatibleVersionOptions = document.getElementById('update-compatible-version-options');
    const cancelBtn = document.getElementById('update-cancel-btn');
    const title = document.getElementById('update-modal-title');

    if (!modal || !summary || !modWarning || !javaWarning || !conflicts || !conflictList || !compatibleBtn || !serverOnlyBtn || !compatibleVersionBtn || !cancelBtn) {
        return;
    }

    const operation = getCheckOperation(check);
    const conflictMods = getConflictMods(check);
    const hasConflicts = conflictMods.length > 0;
    const canApply = Boolean(check && check.canApply);
    const blockingReasons = Array.isArray(check.blockingReasons) ? check.blockingReasons : [];
    const hasJavaBlock = blockingReasons.includes('blocked_by_java') || blockingReasons.includes('blocked_by_java_detection');
    const currentInfo = getVersionInfo(check, 'current', check.currentVersion);
    const targetInfo = getVersionInfo(check, 'target', check.targetVersion);

    if (title) {
        title.textContent = operation === 'downgrade' ? 'Server Downgrade' : 'Server Update';
    }
    summary.textContent = `Current: ${formatVersionWithRelease(currentInfo, check.currentVersion)} | Target: ${formatVersionWithRelease(targetInfo, check.targetVersion)}.`;

    if (downgradeWarning) {
        if (operation === 'downgrade') {
            downgradeWarning.classList.remove('hidden');
            downgradeWarning.textContent = 'Downgrading can cause data loss or corrupt the world. The updater will create a snapshot first, but you should only continue if you know what you are doing.';
        } else {
            downgradeWarning.classList.add('hidden');
            downgradeWarning.textContent = '';
        }
    }

    if (hasConflicts) {
        modWarning.classList.remove('hidden');
        modWarning.textContent = `Warning: ${conflictMods.length} mod${conflictMods.length === 1 ? '' : 's'} do not have a compatible release for Minecraft ${check.targetVersion || 'the target version'}.`;
    } else {
        modWarning.classList.add('hidden');
        modWarning.textContent = '';
    }

    const javaMessages = [];
    if (blockingReasons.length > 0) {
        javaMessages.push(...describeBlockingReasons(blockingReasons));
    }
    if (hasJavaBlock && check.java && check.java.requiredJavaMajor) {
        const detected = check.java.detectedJavaMajor != null ? check.java.detectedJavaMajor : 'unknown';
        javaMessages.push(`Required Java: ${check.java.requiredJavaMajor}. Detected: ${detected} (${check.java.detectedJavaPath || 'unknown path'}).`);
        javaMessages.push('Upgrade Java and run the update check again.');
    }

    if (javaMessages.length > 0) {
        javaWarning.classList.remove('hidden');
        javaWarning.classList.toggle('critical', hasJavaBlock);
        javaWarning.textContent = javaMessages.join(' ');
    } else {
        javaWarning.classList.add('hidden');
        javaWarning.classList.remove('critical');
        javaWarning.textContent = '';
    }

    conflictList.innerHTML = '';
    if (hasConflicts) {
        conflicts.classList.remove('hidden');
        conflictMods.forEach(mod => {
            const li = document.createElement('li');
            const modLabel = mod.modId || mod.fileName;
            li.textContent = `${modLabel}: ${mod.reason || 'No compatible update found.'}`;
            conflictList.appendChild(li);
        });
    } else {
        conflicts.classList.add('hidden');
    }

    compatibleBtn.classList.remove('hidden');
    serverOnlyBtn.classList.remove('hidden');
    compatibleVersionBtn.classList.add('hidden');
    if (compatibleVersionOptions) {
        compatibleVersionOptions.innerHTML = '';
        compatibleVersionOptions.classList.add('hidden');
    }
    compatibleBtn.textContent = `${getOperationVerb(operation)} Server and Only Compatible Mods`;
    serverOnlyBtn.textContent = `${getOperationVerb(operation)} Server Only and Move All Mods`;
    cancelBtn.disabled = false;
    serverOnlyBtn.disabled = !canApply;
    compatibleBtn.disabled = !canApply;

    if (!hasConflicts) {
        serverOnlyBtn.classList.add('hidden');
    }

    const hasAdvancedCompatibleTargets = hasConflicts && renderCompatibleTargetOptions(check, compatibleVersionOptions);
    if (!hasAdvancedCompatibleTargets && check.recommendedTargetVersion && hasConflicts) {
        compatibleVersionBtn.classList.remove('hidden');
        const recommendedReleaseLabel = formatReleaseDateLabel(
            check.recommendedTargetReleaseTime,
            check.recommendedTargetReleaseDate
        );
        if (recommendedReleaseLabel) {
            compatibleVersionBtn.textContent = `${getOperationVerb(operation)} Compatible Version (${check.recommendedTargetVersion} - ${recommendedReleaseLabel})`;
        } else {
            compatibleVersionBtn.textContent = `${getOperationVerb(operation)} Compatible Version (${check.recommendedTargetVersion})`;
        }
        compatibleVersionBtn.dataset.targetVersion = check.recommendedTargetVersion;
        compatibleVersionBtn.dataset.direction = operation;
        compatibleVersionBtn.dataset.advanced = check.advanced ? 'true' : 'false';
        if (check.recommendedTargetCanApply === false) {
            compatibleVersionBtn.disabled = true;
        } else {
            compatibleVersionBtn.disabled = false;
        }
    } else {
        compatibleVersionBtn.classList.add('hidden');
        compatibleVersionBtn.removeAttribute('data-target-version');
        compatibleVersionBtn.removeAttribute('data-direction');
        compatibleVersionBtn.removeAttribute('data-advanced');
    }

    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');
    syncModalOpenState();
}

async function runUpdatePreflight() {
    return runUpdatePreflightForTarget(null);
}

async function runUpdatePreflightForTarget(targetVersion, options = {}) {
    const button = document.getElementById('update-server');
    if (!button || isApplyingUpdate) {
        return null;
    }
    const advanced = Boolean(options.advanced);
    const direction = options.direction === 'downgrade' ? 'downgrade' : 'update';
    const acknowledgeDowngradeRisk = Boolean(options.acknowledgeDowngradeRisk);

    const token = getAuthToken();
    if (!token) {
        alert('You are not authenticated.');
        redirectToLogin();
        return null;
    }

    button.disabled = true;
    stopUpdateButtonAnimation({ restoreLabel: false });
    setUpdateButtonLabel('Checking...', { includeSeverityIcon: false });

    try {
        const response = await fetch(advanced ? '/updates/advanced/check' : '/updates/check', {
            method: 'POST',
            headers: getAuthHeaders(true),
            body: JSON.stringify(advanced
                ? { targetVersion, direction }
                : (targetVersion ? { targetVersion } : {}))
        });
        if (response.status === 428) {
            alert('You must set a new password before continuing.');
            redirectToSetPassword();
            return null;
        }
        if (response.status === 401 || response.status === 403) {
            alert('Session has expired, please log in again.');
            redirectToLogin();
            return null;
        }
        if (!response.ok) {
            const body = await response.json().catch(() => ({}));
            throw new Error(body.message || `Update preflight failed (${response.status})`);
        }

        const check = await response.json();
        const hasVersionChange = advanced
            ? Boolean(check.versionChangeAvailable)
            : Boolean(check.updateAvailable);
        if (!hasVersionChange) {
            if (advanced) {
                setUpdateStatusMessage('Selected version is not an eligible version change.', true);
                return null;
            }
            latestUpdateStatus = {
                ...(latestUpdateStatus || {}),
                updateAvailable: false,
                updateInProgress: false,
                latestVersion: check.latestVersion || null
            };
            setUpdateButtonSeverity('none');
            stopUpdateButtonAnimation({ restoreLabel: false });
            button.classList.add('hidden');
            setUpdateStatusMessage('No new Minecraft version is available right now.');
            await loadUpdateStatus({ forceRefresh: true });
            return null;
        }

        const hasConflicts = getConflictMods(check).length > 0;
        applySeverityFromCheck(check);
        backgroundPreflightLastTarget = check.targetVersion || latestUpdateStatus.latestVersion || null;
        backgroundPreflightLastAt = Date.now();

        if (!hasConflicts && check.canApply) {
            activeUpdateCheck = {
                ...check,
                downgradeRiskAcknowledged: acknowledgeDowngradeRisk
            };
            const targetReleaseLabel = formatReleaseDateLabel(
                check && check.versionInfo && check.versionInfo.target
                    ? check.versionInfo.target.releaseTime
                    : null,
                check && check.versionInfo && check.versionInfo.target
                    ? check.versionInfo.target.releaseDate
                    : null
            );
            const operation = getCheckOperation(check);
            if (targetReleaseLabel) {
                setUpdateStatusMessage(`No compatibility issues detected. Starting ${getOperationVerb(operation, true)} to ${check.targetVersion} (released ${targetReleaseLabel})...`);
            } else {
                setUpdateStatusMessage(`No compatibility issues detected. Starting ${getOperationVerb(operation, true)} to ${check.targetVersion}...`);
            }
            await applyUpdateMode('server_and_compatible_mods');
            return check;
        }

        if (advanced) {
            check.downgradeRiskAcknowledged = acknowledgeDowngradeRisk;
        }
        openUpdateModal(check);
        return check;
    } catch (err) {
        console.error('Update preflight error:', err);
        alert(err.message || 'Failed to run update preflight check.');
        return null;
    } finally {
        const updateRunning = Boolean(latestUpdateStatus && latestUpdateStatus.updateInProgress) || isApplyingUpdate;
        if (updateRunning) {
            startUpdateButtonAnimation('Updating');
        } else {
            stopUpdateButtonAnimation({ restoreLabel: false });
            updateUpdateButtonLabel();
        }
        if ((!latestUpdateStatus || !latestUpdateStatus.updateInProgress) && !isApplyingUpdate) {
            button.disabled = false;
        }
        if (button.textContent === 'Checking...' && !updateRunning) {
            updateUpdateButtonLabel();
        }
    }
}

async function applyUpdateMode(mode) {
    if (!activeUpdateCheck || !activeUpdateCheck.checkId || isApplyingUpdate) {
        return;
    }

    const token = getAuthToken();
    if (!token) {
        alert('You are not authenticated.');
        redirectToLogin();
        return;
    }

    isApplyingUpdate = true;
    const operation = getCheckOperation(activeUpdateCheck);
    startUpdateButtonAnimation(operation === 'downgrade' ? 'Downgrading' : 'Updating');
    setUpdateActionDisabled(true);
    setMainServerControlsDisabled(true);
    closeUpdateModal();
    closeUpdateAdvancedModal();
    setUpdateStatusMessage(`${getOperationVerb(operation)} started. Waiting for completion...`);

    try {
        const response = await fetch('/updates/apply', {
            method: 'POST',
            headers: getAuthHeaders(true),
            body: JSON.stringify({
                checkId: activeUpdateCheck.checkId,
                mode,
                acknowledgeDowngradeRisk: operation === 'downgrade'
                    ? Boolean(activeUpdateCheck.downgradeRiskAcknowledged)
                    : undefined
            })
        });

        if (response.status === 401 || response.status === 403) {
            alert('Session has expired, please log in again.');
            redirectToLogin();
            return;
        }
        if (response.status === 428) {
            alert('You must set a new password before continuing.');
            redirectToSetPassword();
            return;
        }
        if (!response.ok) {
            const payload = await response.json().catch(() => ({}));
            throw new Error(payload.message || `Update failed (${response.status})`);
        }

        const payload = await response.json();
        closeUpdateModal();
        openUpdateSummaryModal(payload && payload.result ? payload.result : null);
        clearAdvancedVersionCache();
        await loadUpdateStatus({ forceRefresh: true });
        checkServerStatus();
    } catch (err) {
        console.error('Apply update failed:', err);
        alert(err.message || 'Update failed.');
    } finally {
        isApplyingUpdate = false;
        setUpdateActionDisabled(false);
        await loadUpdateStatus({ forceRefresh: true }).catch(() => null);
        checkServerStatus();
        if (!latestUpdateStatus || !latestUpdateStatus.updateInProgress) {
            stopUpdateButtonAnimation();
        }
    }
}

async function useCompatibleVersionTarget(event) {
    const button = event && event.currentTarget
        ? event.currentTarget
        : document.getElementById('update-compatible-version-btn');
    const targetVersion = button ? button.dataset.targetVersion : null;
    if (!targetVersion || isApplyingUpdate) {
        return;
    }
    const advanced = button.dataset.advanced === 'true';
    const direction = button.dataset.direction || getCheckOperation(activeUpdateCheck);
    const acknowledgeDowngradeRisk = Boolean(activeUpdateCheck && activeUpdateCheck.downgradeRiskAcknowledged);
    closeUpdateModal();
    setUpdateStatusMessage(`Checking compatible version ${targetVersion}...`);
    await runUpdatePreflightForTarget(targetVersion, {
        advanced,
        direction,
        acknowledgeDowngradeRisk
    });
}

function closeUpdateAdvancedMenu() {
    const menu = document.getElementById('update-advanced-menu');
    if (!menu) {
        return;
    }
    menu.classList.add('hidden');
    menu.setAttribute('aria-hidden', 'true');
}

function openUpdateAdvancedMenu(event) {
    const menu = document.getElementById('update-advanced-menu');
    if (!menu || isApplyingUpdate || (latestUpdateStatus && latestUpdateStatus.updateInProgress)) {
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    closeServerManagementDropdown();
    const padding = 8;
    const anchor = event.currentTarget || document.getElementById('update-server');
    menu.classList.remove('hidden');
    menu.setAttribute('aria-hidden', 'false');
    const menuRect = menu.getBoundingClientRect();
    const anchorRect = anchor ? anchor.getBoundingClientRect() : null;
    if (anchorRect) {
        const left = Math.min(anchorRect.left, window.innerWidth - menuRect.width - padding);
        const preferredTop = anchorRect.top - menuRect.height - 12;
        const fallbackTop = anchorRect.bottom + 12;
        const top = preferredTop >= padding
            ? preferredTop
            : Math.min(fallbackTop, window.innerHeight - menuRect.height - padding);
        menu.style.left = `${Math.max(padding, left)}px`;
        menu.style.top = `${Math.max(padding, top)}px`;
        return;
    }
    const left = Math.min(event.clientX + 12, window.innerWidth - menuRect.width - padding);
    const top = Math.min(event.clientY + 12, window.innerHeight - menuRect.height - padding);
    menu.style.left = `${Math.max(padding, left)}px`;
    menu.style.top = `${Math.max(padding, top)}px`;
}

function setAdvancedVersionError(message) {
    const error = document.getElementById('advanced-version-error');
    if (!error) {
        return;
    }
    if (!message) {
        error.textContent = '';
        error.classList.add('hidden');
        return;
    }
    error.textContent = message;
    error.classList.remove('hidden');
}

function getSelectedAdvancedVersionOption() {
    const select = document.getElementById('advanced-version-select');
    if (!select || select.selectedIndex < 0) {
        return null;
    }
    return select.options[select.selectedIndex] || null;
}

function getSelectedAdvancedDirection() {
    const option = getSelectedAdvancedVersionOption();
    return option && option.dataset.direction === 'downgrade' ? 'downgrade' : 'update';
}

function syncAdvancedModeUi() {
    const warning = document.getElementById('advanced-downgrade-warning');
    const ackRow = document.getElementById('advanced-downgrade-ack-row');
    const checkBtn = document.getElementById('advanced-check-btn');
    const ack = document.getElementById('advanced-downgrade-ack');
    const select = document.getElementById('advanced-version-select');
    const isDowngrade = getSelectedAdvancedDirection() === 'downgrade';
    advancedUpdateDirection = isDowngrade ? 'downgrade' : 'update';

    if (warning) {
        warning.classList.toggle('hidden', !isDowngrade);
    }
    if (ackRow) {
        ackRow.classList.toggle('hidden', !isDowngrade);
    }
    if (checkBtn) {
        checkBtn.textContent = isDowngrade ? 'Downgrade' : 'Update';
        checkBtn.disabled = Boolean(select && select.disabled) || (isDowngrade && ack && !ack.checked);
    }
}

function populateAdvancedVersionSelect(payload) {
    const select = document.getElementById('advanced-version-select');
    const summary = document.getElementById('update-advanced-summary');
    if (!select) {
        return;
    }
    select.innerHTML = '';
    const versions = Array.isArray(payload && payload.versions) ? payload.versions : [];
    const updateVersions = versions.filter(item => item && item.direction !== 'downgrade');
    const downgradeVersions = versions.filter(item => item && item.direction === 'downgrade');

    function appendOptions(groupLabel, items) {
        if (!items.length) {
            return;
        }
        const group = document.createElement('optgroup');
        group.label = groupLabel;
        items.forEach(item => {
            const option = document.createElement('option');
            option.value = item.version;
            option.dataset.direction = item.direction === 'downgrade' ? 'downgrade' : 'update';
            option.textContent = formatVersionWithRelease(item, item.version);
            group.appendChild(option);
        });
        select.appendChild(group);
    }

    appendOptions('Updates', updateVersions);
    appendOptions('Downgrades', downgradeVersions);

    if (!versions.length) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = 'No eligible version changes';
        select.appendChild(option);
    }
    select.disabled = versions.length === 0;
    if (summary) {
        summary.textContent = `Current: ${formatVersionWithRelease(payload.currentVersionInfo, payload.currentVersion)} | ${formatLoaderVersionLabel(payload.currentLoader, payload.currentLoaderVersion)}.`;
    }
    syncAdvancedModeUi();
}

async function fetchAdvancedVersionDirection(direction) {
    const response = await fetch(`/updates/advanced/versions?direction=${encodeURIComponent(direction)}`, {
        headers: getAuthHeaders(false)
    });
    if (response.status === 428) {
        redirectToSetPassword();
        return null;
    }
    if (response.status === 401 || response.status === 403) {
        redirectToLogin();
        return null;
    }
    if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.message || `Failed to load ${direction} versions (${response.status})`);
    }
    return response.json();
}

async function loadAdvancedVersionOptions({ force = false } = {}) {
    const select = document.getElementById('advanced-version-select');
    const checkBtn = document.getElementById('advanced-check-btn');
    setAdvancedVersionError('');
    if (select) {
        select.disabled = true;
        select.innerHTML = '';
        const loading = document.createElement('option');
        loading.value = '';
        loading.textContent = 'Loading versions...';
        select.appendChild(loading);
    }
    if (checkBtn) {
        checkBtn.disabled = true;
    }

    try {
        if (!force && advancedVersionCache.all) {
            populateAdvancedVersionSelect(advancedVersionCache.all);
            syncAdvancedModeUi();
            return;
        }

        const [updatePayload, downgradePayload] = await Promise.all([
            fetchAdvancedVersionDirection('update'),
            fetchAdvancedVersionDirection('downgrade')
        ]);
        if (!updatePayload || !downgradePayload) {
            return;
        }

        const updateVersions = (Array.isArray(updatePayload.versions) ? updatePayload.versions : [])
            .map(item => ({ ...item, direction: 'update' }));
        const downgradeVersions = (Array.isArray(downgradePayload.versions) ? downgradePayload.versions : [])
            .map(item => ({ ...item, direction: 'downgrade' }));
        const payload = {
            currentVersion: updatePayload.currentVersion || downgradePayload.currentVersion || null,
            currentVersionInfo: updatePayload.currentVersionInfo || downgradePayload.currentVersionInfo || null,
            currentLoader: updatePayload.currentLoader || downgradePayload.currentLoader || 'fabric',
            currentLoaderVersion: updatePayload.currentLoaderVersion || downgradePayload.currentLoaderVersion || null,
            latestVersion: updatePayload.latestVersion || null,
            latestMinecraftVersion: updatePayload.latestMinecraftVersion || null,
            versions: [...updateVersions, ...downgradeVersions]
        };
        advancedVersionCache.all = payload;
        populateAdvancedVersionSelect(payload);
    } catch (err) {
        console.error('Advanced version load failed:', err);
        setAdvancedVersionError(err.message || 'Failed to load versions.');
    } finally {
        syncAdvancedModeUi();
    }
}

async function openUpdateAdvancedModal() {
    closeUpdateAdvancedMenu();
    closeServerManagementDropdown();
    if (isApplyingUpdate || (latestUpdateStatus && latestUpdateStatus.updateInProgress)) {
        return;
    }
    const modal = document.getElementById('update-advanced-modal');
    if (!modal) {
        return;
    }
    setAdvancedVersionError('');
    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');
    syncModalOpenState();
    await loadAdvancedVersionOptions();
}

function setupServerManagementMenu() {
    const button = document.getElementById('server-management-button');
    const dropdown = document.getElementById('server-management-dropdown');
    const backupButton = document.getElementById('sftp-button');
    const infoButton = document.getElementById('server-info-button');
    const versionButton = document.getElementById('server-version-button');
    const accountButton = document.getElementById('account-button');

    if (button && dropdown) {
        button.addEventListener('click', event => {
            event.stopPropagation();
            const isOpening = dropdown.classList.contains('hidden');
            if (isOpening) {
                closeAccountDropdown();
                closeUpdateAdvancedMenu();
            }
            dropdown.classList.toggle('hidden', !isOpening);
            dropdown.setAttribute('aria-hidden', isOpening ? 'false' : 'true');
            button.setAttribute('aria-expanded', isOpening ? 'true' : 'false');
        });

        dropdown.addEventListener('click', event => {
            event.stopPropagation();
        });
    }

    if (backupButton) {
        backupButton.addEventListener('click', () => {
            window.location.href = '/sftp.html';
        });
    }

    if (infoButton) {
        infoButton.addEventListener('click', openServerInfoModal);
    }

    if (versionButton) {
        versionButton.addEventListener('click', openUpdateAdvancedModal);
    }

    if (accountButton) {
        accountButton.addEventListener('click', closeServerManagementDropdown);
    }
}

async function runAdvancedVersionPreflight() {
    const select = document.getElementById('advanced-version-select');
    const ack = document.getElementById('advanced-downgrade-ack');
    const targetVersion = select ? select.value : '';
    const direction = getSelectedAdvancedDirection();
    const isDowngrade = direction === 'downgrade';
    if (!targetVersion) {
        setAdvancedVersionError('Choose a Minecraft version first.');
        return;
    }
    if (isDowngrade && (!ack || !ack.checked)) {
        setAdvancedVersionError('You must acknowledge the downgrade risk before continuing.');
        syncAdvancedModeUi();
        return;
    }

    setAdvancedVersionError('');
    closeUpdateAdvancedModal();
    setUpdateStatusMessage(`Preparing ${getOperationVerb(direction, true)} to ${targetVersion}...`);
    await runUpdatePreflightForTarget(targetVersion, {
        advanced: true,
        direction,
        acknowledgeDowngradeRisk: isDowngrade
    });
}

function setupUpdateModalHandlers() {
    const updateButton = document.getElementById('update-server');
    if (updateButton) {
        updateButton.addEventListener('click', runUpdatePreflight);
        updateButton.addEventListener('contextmenu', openUpdateAdvancedMenu);
    }

    const advancedOpenBtn = document.getElementById('update-advanced-open-btn');
    if (advancedOpenBtn) {
        advancedOpenBtn.addEventListener('click', openUpdateAdvancedModal);
    }

    document.addEventListener('click', event => {
        const menu = document.getElementById('update-advanced-menu');
        if (!menu || menu.classList.contains('hidden')) {
            closeServerManagementDropdown();
            return;
        }
        if (!menu.contains(event.target)) {
            closeUpdateAdvancedMenu();
        }
        closeServerManagementDropdown();
    });

    document.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
            closeUpdateAdvancedMenu();
            closeServerManagementDropdown();
        }
    });

    const cancelBtn = document.getElementById('update-cancel-btn');
    if (cancelBtn) {
        cancelBtn.addEventListener('click', closeUpdateModal);
    }

    const compatibleBtn = document.getElementById('update-compatible-btn');
    if (compatibleBtn) {
        compatibleBtn.addEventListener('click', () => applyUpdateMode('server_and_compatible_mods'));
    }

    const serverOnlyBtn = document.getElementById('update-server-only-btn');
    if (serverOnlyBtn) {
        serverOnlyBtn.addEventListener('click', () => applyUpdateMode('server_only_move_all_mods'));
    }

    const compatibleVersionBtn = document.getElementById('update-compatible-version-btn');
    if (compatibleVersionBtn) {
        compatibleVersionBtn.addEventListener('click', useCompatibleVersionTarget);
    }

    document.querySelectorAll('[data-close-update-modal="true"]').forEach(node => {
        node.addEventListener('click', closeUpdateModal);
    });

    const advancedVersionSelect = document.getElementById('advanced-version-select');
    if (advancedVersionSelect) {
        advancedVersionSelect.addEventListener('change', () => {
            const ack = document.getElementById('advanced-downgrade-ack');
            if (ack && getSelectedAdvancedDirection() !== 'downgrade') {
                ack.checked = false;
            }
            setAdvancedVersionError('');
            syncAdvancedModeUi();
        });
    }

    const advancedAck = document.getElementById('advanced-downgrade-ack');
    if (advancedAck) {
        advancedAck.addEventListener('change', syncAdvancedModeUi);
    }

    const advancedCancelBtn = document.getElementById('advanced-cancel-btn');
    if (advancedCancelBtn) {
        advancedCancelBtn.addEventListener('click', closeUpdateAdvancedModal);
    }

    const advancedCheckBtn = document.getElementById('advanced-check-btn');
    if (advancedCheckBtn) {
        advancedCheckBtn.addEventListener('click', runAdvancedVersionPreflight);
    }

    document.querySelectorAll('[data-close-update-advanced="true"]').forEach(node => {
        node.addEventListener('click', closeUpdateAdvancedModal);
    });

    const summaryCloseBtn = document.getElementById('update-summary-close-btn');
    if (summaryCloseBtn) {
        summaryCloseBtn.addEventListener('click', closeUpdateSummaryModal);
    }

    document.querySelectorAll('[data-close-update-summary="true"]').forEach(node => {
        node.addEventListener('click', closeUpdateSummaryModal);
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
    const pointerTargetSelector = [
        'button:not([data-no-pointer-lighting])',
        '[data-pointer-profile="surface"]',
        '#progress-container'
    ].join(', ');
    const targets = [...document.querySelectorAll(pointerTargetSelector)];
    const finePointerQuery = window.matchMedia('(hover: hover) and (pointer: fine)');
    const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');

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
        const target = el ? el.closest(pointerTargetSelector) : null;
        const surfaceTarget = target && target.dataset.pointerProfile === 'surface';

        if (currentTarget && currentTarget !== target) {
            resetTarget(currentTarget);
        }

        if (surfaceTarget && (
            document.body.dataset.uiTheme !== 'glass'
            || !finePointerQuery.matches
            || reducedMotionQuery.matches
            || event.pointerType === 'touch'
            || event.buttons !== 0
        )) {
            resetTarget(target);
            currentTarget = null;
            return;
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
        const pointerProfile = target.dataset.pointerProfile;
        const compactProfile = pointerProfile === 'compact';
        const surfaceProfile = pointerProfile === 'surface';
        const pop = isProgress
            ? lightPop * 0.55
            : (surfaceProfile ? lightPop * 0.72 : lightPop);
        const translateMax = isProgress ? 0 : (surfaceProfile ? 3.5 : (compactProfile ? 7 : 14));
        const shadowMax = isProgress ? 0 : (surfaceProfile ? 8 : (compactProfile ? 11 : 20));
        const skewMax = isProgress ? 0 : (surfaceProfile ? 0.65 : (compactProfile ? 1.75 : 3));
        const scaleMax = isProgress ? 1 : (surfaceProfile ? 1.008 : (compactProfile ? 1.018 : 1.03));
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

    const clearSurfaceTarget = () => {
        if (currentTarget && currentTarget.dataset.pointerProfile === 'surface') {
            clearTarget();
        }
    };

    document.addEventListener('pointermove', updateTarget);
    document.addEventListener('pointerdown', updateTarget);
    document.addEventListener('pointerleave', clearTarget);
    document.addEventListener('pointercancel', clearTarget);
    document.addEventListener('ui-pointer-lighting-reset', clearTarget);
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            clearTarget();
        }
    });
    window.addEventListener('blur', clearTarget);
    const messageScroller = document.getElementById('server-chat-messages');
    if (messageScroller) {
        messageScroller.addEventListener('scroll', clearSurfaceTarget, { passive: true });
    }
    if (typeof finePointerQuery.addEventListener === 'function') {
        finePointerQuery.addEventListener('change', clearSurfaceTarget);
        reducedMotionQuery.addEventListener('change', clearSurfaceTarget);
    }

    const themeObserver = new MutationObserver(clearTarget);
    themeObserver.observe(document.body, {
        attributes: true,
        attributeFilter: ['data-ui-theme']
    });
}

document.addEventListener('DOMContentLoaded', async function() {
    const user = await loadCurrentUser();
    if (!user) {
        return;
    }
    currentUser = user;
    if (window.Appearance && typeof window.Appearance.init === 'function') {
        window.Appearance.init({ user });
    }
    if (window.ServerChat && typeof window.ServerChat.init === 'function') {
        window.ServerChat.init({ user });
    }
    setupProgressBulge();
    setupPointerLighting();
    setupServerManagementMenu();
    setupServerInfoModalHandlers();
    setupUpdateModalHandlers();
    setupWebSocket();
    if (window.ServerChat && typeof window.ServerChat.start === 'function') {
        window.ServerChat.start();
    }
    setupUpdateStatusPolling();
    checkServerStatus();
    await loadUpdateStatus();
});

function checkServerStatus() {
    fetch('/status')
        .then(response => response.json())
        .then(data => {
            const startButton = document.getElementById('start-server');
            const stopButton = document.getElementById('stop-server');
            const backupButton = document.getElementById('backup-server');
            const restartButton = document.getElementById('restart-server');
            const updateButton = document.getElementById('update-server');
            const versionButton = document.getElementById('server-version-button');
            const updateLocked = Boolean(data.updateInProgress);
            const localUpdateLock = Boolean(isApplyingUpdate)
                || Boolean(latestUpdateStatus && latestUpdateStatus.updateInProgress);
            const controlsLocked = isBackingUp || updateLocked || localUpdateLock;

            startButton.disabled = controlsLocked || data.running;
            stopButton.disabled = controlsLocked || !data.running;
            backupButton.disabled = controlsLocked;
            restartButton.disabled = controlsLocked || !data.running;
            if (updateButton && !updateButton.classList.contains('hidden')) {
                if (updateButtonAnimationTimer) {
                    updateButton.disabled = true;
                } else {
                    updateButton.disabled = controlsLocked || isApplyingUpdate;
                }
            }
            if (versionButton) {
                versionButton.disabled = controlsLocked;
            }

            if (updateLocked) {
                setUpdateStatusMessage('Update in progress. Server controls are temporarily disabled.');
            }
        })
        .catch(err => {
            console.error('Error checking server status: ', err);
        });
}
function getWebSocketReconnectDelay() {
    const base = Math.min(1000 * (2 ** wsReconnectAttempt), 30000);
    wsReconnectAttempt = Math.min(wsReconnectAttempt + 1, 5);
    return Math.min(30000, Math.round(base * (0.75 + Math.random() * 0.5)));
}

function scheduleWebSocketReconnect() {
    if (wsStopped || wsReconnectTimer) {
        return;
    }
    const delay = getWebSocketReconnectDelay();
    wsReconnectTimer = setTimeout(() => {
        wsReconnectTimer = null;
        setupWebSocket();
    }, delay);
}

async function handleWebSocketPolicyClose() {
    const generation = wsLifecycleGeneration;
    try {
        const response = await fetch('/me', {
            headers: getAuthHeaders(),
            cache: 'no-store',
            credentials: 'same-origin'
        });
        if (generation !== wsLifecycleGeneration) {
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
        wsPolicyCloseCount += 1;
        if (response.ok && wsPolicyCloseCount <= 1) {
            scheduleWebSocketReconnect();
        } else {
            wsStopped = true;
            console.error('WebSocket policy validation failed repeatedly; automatic reconnect stopped.');
        }
    } catch (error) {
        if (generation !== wsLifecycleGeneration) {
            return;
        }
        wsPolicyCloseCount += 1;
        if (wsPolicyCloseCount <= 1) {
            scheduleWebSocketReconnect();
        } else {
            wsStopped = true;
            console.error('WebSocket policy revalidation failed repeatedly; automatic reconnect stopped.');
        }
    }
}

async function handleWebSocketPreOpenFailure() {
    if (wsPreOpenCheckInFlight || wsStopped) {
        return;
    }
    wsPreOpenCheckInFlight = true;
    const generation = wsLifecycleGeneration;
    try {
        const response = await fetch('/me', {
            headers: getAuthHeaders(),
            cache: 'no-store',
            credentials: 'same-origin'
        });
        if (generation !== wsLifecycleGeneration) {
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
        wsStopped = true;
        console.error('WebSocket upgrade failed repeatedly; automatic reconnect stopped until reload.');
    } catch (error) {
        if (generation !== wsLifecycleGeneration) {
            return;
        }
        wsStopped = true;
        console.error('WebSocket upgrade and authentication revalidation both failed; automatic reconnect stopped.');
    } finally {
        if (generation === wsLifecycleGeneration) {
            wsPreOpenCheckInFlight = false;
        }
    }
}

function setupWebSocket() {
    if (wsStopped || (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING))) {
        return;
    }
    const wsProtocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(wsProtocol + '://' + window.location.host + '/ws');
    ws = socket;
    let opened = false;

    socket.onopen = function() {
        if (ws !== socket) {
            socket.close();
            return;
        }
        opened = true;
        if (wsStabilityTimer) {
            clearTimeout(wsStabilityTimer);
        }
        wsStabilityTimer = setTimeout(() => {
            wsReconnectAttempt = 0;
            wsPolicyCloseCount = 0;
            wsPreOpenFailureCount = 0;
            wsStabilityTimer = null;
        }, 10000);
        console.log('WebSocket connection established');
        if (window.ServerChat && typeof window.ServerChat.handleSocketOpen === 'function') {
            window.ServerChat.handleSocketOpen();
        }
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
            return;
        }

        if (window.ServerChat
            && typeof window.ServerChat.handleRealtimeMessage === 'function'
            && window.ServerChat.handleRealtimeMessage(message)) {
            return;
        }

        if (Object.prototype.hasOwnProperty.call(message, 'requestId')) {
            return;
        }

        if (message.type === 'progress') {
          updateBackupProgress(message.value); // Update the progress bar with this value
        } else if (message.type === 'complete') {
          // When backup is complete, ensure the progress bar shows 100%
          updateBackupProgress('100');
          setBackupState(false); // Reset the backup state
        } else if (message.type === 'update-progress') {
          latestUpdateStatus = {
            ...(latestUpdateStatus || {}),
            updateInProgress: true
          };
          setMainServerControlsDisabled(true);
          startUpdateButtonAnimation('Updating');
          const label = message.message || 'Update in progress...';
          const percent = Number(message.value);
          if (Number.isFinite(percent)) {
            setUpdateStatusMessage(`${label} (${Math.round(percent)}%)`);
          } else {
            setUpdateStatusMessage(label);
          }
        } else if (message.type === 'update-complete') {
          latestUpdateStatus = {
            ...(latestUpdateStatus || {}),
            updateInProgress: false
          };
          stopUpdateButtonAnimation({ restoreLabel: false });
          if (message.success) {
            setUpdateStatusMessage('Update completed successfully.');
          } else {
            setUpdateStatusMessage('Update failed and rollback was attempted.', true);
          }
          closeUpdateModal();
          loadUpdateStatus({ forceRefresh: true });
          checkServerStatus();
        }
      };
    socket.onclose = function(e) {
        if (ws !== socket) {
            return;
        }
        ws = null;
        if (wsStabilityTimer) {
            clearTimeout(wsStabilityTimer);
            wsStabilityTimer = null;
        }
        if (window.ServerChat && typeof window.ServerChat.handleSocketClose === 'function') {
            window.ServerChat.handleSocketClose(e);
        }
        if (wsStopped) {
            return;
        }
        if (e.code === 1008) {
            handleWebSocketPolicyClose();
            return;
        }
        if (!opened) {
            wsPreOpenFailureCount += 1;
            if (wsPreOpenFailureCount >= WS_MAX_PREOPEN_FAILURES) {
                handleWebSocketPreOpenFailure();
                return;
            }
        }
        scheduleWebSocketReconnect();
    };

    socket.onerror = function() {
        console.error('Socket encountered an error; reconnect will use bounded backoff.');
        socket.close();
    };
}

window.addEventListener('pagehide', () => {
    wsLifecycleGeneration += 1;
    wsPreOpenCheckInFlight = false;
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
window.addEventListener('pageshow', (event) => {
    if (event.persisted) {
        wsStopped = false;
        wsReconnectAttempt = 0;
        wsPolicyCloseCount = 0;
        wsPreOpenFailureCount = 0;
        setupWebSocket();
    }
});
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
    } else if (response.status === 423) {
        alert('An update is currently in progress. Please wait until it completes.');
        return null;
    } else if (response.status === 409) {
        alert('Operation blocked due to update preflight state. Re-check updates and try again.');
        return null;
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
