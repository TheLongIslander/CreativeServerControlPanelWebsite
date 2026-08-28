/*
 * Purpose: Authenticated Minecraft chat UI, history reconciliation, unread state,
 *          safe panel sends, and admin chat controls.
 */
(function attachServerChat(global) {
    'use strict';

    const SERVER_ID = 'default';
    const UNREAD_BADGE_CAP = 500;
    const HISTORY_PAGE_SIZE = 200;
    const CATCH_UP_PAGE_SIZE = 500;
    const NEAR_BOTTOM_PX = 48;
    const STORAGE_VERSION = 1;
    const MESSAGE_LOG_LIVE_MODE = 'polite';
    const HISTORY_RETRY_INITIAL_MS = 1000;
    const HISTORY_RETRY_MAX_MS = 30000;
    const SOCKET_STATUS_FALLBACK_INITIAL_MS = 1500;
    const SOCKET_STATUS_FALLBACK_MAX_MS = 30000;
    const ACTIVITY_KINDS = new Set(['join', 'leave', 'death', 'advancement']);
    const MESSAGE_KINDS = new Set(['chat', ...ACTIVITY_KINDS]);
    const CHAT_EVENT_TYPES = new Set([
        'minecraft-chat-message',
        'minecraft-chat-session-reset',
        'minecraft-chat-session-status'
    ]);
    const ADMIN_HEALTH_FIELDS = [
        ['state', 'State'],
        ['reason', 'Reason'],
        ['lastRuntimeProbeAt', 'Last runtime probe'],
        ['lastLogReadAt', 'Last log read'],
        ['lastCursorCommitAt', 'Last cursor commit'],
        ['backlogBytes', 'Backlog bytes'],
        ['sendQueueDepth', 'Send queue depth'],
        ['pendingMessages', 'Pending messages'],
        ['unknownMessages', 'Unknown messages'],
        ['databaseBytes', 'Database bytes'],
        ['authenticatedSockets', 'Authenticated sockets'],
        ['droppedSockets', 'Dropped sockets'],
        ['lastError', 'Last error']
    ];

    const state = {
        open: false,
        initialized: false,
        loading: false,
        sending: false,
        connected: false,
        stateEpoch: null,
        stateRevision: -1,
        available: false,
        serverState: 'offline',
        ready: false,
        locked: null,
        healthState: 'unavailable',
        healthReason: null,
        capabilitiesLoaded: false,
        sendingEnabled: null,
        canSend: false,
        sendBlockedReason: 'capabilities_unknown',
        sessionKey: null,
        session: null,
        latestId: null,
        lastMergedId: null,
        readThroughId: null,
        scanThroughId: null,
        baselinePending: false,
        messagesByKey: new Map(),
        orderedMessages: [],
        filters: { chat: true, activity: true },
        nearBottom: true,
        unreadCount: 0,
        hasMoreBefore: false,
        limits: {
            maxMessageCodePoints: 256,
            maxCommandBytes: null,
            commandFormatVersion: null
        },
        previousFocus: null
    };

    const dom = {};
    const activeGetControllers = new Set();
    const deferredUnread = new Map();
    let currentUser = null;
    let started = false;
    let historyInitialized = false;
    let historyLoadPromise = null;
    let catchUpPromise = null;
    let olderPagePromise = null;
    let baselineResolutionPromise = null;
    let classificationDeferred = true;
    let readRecordExists = false;
    let returningFromEmptyBaseline = false;
    let emptyCursorCatchUpId = null;
    let sessionGeneration = 0;
    let awaitingSocketStatus = false;
    let socketStatusFallbackTimer = null;
    let socketStatusFallbackAttempt = 0;
    let historyRetryTimer = null;
    let historyRetryAttempt = 0;
    let everConnected = false;
    let reconnectPending = false;
    let reconnectFrozenCursor = null;
    let adminSettingsLoaded = false;
    let adminRequestPending = false;
    let adminReloadRequested = false;
    let adminHealthLoading = false;
    let pendingSendAttempt = null;
    let sessionClockTimer = null;
    let historyNotice = '';
    let sendNotice = '';
    let sendNoticeIsError = false;
    let focusTrapRecords = [];
    let focusComposerPending = false;
    let mobileQuery = null;
    let messageRenderGeneration = 0;

    function hasOwn(value, key) {
        return Boolean(value) && Object.prototype.hasOwnProperty.call(value, key);
    }

    function toPositiveInteger(value) {
        const number = Number(value);
        return Number.isSafeInteger(number) && number > 0 ? number : null;
    }

    function maxId(a, b) {
        const left = toPositiveInteger(a);
        const right = toPositiveInteger(b);
        if (left === null) {
            return right;
        }
        if (right === null) {
            return left;
        }
        return Math.max(left, right);
    }

    function safeStorageGet(key) {
        if (!key) {
            return null;
        }
        try {
            return global.localStorage.getItem(key);
        } catch (error) {
            console.warn('Server chat preferences are unavailable in this browser.');
            return null;
        }
    }

    function safeStorageSet(key, value) {
        if (!key) {
            return;
        }
        try {
            global.localStorage.setItem(key, value);
        } catch (error) {
            console.warn('Server chat preferences could not be saved.');
        }
    }

    function storageIdentity() {
        return currentUser && toPositiveInteger(currentUser.id) !== null
            ? String(currentUser.id)
            : null;
    }

    function filterStorageKey() {
        const identity = storageIdentity();
        return identity ? `server-chat:filters:v${STORAGE_VERSION}:${identity}:${SERVER_ID}` : null;
    }

    function readStorageKey(sessionKey = state.sessionKey) {
        const identity = storageIdentity();
        return identity && sessionKey
            ? `server-chat:unread:v${STORAGE_VERSION}:${identity}:${SERVER_ID}:${sessionKey}`
            : null;
    }

    function loadFilters() {
        const raw = safeStorageGet(filterStorageKey());
        if (!raw) {
            return;
        }
        try {
            const parsed = JSON.parse(raw);
            if (parsed && parsed.version === STORAGE_VERSION) {
                const chat = parsed.chat !== false;
                const activity = parsed.activity !== false;
                if (chat || activity) {
                    state.filters = { chat, activity };
                }
            }
        } catch (error) {
            // A malformed preference is ignored and replaced on the next change.
        }
    }

    function persistFilters() {
        safeStorageSet(filterStorageKey(), JSON.stringify({
            version: STORAGE_VERSION,
            chat: state.filters.chat,
            activity: state.filters.activity
        }));
    }

    function restoreReadState() {
        state.readThroughId = null;
        state.scanThroughId = null;
        state.unreadCount = 0;
        state.baselinePending = false;
        readRecordExists = false;
        returningFromEmptyBaseline = false;
        emptyCursorCatchUpId = null;
        if (!state.sessionKey) {
            return;
        }

        const raw = safeStorageGet(readStorageKey());
        if (!raw) {
            return;
        }
        try {
            const parsed = JSON.parse(raw);
            if (!parsed || parsed.version !== STORAGE_VERSION) {
                return;
            }
            state.readThroughId = toPositiveInteger(parsed.readThroughId);
            state.scanThroughId = toPositiveInteger(parsed.scanThroughId);
            state.unreadCount = Number.isSafeInteger(parsed.unreadCount) && parsed.unreadCount > 0
                ? parsed.unreadCount
                : 0;
            state.baselinePending = Boolean(parsed.baselinePending);
            readRecordExists = true;
            returningFromEmptyBaseline = !state.baselinePending && state.scanThroughId === null;
        } catch (error) {
            // A malformed record is treated as this session's first visit.
        }
    }

    function persistReadState() {
        if (!state.sessionKey) {
            return;
        }
        safeStorageSet(readStorageKey(), JSON.stringify({
            version: STORAGE_VERSION,
            readThroughId: state.readThroughId,
            scanThroughId: state.scanThroughId,
            unreadCount: state.unreadCount,
            baselinePending: state.baselinePending
        }));
    }

    function abortStateGets() {
        activeGetControllers.forEach((controller) => controller.abort());
        activeGetControllers.clear();
    }

    function setCapabilitiesUnknown({ preserveAdminRequest = false } = {}) {
        state.capabilitiesLoaded = false;
        state.canSend = false;
        state.sendBlockedReason = 'capabilities_unknown';
        state.sendingEnabled = null;
        adminSettingsLoaded = false;
        if (!preserveAdminRequest) {
            adminRequestPending = false;
        }
    }

    function beginEpoch(epoch) {
        abortStateGets();
        clearHistoryRetry();
        sessionGeneration += 1;
        state.stateEpoch = epoch;
        state.stateRevision = -1;
        setCapabilitiesUnknown();
        historyInitialized = false;
        classificationDeferred = true;
        emptyCursorCatchUpId = null;
        renderAllState();
        if (started) {
            global.setTimeout(scheduleInitialHistoryReload, 0);
        }
    }

    function sessionFromSnapshot(snapshot) {
        if (hasOwn(snapshot, 'session')) {
            if (!snapshot.session) {
                return null;
            }
            return {
                sessionKey: snapshot.session.sessionKey,
                startedAt: snapshot.session.startedAt || null,
                endedAt: snapshot.session.endedAt || null,
                endReason: snapshot.session.endReason || null,
                historyComplete: snapshot.session.historyComplete !== false,
                historyIncompleteReason: snapshot.session.historyIncompleteReason || null,
                historyBaselineReady: Boolean(snapshot.session.historyBaselineReady),
                historyBaselineId: toPositiveInteger(snapshot.session.historyBaselineId)
            };
        }
        if (!hasOwn(snapshot, 'sessionKey')) {
            return undefined;
        }
        if (!snapshot.sessionKey) {
            return null;
        }
        return {
            sessionKey: snapshot.sessionKey,
            startedAt: snapshot.sessionStartedAt || (state.session && state.session.startedAt) || null,
            endedAt: snapshot.sessionEndedAt || null,
            endReason: snapshot.sessionEndReason || null,
            historyComplete: snapshot.historyComplete !== false,
            historyIncompleteReason: snapshot.historyIncompleteReason || null,
            historyBaselineReady: Boolean(snapshot.historyBaselineReady),
            historyBaselineId: toPositiveInteger(snapshot.historyBaselineId)
        };
    }

    function switchSession(session) {
        abortStateGets();
        clearHistoryRetry();
        sessionGeneration += 1;
        state.session = session;
        state.sessionKey = session ? session.sessionKey : null;
        state.latestId = null;
        state.lastMergedId = null;
        state.messagesByKey.clear();
        state.orderedMessages = [];
        state.hasMoreBefore = false;
        deferredUnread.clear();
        historyInitialized = false;
        classificationDeferred = true;
        historyNotice = session ? 'Loading current session history…' : 'No current server session.';
        restoreReadState();
        if (!readRecordExists && session && !session.historyBaselineReady) {
            state.baselinePending = true;
            persistReadState();
        }
        renderMessages({ bulk: true });
        renderAllState();
    }

    function updateSession(session) {
        if (session === undefined) {
            return false;
        }
        const nextKey = session ? session.sessionKey : null;
        const changed = nextKey !== state.sessionKey;
        if (changed) {
            switchSession(session);
        } else {
            state.session = session;
        }
        return changed;
    }

    function applyStateSnapshot(snapshot, source = 'http') {
        if (!snapshot || typeof snapshot !== 'object') {
            return { stateAccepted: false, sessionChanged: false, epochChanged: false };
        }
        const epoch = typeof snapshot.stateEpoch === 'string' && snapshot.stateEpoch
            ? snapshot.stateEpoch
            : null;
        const revision = Number.isSafeInteger(snapshot.stateRevision)
            ? snapshot.stateRevision
            : null;
        let epochChanged = false;

        if (epoch && state.stateEpoch && epoch !== state.stateEpoch) {
            if (source === 'http' && state.connected) {
                return { stateAccepted: false, sessionChanged: false, epochChanged: false };
            }
            beginEpoch(epoch);
            epochChanged = true;
        } else if (epoch && !state.stateEpoch) {
            beginEpoch(epoch);
            epochChanged = true;
        }

        if (epoch && state.stateEpoch && epoch !== state.stateEpoch) {
            return { stateAccepted: false, sessionChanged: false, epochChanged: false };
        }
        if (revision !== null && revision < state.stateRevision) {
            return { stateAccepted: false, sessionChanged: false, epochChanged };
        }
        if (revision !== null) {
            state.stateRevision = revision;
        }

        if (hasOwn(snapshot, 'available')) {
            state.available = Boolean(snapshot.available);
        }
        if (typeof snapshot.serverState === 'string') {
            state.serverState = snapshot.serverState;
        }
        if (hasOwn(snapshot, 'ready')) {
            state.ready = Boolean(snapshot.ready);
        }
        if (hasOwn(snapshot, 'locked')) {
            state.locked = snapshot.locked === null ? null : Boolean(snapshot.locked);
        }
        if (hasOwn(snapshot, 'sendingEnabled')) {
            state.sendingEnabled = typeof snapshot.sendingEnabled === 'boolean'
                ? snapshot.sendingEnabled
                : null;
            if (state.sendingEnabled === false && !snapshot.permissions && !hasOwn(snapshot, 'sendBlockedReason')) {
                state.canSend = false;
                state.sendBlockedReason = 'sending_disabled';
            }
        }
        if (snapshot.health && typeof snapshot.health === 'object') {
            state.healthState = typeof snapshot.health.state === 'string'
                ? snapshot.health.state
                : state.healthState;
            state.healthReason = typeof snapshot.health.reason === 'string'
                ? snapshot.health.reason
                : null;
            if (!hasOwn(snapshot, 'available')) {
                state.available = state.healthState !== 'unavailable';
            }
        }
        if (snapshot.permissions && typeof snapshot.permissions === 'object') {
            state.canSend = Boolean(snapshot.permissions.canSend);
            state.sendBlockedReason = snapshot.permissions.sendBlockedReason || null;
            state.capabilitiesLoaded = true;
        } else if (hasOwn(snapshot, 'sendBlockedReason')) {
            state.sendBlockedReason = snapshot.sendBlockedReason || null;
            state.canSend = !state.sendBlockedReason
                && state.available
                && state.ready
                && state.locked !== true
                && state.sendingEnabled === true;
            state.capabilitiesLoaded = true;
        }
        if (snapshot.limits && typeof snapshot.limits === 'object') {
            const codePointLimit = toPositiveInteger(snapshot.limits.maxMessageCodePoints);
            const commandLimit = toPositiveInteger(snapshot.limits.maxCommandBytes);
            state.limits.maxMessageCodePoints = codePointLimit || 256;
            state.limits.maxCommandBytes = commandLimit;
            state.limits.commandFormatVersion = typeof snapshot.limits.commandFormatVersion === 'string'
                ? snapshot.limits.commandFormatVersion
                : null;
        }

        const sessionChanged = updateSession(sessionFromSnapshot(snapshot));
        renderAllState();
        return { stateAccepted: true, sessionChanged, epochChanged };
    }

    function messageCategory(message) {
        return message && message.kind === 'chat' ? 'chat' : 'activity';
    }

    function normalizeTimestampConfidence(value) {
        return ['exact', 'inferred', 'ingest_fallback'].includes(value) ? value : 'exact';
    }

    function normalizeMessageDto(value) {
        if (!value || typeof value !== 'object') {
            return null;
        }
        const id = toPositiveInteger(value.id);
        if (id === null || typeof value.sessionKey !== 'string' || value.sessionKey !== state.sessionKey) {
            return null;
        }
        if (!MESSAGE_KINDS.has(value.kind) || !['minecraft', 'panel'].includes(value.origin)) {
            return null;
        }
        return {
            id,
            sessionKey: value.sessionKey,
            origin: value.origin,
            kind: value.kind,
            actorName: typeof value.actorName === 'string' ? value.actorName : '',
            panelUserId: toPositiveInteger(value.panelUserId),
            panelUsername: typeof value.panelUsername === 'string' ? value.panelUsername : null,
            message: typeof value.message === 'string' ? value.message : '',
            occurredAt: typeof value.occurredAt === 'string' ? value.occurredAt : null,
            timestampConfidence: normalizeTimestampConfidence(value.timestampConfidence)
        };
    }

    function upsertChatMessage(value, { unread = 'auto' } = {}) {
        const message = normalizeMessageDto(value);
        if (!message) {
            return false;
        }
        const key = `${message.sessionKey}:${message.id}`;
        const existing = state.messagesByKey.get(key);
        if (existing) {
            return false;
        }
        state.messagesByKey.set(key, message);
        state.orderedMessages.push(message);
        state.orderedMessages.sort((left, right) => left.id - right.id);
        state.lastMergedId = maxId(state.lastMergedId, message.id);

        if (unread === 'defer' || (unread === 'auto' && classificationDeferred)) {
            deferredUnread.set(message.id, message);
        } else if (unread === 'auto') {
            classifyUnread(message);
        }
        return true;
    }

    function canMarkReadNow() {
        return state.open && !document.hidden && state.nearBottom;
    }

    function classifyUnread(message) {
        if (!message || (state.scanThroughId !== null && message.id <= state.scanThroughId)) {
            return;
        }
        state.scanThroughId = message.id;
        const enabled = Boolean(state.filters[messageCategory(message)]);
        if (canMarkReadNow()) {
            state.readThroughId = message.id;
            state.unreadCount = 0;
        } else if (enabled) {
            state.unreadCount += 1;
        }
        persistReadState();
        renderUnread();
    }

    function flushDeferredUnread({ baselineId = null } = {}) {
        const baseline = toPositiveInteger(baselineId);
        if (baseline !== null) {
            state.scanThroughId = maxId(state.scanThroughId, baseline);
            state.readThroughId = maxId(state.readThroughId, baseline);
            state.unreadCount = 0;
        }
        const queued = Array.from(deferredUnread.values()).sort((left, right) => left.id - right.id);
        deferredUnread.clear();
        classificationDeferred = false;
        queued.forEach(classifyUnread);
        persistReadState();
        renderUnread();
    }

    function markReadThroughLatest() {
        if (!canMarkReadNow()) {
            return;
        }
        state.readThroughId = maxId(state.readThroughId, state.scanThroughId);
        state.unreadCount = 0;
        persistReadState();
        renderUnread();
    }

    function badgeLabel() {
        return state.unreadCount > UNREAD_BADGE_CAP ? `${UNREAD_BADGE_CAP}+` : String(state.unreadCount);
    }

    function textNode(tagName, className, text) {
        const node = document.createElement(tagName);
        if (className) {
            node.className = className;
        }
        node.textContent = text;
        return node;
    }

    function localDayKey(date) {
        return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
    }

    function localCalendarDayNumber(date) {
        return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86400000);
    }

    function localCalendarDayDifference(later, earlier) {
        return localCalendarDayNumber(later) - localCalendarDayNumber(earlier);
    }

    function dayLabel(date) {
        const today = new Date();
        const dayDifference = localCalendarDayDifference(today, date);
        if (dayDifference === 0) {
            return 'Today';
        }
        if (dayDifference === 1) {
            return 'Yesterday';
        }
        return new Intl.DateTimeFormat(undefined, {
            weekday: 'short',
            month: 'short',
            day: 'numeric',
            year: date.getFullYear() === today.getFullYear() ? undefined : 'numeric'
        }).format(date);
    }

    function messageDate(message) {
        const value = message.occurredAt ? new Date(message.occurredAt) : new Date(NaN);
        return Number.isNaN(value.getTime()) ? new Date(0) : value;
    }

    function activitySentence(message) {
        const actor = message.actorName || 'A player';
        const body = message.message || '';
        if (!body) {
            return actor;
        }
        const normalizedActor = actor.toLocaleLowerCase();
        return body.toLocaleLowerCase().startsWith(normalizedActor)
            ? body
            : `${actor} ${body}`;
    }

    function createMessageRow(message) {
        const row = document.createElement('article');
        row.className = `server-chat-message server-chat-message-${message.kind} server-chat-origin-${message.origin}`;
        row.dataset.messageId = String(message.id);

        const date = messageDate(message);
        const time = textNode('time', 'server-chat-message-time', new Intl.DateTimeFormat(undefined, {
            hour: 'numeric',
            minute: '2-digit'
        }).format(date));
        if (message.occurredAt) {
            time.dateTime = message.occurredAt;
            time.title = new Intl.DateTimeFormat(undefined, {
                dateStyle: 'full',
                timeStyle: 'long'
            }).format(date);
        }
        if (message.timestampConfidence === 'inferred') {
            time.title = `${time.title || time.textContent} (time inferred from archived log)`;
        } else if (message.timestampConfidence === 'ingest_fallback') {
            time.title = `${time.title || time.textContent} (time estimated from log ingestion)`;
        }

        const content = document.createElement('div');
        content.className = 'server-chat-message-content';
        if (message.kind === 'chat') {
            const actor = textNode('span', 'server-chat-message-actor', message.actorName || message.panelUsername || 'Unknown');
            content.appendChild(actor);
            if (message.origin === 'panel') {
                content.appendChild(textNode('span', 'server-chat-panel-badge', 'Panel'));
            }
            content.appendChild(textNode('span', 'server-chat-message-colon', ':'));
            content.appendChild(textNode('span', 'server-chat-message-body', message.message));
        } else {
            content.appendChild(textNode('span', 'server-chat-activity-body', activitySentence(message)));
        }
        row.append(content, time);
        return row;
    }

    function visibleMessages() {
        return state.orderedMessages.filter((message) => state.filters[messageCategory(message)]);
    }

    function appendLiveMessage(value, { stickToBottom = false } = {}) {
        if (!dom.messages) {
            return;
        }
        const id = toPositiveInteger(value && value.id);
        const message = id === null || !state.sessionKey
            ? null
            : state.messagesByKey.get(`${state.sessionKey}:${id}`);
        if (!message || !state.filters[messageCategory(message)]) {
            return;
        }

        const messages = visibleMessages();
        const isNewestVisible = messages.length > 0 && messages[messages.length - 1].id === message.id;
        const renderedCount = dom.messages.querySelectorAll('.server-chat-message').length;
        if (!isNewestVisible || renderedCount !== messages.length - 1) {
            renderMessages({ bulk: true, stickToBottom });
            return;
        }

        messageRenderGeneration += 1;
        dom.messages.removeAttribute('aria-busy');
        dom.messages.setAttribute('aria-live', MESSAGE_LOG_LIVE_MODE);
        if (messages.length === 1) {
            dom.messages.replaceChildren();
        }
        const previous = messages.length > 1 ? messages[messages.length - 2] : null;
        const currentDay = localDayKey(messageDate(message));
        const previousDay = previous ? localDayKey(messageDate(previous)) : null;
        if (currentDay !== previousDay) {
            const separator = textNode('div', 'server-chat-day-separator', dayLabel(messageDate(message)));
            separator.setAttribute('role', 'separator');
            dom.messages.appendChild(separator);
        }
        dom.messages.appendChild(createMessageRow(message));
        if (stickToBottom || (state.open && state.nearBottom)) {
            dom.messages.scrollTop = dom.messages.scrollHeight;
        }
        updateNearBottom();
    }

    function renderMessages({ preserveScroll = false, bulk = false, stickToBottom = false } = {}) {
        if (!dom.messages) {
            return;
        }
        const priorHeight = dom.messages.scrollHeight;
        const priorTop = dom.messages.scrollTop;
        const renderGeneration = ++messageRenderGeneration;
        if (bulk) {
            dom.messages.setAttribute('aria-live', 'off');
            dom.messages.setAttribute('aria-busy', 'true');
        } else {
            dom.messages.removeAttribute('aria-busy');
            dom.messages.setAttribute('aria-live', MESSAGE_LOG_LIVE_MODE);
        }

        const fragment = document.createDocumentFragment();
        const messages = visibleMessages();
        let priorDay = null;
        messages.forEach((message) => {
            const date = messageDate(message);
            const key = localDayKey(date);
            if (key !== priorDay) {
                const separator = textNode('div', 'server-chat-day-separator', dayLabel(date));
                separator.setAttribute('role', 'separator');
                fragment.appendChild(separator);
                priorDay = key;
            }
            fragment.appendChild(createMessageRow(message));
        });
        if (!messages.length) {
            fragment.appendChild(textNode('div', 'server-chat-empty', state.sessionKey
                ? 'No messages match the current filters.'
                : 'Start the Minecraft server to begin a chat session.'));
        }
        dom.messages.replaceChildren(fragment);

        if (preserveScroll) {
            dom.messages.scrollTop = priorTop + (dom.messages.scrollHeight - priorHeight);
        } else if (stickToBottom || (state.open && state.nearBottom)) {
            dom.messages.scrollTop = dom.messages.scrollHeight;
        }
        updateNearBottom();

        if (bulk) {
            global.requestAnimationFrame(() => {
                if (renderGeneration !== messageRenderGeneration) {
                    return;
                }
                dom.messages.removeAttribute('aria-busy');
                dom.messages.setAttribute('aria-live', MESSAGE_LOG_LIVE_MODE);
            });
        }
    }

    function updateNearBottom() {
        if (!dom.messages) {
            return;
        }
        const distance = dom.messages.scrollHeight - dom.messages.scrollTop - dom.messages.clientHeight;
        state.nearBottom = distance <= NEAR_BOTTOM_PX;
        if (canMarkReadNow()) {
            markReadThroughLatest();
        } else {
            renderUnread();
        }
    }

    function renderUnread() {
        if (!dom.unreadBadge || !dom.newMessages) {
            return;
        }
        const count = state.unreadCount;
        const label = badgeLabel();
        dom.unreadBadge.textContent = label;
        dom.unreadBadge.setAttribute('aria-label', `${label} unread ${count === 1 ? 'message' : 'messages'}`);
        dom.unreadBadge.classList.toggle('hidden', state.open || count === 0);

        dom.newMessages.textContent = `${label} new ${count === 1 ? 'message' : 'messages'}`;
        dom.newMessages.classList.toggle('hidden', !state.open || state.nearBottom || count === 0);
    }

    function humanBlockedReason(reason) {
        const labels = {
            capabilities_unknown: 'Loading permissions',
            server_not_ready: 'Server offline',
            catching_up: 'History is catching up',
            settings_change_pending: 'Sending setting is changing',
            sending_disabled: 'Panel chat is read only',
            maintenance: 'Maintenance in progress',
            update: 'Server update in progress',
            service_unavailable: 'Chat service unavailable'
        };
        return labels[reason] || 'Sending unavailable';
    }

    function renderConnectionStatus() {
        if (!dom.connectionStatus) {
            return;
        }
        let label = 'Connecting';
        let tone = 'connecting';
        if (!state.connected) {
            label = everConnected ? 'Disconnected' : 'Connecting';
            tone = everConnected ? 'disconnected' : 'connecting';
        } else if (awaitingSocketStatus || !state.capabilitiesLoaded) {
            label = 'Connecting';
            tone = 'connecting';
        } else if (!state.available || state.healthState === 'unavailable') {
            label = 'Chat unavailable';
            tone = 'unavailable';
        } else if (state.healthState === 'catching_up' || state.baselinePending) {
            label = 'Catching up';
            tone = 'catching-up';
        } else if (state.session && state.session.historyComplete === false) {
            label = 'History incomplete';
            tone = 'degraded';
        } else if (!state.canSend) {
            label = humanBlockedReason(state.sendBlockedReason);
            tone = state.sendBlockedReason === 'sending_disabled' ? 'read-only' : 'degraded';
        } else if (state.healthState === 'degraded') {
            label = 'Live · History degraded';
            tone = 'degraded';
        } else {
            label = 'Live';
            tone = 'live';
        }
        dom.connectionStatus.textContent = label;
        dom.connectionStatus.dataset.state = tone;
        if (dom.panel) {
            dom.panel.dataset.health = tone;
        }
    }

    function durationLabel(milliseconds) {
        const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
        const days = Math.floor(totalSeconds / 86400);
        const hours = Math.floor((totalSeconds % 86400) / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        if (days) {
            return `${days}d ${hours}h`;
        }
        if (hours) {
            return `${hours}h ${minutes}m`;
        }
        return `${minutes}m`;
    }

    function sessionEndLabel(reason) {
        const labels = {
            stopped: 'stopped',
            crashed: 'crashed',
            crashed_or_external_stop: 'crashed or stopped externally',
            restart: 'restarted',
            update: 'stopped for update',
            updated: 'stopped for update',
            backup: 'stopped for backup',
            backup_restart: 'restarted after backup',
            panel_restart: 'panel restarted',
            unknown: 'ended'
        };
        return labels[reason] || 'ended';
    }

    function renderSessionMeta() {
        if (!dom.sessionMeta) {
            return;
        }
        if (!state.session || !state.session.startedAt) {
            dom.sessionMeta.textContent = 'No active session';
            return;
        }
        const start = new Date(state.session.startedAt);
        if (Number.isNaN(start.getTime())) {
            dom.sessionMeta.textContent = 'Current server session';
            return;
        }
        const startLabel = new Intl.DateTimeFormat(undefined, {
            month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
        }).format(start);
        const end = state.session.endedAt ? new Date(state.session.endedAt) : null;
        if (end && !Number.isNaN(end.getTime())) {
            const endLabel = new Intl.DateTimeFormat(undefined, {
                month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
            }).format(end);
            dom.sessionMeta.textContent = `${startLabel}–${endLabel} · ${sessionEndLabel(state.session.endReason)}`;
        } else {
            dom.sessionMeta.textContent = `${startLabel} · live for ${durationLabel(Date.now() - start.getTime())}`;
        }
    }

    function syncSessionClock() {
        if (sessionClockTimer) {
            global.clearInterval(sessionClockTimer);
            sessionClockTimer = null;
        }
        if (state.open && state.session && !state.session.endedAt) {
            sessionClockTimer = global.setInterval(renderSessionMeta, 30000);
        }
    }

    function renderHistoryStatus() {
        if (!dom.historyStatus) {
            return;
        }
        let label = historyNotice;
        if (!label && state.baselinePending) {
            label = 'Recovering earlier server history…';
        } else if (!label && state.session && state.session.historyComplete === false) {
            label = 'Some earlier history could not be recovered.';
        } else if (!label && state.hasMoreBefore) {
            label = 'Scroll up to load earlier messages.';
        }
        dom.historyStatus.textContent = label || '';
        dom.historyStatus.classList.toggle('hidden', !label);
    }

    function renderAdminState() {
        if (!dom.adminControls || !dom.sendingEnabled) {
            return;
        }
        const isAdmin = Boolean(currentUser && currentUser.role === 'admin');
        dom.adminControls.classList.toggle('hidden', !isAdmin);
        if (!isAdmin) {
            return;
        }
        if (typeof state.sendingEnabled === 'boolean') {
            dom.sendingEnabled.checked = state.sendingEnabled;
        }
        dom.sendingEnabled.disabled = !adminSettingsLoaded
            || adminRequestPending
            || awaitingSocketStatus
            || !state.connected
            || !state.available;
    }

    function renderSendNotice() {
        if (!dom.sendStatus) {
            return;
        }
        dom.sendStatus.textContent = sendNotice;
        dom.sendStatus.classList.toggle('is-error', sendNoticeIsError);
        dom.sendStatus.classList.toggle('hidden', !sendNotice);
    }

    function normalizeChatText(value) {
        return String(value).normalize('NFC').trim();
    }

    function buildTellrawMeasurement(message, panelUsername = null) {
        const normalizedText = normalizeChatText(message);
        const username = panelUsername === null
            ? (currentUser && typeof currentUser.username === 'string' ? currentUser.username : '')
            : String(panelUsername);
        const component = [
            { text: '[Panel] ', color: 'dark_green', bold: true },
            { text: username, color: 'green' },
            { text: ': ', color: 'gray' },
            { text: normalizedText, color: 'white' }
        ];
        const command = `tellraw @a ${JSON.stringify(component)}`;
        const screenPayload = `${command}\r`;
        return {
            normalizedText,
            codePoints: Array.from(normalizedText).length,
            command,
            screenPayload,
            bytes: new TextEncoder().encode(screenPayload).byteLength
        };
    }

    function validateDraft() {
        const measurement = buildTellrawMeasurement(dom.input ? dom.input.value : '');
        const characterLimit = state.limits.maxMessageCodePoints || 256;
        const byteLimit = state.limits.maxCommandBytes;
        let error = null;
        if (!measurement.codePoints) {
            error = 'Enter a message.';
        } else if (measurement.codePoints > characterLimit) {
            error = `Message exceeds ${characterLimit} characters.`;
        } else if (/[\u0000-\u001f\u007f-\u009f]/u.test(measurement.normalizedText)
            || /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(measurement.normalizedText)) {
            error = 'Message contains unsupported control characters.';
        } else if (measurement.normalizedText.startsWith('/')) {
            error = 'Panel chat cannot send commands.';
        } else if (state.limits.commandFormatVersion === 'tellraw-v1'
            && byteLimit !== null
            && measurement.bytes > byteLimit) {
            error = `Command exceeds the ${byteLimit}-byte transport limit.`;
        }
        return { ...measurement, characterLimit, byteLimit, error };
    }

    function renderMeter() {
        if (!dom.inputMeter || !dom.sendButton) {
            return;
        }
        const draft = validateDraft();
        let label = `${draft.codePoints} / ${draft.characterLimit} characters`;
        if (state.limits.commandFormatVersion === 'tellraw-v1' && draft.byteLimit !== null) {
            label += ` · ${draft.bytes} / ${draft.byteLimit} command bytes`;
        }
        dom.inputMeter.textContent = label;
        const characterRatio = draft.characterLimit ? draft.codePoints / draft.characterLimit : 0;
        const byteRatio = state.limits.commandFormatVersion === 'tellraw-v1' && draft.byteLimit
            ? draft.bytes / draft.byteLimit
            : 0;
        dom.inputMeter.classList.toggle('is-warning', !draft.error && Math.max(characterRatio, byteRatio) >= 0.85);
        dom.inputMeter.classList.toggle('is-error', Boolean(draft.error) && draft.codePoints > 0);

        const composerEnabled = state.connected
            && !awaitingSocketStatus
            && state.capabilitiesLoaded
            && state.canSend
            && state.available
            && !state.sending;
        if (dom.input) {
            dom.input.disabled = !composerEnabled;
        }
        dom.sendButton.disabled = !composerEnabled || Boolean(draft.error);
        if (composerEnabled && state.open && focusComposerPending) {
            focusComposerPending = false;
            global.requestAnimationFrame(() => {
                if (state.open && !dom.input.disabled) {
                    dom.input.focus();
                }
            });
        }
    }

    function renderFilters() {
        if (!dom.filters) {
            return;
        }
        dom.filters.querySelectorAll('[data-chat-filter]').forEach((button) => {
            const filter = button.dataset.chatFilter;
            button.setAttribute('aria-pressed', state.filters[filter] ? 'true' : 'false');
        });
    }

    function renderAllState() {
        renderConnectionStatus();
        renderSessionMeta();
        renderHistoryStatus();
        renderAdminState();
        renderFilters();
        renderUnread();
        renderSendNotice();
        renderMeter();
        syncSessionClock();
    }

    function authHeaders(includeJson = false) {
        const headers = {};
        const token = safeStorageGet('token');
        if (token) {
            headers.Authorization = `Bearer ${token}`;
        }
        if (includeJson) {
            headers['Content-Type'] = 'application/json';
        }
        return headers;
    }

    async function requestJson(path, { method = 'GET', body = null, signal = null } = {}) {
        const response = await fetch(path, {
            method,
            headers: authHeaders(body !== null),
            body: body === null ? undefined : JSON.stringify(body),
            signal,
            cache: 'no-store',
            credentials: 'same-origin'
        });
        const payload = await response.json().catch(() => null);
        if ((response.status === 401 || response.status === 428)
            && payload
            && payload.error
            && ['AUTH_REQUIRED', 'AUTH_INVALID', 'PASSWORD_RESET_REQUIRED'].includes(payload.error.code)) {
            safeStorageSet('token', '');
            global.location.href = response.status === 428 ? '/set-password.html' : '/';
        }
        return { response, payload };
    }

    async function controlledGet(path) {
        const controller = new AbortController();
        const generation = sessionGeneration;
        activeGetControllers.add(controller);
        try {
            const result = await requestJson(path, { signal: controller.signal });
            if (generation !== sessionGeneration) {
                return null;
            }
            return { ...result, generation };
        } catch (error) {
            if (error.name === 'AbortError') {
                return null;
            }
            throw error;
        } finally {
            activeGetControllers.delete(controller);
        }
    }

    function historyUrl(parameters = {}) {
        const query = new URLSearchParams();
        query.set('limit', String(parameters.limit || HISTORY_PAGE_SIZE));
        if (parameters.beforeId) {
            query.set('beforeId', String(parameters.beforeId));
        }
        if (parameters.afterId) {
            query.set('afterId', String(parameters.afterId));
        }
        return `/chat/messages?${query.toString()}`;
    }

    function responseBelongsToCurrentSession(payload) {
        if (!payload || !payload.session || typeof payload.session.sessionKey !== 'string') {
            return !state.sessionKey && payload && payload.session === null;
        }
        return payload.session.sessionKey === state.sessionKey;
    }

    async function getHistoryPage(parameters = {}, unreadMode = 'defer') {
        let result;
        try {
            result = await controlledGet(historyUrl(parameters));
        } catch (error) {
            historyNotice = 'Could not reach server chat. Cached messages remain available.';
            renderAllState();
            return null;
        }
        if (!result) {
            return null;
        }
        const { response, payload } = result;
        if (payload) {
            applyStateSnapshot(payload, 'http');
        }
        if (!response.ok) {
            historyNotice = payload && payload.error && payload.error.message
                ? payload.error.message
                : 'Server chat is temporarily unavailable.';
            renderAllState();
            return null;
        }
        if (!payload || !Array.isArray(payload.messages) || !responseBelongsToCurrentSession(payload)) {
            return null;
        }
        payload.messages.forEach((message) => upsertChatMessage(message, { unread: unreadMode }));
        if (payload.pagination) {
            state.latestId = maxId(state.latestId, payload.pagination.latestId);
        }
        return payload;
    }

    function yieldToBrowser() {
        return new Promise((resolve) => global.requestAnimationFrame(() => resolve()));
    }

    function clearHistoryRetry({ resetAttempt = true } = {}) {
        if (historyRetryTimer) {
            global.clearTimeout(historyRetryTimer);
            historyRetryTimer = null;
        }
        if (resetAttempt) {
            historyRetryAttempt = 0;
        }
    }

    function historyRetryDelay() {
        const base = Math.min(
            HISTORY_RETRY_INITIAL_MS * (2 ** historyRetryAttempt),
            HISTORY_RETRY_MAX_MS
        );
        historyRetryAttempt = Math.min(historyRetryAttempt + 1, 5);
        return Math.min(HISTORY_RETRY_MAX_MS, Math.round(base * (0.8 + Math.random() * 0.4)));
    }

    function historyStillNeedsSynchronization() {
        return started && (
            !historyInitialized
            || classificationDeferred
            || state.baselinePending
            || returningFromEmptyBaseline
        );
    }

    function scheduleHistoryRetry() {
        if (!started || historyRetryTimer) {
            return;
        }
        const delay = historyRetryDelay();
        historyRetryTimer = global.setTimeout(async () => {
            historyRetryTimer = null;
            try {
                if (!historyInitialized) {
                    await loadInitialHistory();
                } else if (state.baselinePending) {
                    await resolveReadyBaseline();
                } else if (returningFromEmptyBaseline) {
                    await synchronizeEmptyCursorHistory();
                } else {
                    await synchronizeAfterReconnect();
                }
            } catch (error) {
                historyNotice = 'Could not synchronize server chat. Retrying…';
                renderAllState();
            }
            if (historyStillNeedsSynchronization()) {
                scheduleHistoryRetry();
            } else {
                clearHistoryRetry();
            }
        }, delay);
    }

    async function synchronizeEmptyCursorHistory() {
        if (!returningFromEmptyBaseline || !state.sessionKey) {
            return true;
        }
        classificationDeferred = true;
        historyNotice = 'Restoring messages received while away…';
        renderAllState();
        const generation = sessionGeneration;
        const sessionKey = state.sessionKey;
        const forwardCursor = emptyCursorCatchUpId;

        while (state.hasMoreBefore) {
            const beforeId = state.orderedMessages.length ? state.orderedMessages[0].id : null;
            if (beforeId === null) {
                historyNotice = 'History synchronization paused because the server returned an invalid cursor.';
                scheduleHistoryRetry();
                return false;
            }
            const payload = await getHistoryPage({ beforeId, limit: CATCH_UP_PAGE_SIZE }, 'defer');
            if (!payload || generation !== sessionGeneration || sessionKey !== state.sessionKey) {
                scheduleHistoryRetry();
                return false;
            }
            const ids = payload.messages.map((message) => toPositiveInteger(message.id)).filter(Boolean);
            const nextBeforeId = ids.length ? Math.min(...ids) : beforeId;
            state.hasMoreBefore = Boolean(payload.pagination && payload.pagination.hasMoreBefore);
            if (state.hasMoreBefore && nextBeforeId === beforeId) {
                historyNotice = 'History synchronization paused because the server returned an invalid cursor.';
                scheduleHistoryRetry();
                return false;
            }
            if (state.hasMoreBefore) {
                await yieldToBrowser();
            }
        }

        if (forwardCursor !== null) {
            const caughtUp = await catchUpPages(forwardCursor);
            if (!caughtUp || generation !== sessionGeneration || sessionKey !== state.sessionKey) {
                scheduleHistoryRetry();
                return false;
            }
        }

        returningFromEmptyBaseline = false;
        emptyCursorCatchUpId = null;
        flushDeferredUnread();
        historyNotice = '';
        clearHistoryRetry();
        return true;
    }

    async function catchUpPages(startCursor) {
        let cursor = toPositiveInteger(startCursor);
        if (cursor === null) {
            return true;
        }
        classificationDeferred = true;
        let hasMore = true;
        while (hasMore) {
            const generation = sessionGeneration;
            const payload = await getHistoryPage({ afterId: cursor, limit: CATCH_UP_PAGE_SIZE }, 'defer');
            if (!payload || generation !== sessionGeneration) {
                scheduleHistoryRetry();
                return false;
            }
            const ids = payload.messages.map((message) => toPositiveInteger(message.id)).filter(Boolean);
            const nextCursor = ids.length ? Math.max(...ids) : cursor;
            hasMore = Boolean(payload.pagination && payload.pagination.hasMoreAfter);
            if (hasMore && nextCursor === cursor) {
                historyNotice = 'History synchronization paused because the server returned an invalid cursor.';
                scheduleHistoryRetry();
                return false;
            }
            cursor = nextCursor;
            if (hasMore) {
                await yieldToBrowser();
            }
        }
        return true;
    }

    async function establishBaselineAndCatchUp(baselineId) {
        const generation = sessionGeneration;
        const sessionKey = state.sessionKey;
        const baseline = toPositiveInteger(baselineId);
        state.baselinePending = false;
        state.scanThroughId = baseline;
        state.readThroughId = baseline;
        state.unreadCount = 0;
        persistReadState();
        let synchronized = true;
        if (baseline !== null) {
            synchronized = await catchUpPages(baseline);
        } else {
            // afterId is positive-only. A second snapshot closes the empty-session
            // race between the first GET and the authenticated socket becoming live.
            const payload = await getHistoryPage({ limit: CATCH_UP_PAGE_SIZE }, 'defer');
            synchronized = Boolean(payload);
            if (payload) {
                state.hasMoreBefore = Boolean(payload.pagination && payload.pagination.hasMoreBefore);
                emptyCursorCatchUpId = toPositiveInteger(payload.pagination && payload.pagination.latestId);
                returningFromEmptyBaseline = true;
                synchronized = await synchronizeEmptyCursorHistory();
            }
        }
        if (synchronized && generation === sessionGeneration && sessionKey === state.sessionKey) {
            flushDeferredUnread();
            clearHistoryRetry();
        } else {
            scheduleHistoryRetry();
        }
        return synchronized;
    }

    async function loadInitialHistory() {
        if (historyLoadPromise) {
            return historyLoadPromise;
        }
        historyLoadPromise = (async () => {
            state.loading = true;
            classificationDeferred = true;
            historyNotice = 'Loading current session history…';
            renderAllState();
            const payload = await getHistoryPage({ limit: HISTORY_PAGE_SIZE }, 'defer');
            if (!payload) {
                state.loading = false;
                scheduleHistoryRetry();
                renderAllState();
                return;
            }
            historyInitialized = true;
            state.hasMoreBefore = Boolean(payload.pagination && payload.pagination.hasMoreBefore);

            if (!state.sessionKey) {
                classificationDeferred = false;
                deferredUnread.clear();
            } else if (!readRecordExists) {
                if (state.session && state.session.historyBaselineReady) {
                    const baselineId = toPositiveInteger(payload.pagination && payload.pagination.latestId)
                        || state.session.historyBaselineId;
                    readRecordExists = true;
                    await establishBaselineAndCatchUp(baselineId);
                } else {
                    state.baselinePending = true;
                    readRecordExists = true;
                    persistReadState();
                    scheduleHistoryRetry();
                }
            } else if (state.baselinePending) {
                if (state.session && state.session.historyBaselineReady) {
                    await establishBaselineAndCatchUp(state.session.historyBaselineId || state.latestId);
                } else {
                    scheduleHistoryRetry();
                }
            } else if (state.scanThroughId !== null) {
                const synchronized = await catchUpPages(state.scanThroughId);
                if (synchronized && !state.baselinePending) {
                    flushDeferredUnread();
                    clearHistoryRetry();
                } else {
                    scheduleHistoryRetry();
                }
            } else {
                returningFromEmptyBaseline = true;
                emptyCursorCatchUpId = toPositiveInteger(payload.pagination && payload.pagination.latestId);
                await synchronizeEmptyCursorHistory();
            }

            state.loading = false;
            if (!classificationDeferred || state.baselinePending) {
                historyNotice = '';
            }
            if (!historyStillNeedsSynchronization()) {
                clearHistoryRetry();
            }
            renderMessages({ bulk: true, stickToBottom: state.open });
            renderAllState();
        })().finally(() => {
            historyLoadPromise = null;
        });
        return historyLoadPromise;
    }

    function scheduleInitialHistoryReload() {
        const targetSessionKey = state.sessionKey;
        const waitFor = historyLoadPromise || Promise.resolve();
        waitFor.finally(() => {
            if (state.sessionKey === targetSessionKey && !historyInitialized) {
                global.setTimeout(() => loadInitialHistory(), 0);
            }
        });
    }

    async function synchronizeAfterReconnect() {
        if (!started) {
            return null;
        }
        if (catchUpPromise) {
            reconnectPending = true;
            return catchUpPromise;
        }
        catchUpPromise = (async () => {
            if (historyLoadPromise) {
                await historyLoadPromise;
            }
            if (!state.sessionKey || !historyInitialized) {
                await loadInitialHistory();
                return;
            }
            if (state.baselinePending) {
                if (state.session && state.session.historyBaselineReady) {
                    await resolveReadyBaseline();
                } else {
                    scheduleHistoryRetry();
                }
                return;
            }
            if (returningFromEmptyBaseline) {
                await synchronizeEmptyCursorHistory();
                renderMessages({ bulk: true, stickToBottom: state.nearBottom });
                renderAllState();
                return;
            }
            const frozenCursor = reconnectFrozenCursor || state.scanThroughId || state.lastMergedId;
            reconnectFrozenCursor = null;
            if (frozenCursor === null) {
                returningFromEmptyBaseline = true;
                await loadInitialHistory();
                return;
            }
            historyNotice = 'Catching up…';
            classificationDeferred = true;
            renderAllState();
            const synchronized = await catchUpPages(frozenCursor);
            if (synchronized && !state.baselinePending) {
                flushDeferredUnread();
                clearHistoryRetry();
            } else {
                scheduleHistoryRetry();
            }
            if (synchronized) {
                historyNotice = '';
            }
            renderMessages({ bulk: true, stickToBottom: state.nearBottom });
            renderAllState();
        })().finally(() => {
            catchUpPromise = null;
            if (reconnectPending) {
                reconnectPending = false;
                global.setTimeout(() => synchronizeAfterReconnect(), 0);
            }
        });
        return catchUpPromise;
    }

    async function resolveReadyBaseline() {
        if (baselineResolutionPromise || !state.baselinePending || !state.sessionKey) {
            return baselineResolutionPromise;
        }
        baselineResolutionPromise = (async () => {
            classificationDeferred = true;
            historyNotice = 'Finishing history recovery…';
            renderAllState();
            const payload = await getHistoryPage({ limit: HISTORY_PAGE_SIZE }, 'defer');
            if (!payload || !state.session || !state.session.historyBaselineReady) {
                scheduleHistoryRetry();
                return;
            }
            const baselineId = state.session.historyBaselineId
                || toPositiveInteger(payload.pagination && payload.pagination.latestId);
            const synchronized = await establishBaselineAndCatchUp(baselineId);
            if (synchronized) {
                historyNotice = '';
                clearHistoryRetry();
            } else {
                scheduleHistoryRetry();
            }
            renderMessages({ bulk: true, stickToBottom: state.nearBottom });
            renderAllState();
        })().finally(() => {
            baselineResolutionPromise = null;
        });
        return baselineResolutionPromise;
    }

    async function loadOlderPage() {
        if (olderPagePromise || !state.hasMoreBefore || !state.sessionKey || !state.orderedMessages.length) {
            return olderPagePromise;
        }
        const beforeId = state.orderedMessages[0].id;
        olderPagePromise = (async () => {
            historyNotice = 'Loading earlier messages…';
            renderAllState();
            const payload = await getHistoryPage({ beforeId, limit: HISTORY_PAGE_SIZE }, 'skip');
            if (!payload) {
                return;
            }
            state.hasMoreBefore = Boolean(payload.pagination && payload.pagination.hasMoreBefore);
            historyNotice = '';
            renderMessages({ preserveScroll: true, bulk: true });
            renderAllState();
        })().finally(() => {
            olderPagePromise = null;
        });
        return olderPagePromise;
    }

    function makeClientMessageId() {
        if (global.crypto && typeof global.crypto.randomUUID === 'function') {
            return global.crypto.randomUUID();
        }
        if (!global.crypto || typeof global.crypto.getRandomValues !== 'function') {
            throw new Error('Secure message IDs are unavailable in this browser.');
        }
        const bytes = global.crypto.getRandomValues(new Uint8Array(16));
        bytes[6] = (bytes[6] & 0x0f) | 0x40;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }

    async function submitMessage(event) {
        event.preventDefault();
        if (state.sending) {
            return;
        }
        const draft = validateDraft();
        if (draft.error) {
            sendNotice = draft.error;
            sendNoticeIsError = true;
            renderAllState();
            return;
        }
        if (!state.connected || !state.capabilitiesLoaded || !state.canSend) {
            sendNotice = state.connected ? humanBlockedReason(state.sendBlockedReason) : 'Reconnect before sending.';
            sendNoticeIsError = true;
            renderAllState();
            return;
        }

        try {
            if (!pendingSendAttempt || pendingSendAttempt.normalizedText !== draft.normalizedText) {
                pendingSendAttempt = {
                    normalizedText: draft.normalizedText,
                    clientMessageId: makeClientMessageId()
                };
            }
        } catch (error) {
            sendNotice = error.message;
            sendNoticeIsError = true;
            renderAllState();
            return;
        }

        state.sending = true;
        sendNotice = 'Sending…';
        sendNoticeIsError = false;
        renderAllState();
        try {
            const result = await requestJson('/chat/messages', {
                method: 'POST',
                body: {
                    message: draft.normalizedText,
                    clientMessageId: pendingSendAttempt.clientMessageId
                }
            });
            if (!result.response.ok || !result.payload) {
                const code = result.payload && result.payload.error && result.payload.error.code;
                const message = result.payload && result.payload.error && result.payload.error.message;
                sendNotice = message || 'Message could not be sent.';
                sendNoticeIsError = true;
                if (code !== 'CHAT_DELIVERY_UNKNOWN') {
                    pendingSendAttempt = null;
                }
                if (['CHAT_SERVER_OFFLINE', 'CHAT_CATCHING_UP', 'CHAT_LOCKED', 'CHAT_READ_ONLY', 'CHAT_UNAVAILABLE'].includes(code)) {
                    global.setTimeout(() => loadInitialHistory(), 0);
                }
                return;
            }
            if (result.payload.message) {
                const wasNearBottom = state.nearBottom;
                const inserted = upsertChatMessage(result.payload.message, { unread: 'auto' });
                if (inserted) {
                    appendLiveMessage(result.payload.message, { stickToBottom: wasNearBottom });
                }
            }
            pendingSendAttempt = null;
            dom.input.value = '';
            sendNotice = result.payload.deduplicated
                ? 'Message was already accepted by the server console.'
                : 'Message accepted by the server console.';
            sendNoticeIsError = false;
        } catch (error) {
            sendNotice = 'Connection interrupted. Retry to safely check the same message.';
            sendNoticeIsError = true;
            // Retain the UUID: retrying with a new ID could duplicate an accepted command.
        } finally {
            state.sending = false;
            renderAllState();
        }
    }

    function formatDiagnosticValue(key, value) {
        if (value === null || value === undefined) {
            return '—';
        }
        if (key === 'lastError' && typeof value === 'object') {
            return value.code && value.at ? `${value.code} · ${value.at}` : '—';
        }
        if (key.endsWith('At') && typeof value === 'string') {
            const date = new Date(value);
            return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
        }
        return String(value);
    }

    function renderDiagnostics(payload) {
        if (!dom.diagnosticsValues) {
            return;
        }
        const fragment = document.createDocumentFragment();
        ADMIN_HEALTH_FIELDS.forEach(([key, label]) => {
            fragment.appendChild(textNode('dt', '', label));
            fragment.appendChild(textNode('dd', '', formatDiagnosticValue(key, payload ? payload[key] : null)));
        });
        dom.diagnosticsValues.replaceChildren(fragment);
    }

    async function loadAdminSettings() {
        if (!currentUser || currentUser.role !== 'admin' || adminRequestPending) {
            if (adminRequestPending) {
                adminReloadRequested = true;
            }
            return;
        }
        adminRequestPending = true;
        adminSettingsLoaded = false;
        renderAdminState();
        try {
            const result = await controlledGet('/admin/chat/settings');
            if (!result || !result.payload) {
                return;
            }
            if (!result.response.ok) {
                sendNotice = result.payload.error && result.payload.error.message
                    ? result.payload.error.message
                    : 'Chat sending settings are unavailable.';
                sendNoticeIsError = true;
                return;
            }
            const applied = applyStateSnapshot(result.payload, 'http');
            if (!applied.stateAccepted || typeof result.payload.sendingEnabled !== 'boolean') {
                return;
            }
            state.sendingEnabled = result.payload.sendingEnabled;
            adminSettingsLoaded = true;
        } catch (error) {
            sendNotice = 'Chat sending settings are unavailable.';
            sendNoticeIsError = true;
        } finally {
            adminRequestPending = false;
            renderAllState();
            if (adminReloadRequested) {
                adminReloadRequested = false;
                global.setTimeout(() => loadAdminSettings(), 0);
            }
        }
    }

    async function changeAdminSetting() {
        if (!adminSettingsLoaded || adminRequestPending || !dom.sendingEnabled) {
            renderAdminState();
            return;
        }
        const desired = Boolean(dom.sendingEnabled.checked);
        dom.sendingEnabled.checked = state.sendingEnabled === true;
        adminRequestPending = true;
        renderAdminState();
        try {
            const result = await requestJson('/admin/chat/settings', {
                method: 'PATCH',
                body: { sendingEnabled: desired }
            });
            if (!result.response.ok || !result.payload) {
                sendNotice = result.payload && result.payload.error && result.payload.error.message
                    ? result.payload.error.message
                    : 'Could not update the sending setting.';
                sendNoticeIsError = true;
                if (result.response.status === 503) {
                    adminSettingsLoaded = false;
                    setCapabilitiesUnknown();
                }
                return;
            }
            const applied = applyStateSnapshot(result.payload, 'http');
            if (applied.stateAccepted && typeof result.payload.sendingEnabled === 'boolean') {
                state.sendingEnabled = result.payload.sendingEnabled;
                adminSettingsLoaded = true;
                sendNotice = desired ? 'Panel sending enabled.' : 'Panel sending disabled.';
                sendNoticeIsError = false;
            }
        } catch (error) {
            sendNotice = 'Could not update the sending setting.';
            sendNoticeIsError = true;
        } finally {
            adminRequestPending = false;
            renderAllState();
        }
    }

    async function loadAdminHealth() {
        if (!currentUser || currentUser.role !== 'admin' || adminHealthLoading) {
            return;
        }
        adminHealthLoading = true;
        if (dom.diagnosticsRefresh) {
            dom.diagnosticsRefresh.disabled = true;
        }
        renderDiagnostics(null);
        try {
            const result = await controlledGet('/admin/chat/health');
            if (!result || !result.response.ok || !result.payload) {
                return;
            }
            const applied = applyStateSnapshot(result.payload, 'http');
            if (applied.stateAccepted) {
                renderDiagnostics(result.payload);
            }
        } catch (error) {
            renderDiagnostics(null);
        } finally {
            adminHealthLoading = false;
            if (dom.diagnosticsRefresh) {
                dom.diagnosticsRefresh.disabled = false;
            }
        }
    }

    function isMobile() {
        return Boolean(mobileQuery && mobileQuery.matches);
    }

    function setBackgroundInert(enabled) {
        if (enabled) {
            focusTrapRecords = [];
            Array.from(document.body.children).forEach((node) => {
                if (node === dom.shell || node === dom.cornerStack || node.tagName === 'SCRIPT') {
                    return;
                }
                focusTrapRecords.push({ node, inert: Boolean(node.inert), ariaHidden: node.getAttribute('aria-hidden') });
                node.inert = true;
                node.setAttribute('aria-hidden', 'true');
            });
            if (dom.updateButton) {
                focusTrapRecords.push({
                    node: dom.updateButton,
                    inert: Boolean(dom.updateButton.inert),
                    ariaHidden: dom.updateButton.getAttribute('aria-hidden')
                });
                dom.updateButton.inert = true;
                dom.updateButton.setAttribute('aria-hidden', 'true');
            }
            return;
        }
        focusTrapRecords.forEach(({ node, inert, ariaHidden }) => {
            node.inert = inert;
            if (ariaHidden === null) {
                node.removeAttribute('aria-hidden');
            } else {
                node.setAttribute('aria-hidden', ariaHidden);
            }
        });
        focusTrapRecords = [];
    }

    function updateResponsiveSemantics() {
        if (!dom.panel || !dom.shell) {
            return;
        }
        const mobile = isMobile();
        if (mobile) {
            dom.panel.setAttribute('aria-modal', 'true');
        } else {
            dom.panel.removeAttribute('aria-modal');
        }
        document.body.classList.toggle('server-chat-mobile-open', state.open && mobile);
        setBackgroundInert(state.open && mobile);
    }

    function focusableElements() {
        if (!dom.panel) {
            return [];
        }
        const elements = Array.from(dom.panel.querySelectorAll(
            'button:not([disabled]), input:not([disabled]), summary, [href], [tabindex]:not([tabindex="-1"])'
        )).filter((node) => !node.closest('.hidden') && node.getClientRects().length > 0);
        if (isMobile() && dom.toggle && !dom.toggle.disabled) {
            elements.push(dom.toggle);
        }
        return elements;
    }

    function handlePanelKeydown(event) {
        if (!state.open) {
            return;
        }
        if (event.key === 'Escape') {
            event.preventDefault();
            closePanel();
            return;
        }
        if (event.key !== 'Tab' || !isMobile()) {
            return;
        }
        const focusable = focusableElements();
        if (!focusable.length) {
            event.preventDefault();
            dom.panel.focus();
            return;
        }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
        }
    }

    function openPanel() {
        if (state.open) {
            return;
        }
        state.previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        state.open = true;
        focusComposerPending = true;
        dom.shell.classList.remove('hidden');
        dom.shell.setAttribute('aria-hidden', 'false');
        dom.toggle.setAttribute('aria-expanded', 'true');
        document.body.classList.add('server-chat-open');
        updateResponsiveSemantics();
        renderMessages({ bulk: true, stickToBottom: true });
        global.requestAnimationFrame(() => {
            dom.messages.scrollTop = dom.messages.scrollHeight;
            state.nearBottom = true;
            markReadThroughLatest();
            if (!dom.input.disabled) {
                focusComposerPending = false;
                dom.input.focus();
            } else {
                focusComposerPending = false;
                dom.close.focus();
            }
        });
        renderAllState();
    }

    function closePanel() {
        if (!state.open) {
            return;
        }
        state.open = false;
        focusComposerPending = false;
        dom.shell.classList.add('hidden');
        dom.shell.setAttribute('aria-hidden', 'true');
        dom.toggle.setAttribute('aria-expanded', 'false');
        document.body.classList.remove('server-chat-open', 'server-chat-mobile-open');
        setBackgroundInert(false);
        syncSessionClock();
        const restore = state.previousFocus;
        state.previousFocus = null;
        if (restore && restore.isConnected && typeof restore.focus === 'function') {
            restore.focus();
        } else {
            dom.toggle.focus();
        }
        renderUnread();
    }

    function toggleFilter(event) {
        const filter = event.currentTarget.dataset.chatFilter;
        if (!['chat', 'activity'].includes(filter)) {
            return;
        }
        const next = !state.filters[filter];
        const other = filter === 'chat' ? 'activity' : 'chat';
        if (!next && !state.filters[other]) {
            sendNotice = 'Keep at least one message filter enabled.';
            sendNoticeIsError = true;
            renderAllState();
            return;
        }
        state.filters[filter] = next;
        persistFilters();
        renderFilters();
        renderMessages({ bulk: true, stickToBottom: state.nearBottom });
    }

    function clearSocketStatusFallback({ resetAttempt = true } = {}) {
        if (socketStatusFallbackTimer) {
            global.clearTimeout(socketStatusFallbackTimer);
            socketStatusFallbackTimer = null;
        }
        if (resetAttempt) {
            socketStatusFallbackAttempt = 0;
        }
    }

    function scheduleSocketStatusFallback() {
        if (!state.connected || !awaitingSocketStatus || socketStatusFallbackTimer) {
            return;
        }
        const base = Math.min(
            SOCKET_STATUS_FALLBACK_INITIAL_MS * (2 ** socketStatusFallbackAttempt),
            SOCKET_STATUS_FALLBACK_MAX_MS
        );
        socketStatusFallbackAttempt = Math.min(socketStatusFallbackAttempt + 1, 5);
        const delay = Math.min(
            SOCKET_STATUS_FALLBACK_MAX_MS,
            Math.round(base * (0.8 + Math.random() * 0.4))
        );
        socketStatusFallbackTimer = global.setTimeout(async () => {
            socketStatusFallbackTimer = null;
            if (!state.connected || !awaitingSocketStatus) {
                return;
            }

            let accepted = false;
            try {
                const result = await controlledGet(historyUrl({ limit: 1 }));
                if (result && result.payload) {
                    const applied = applyStateSnapshot(result.payload, 'socket-fallback');
                    accepted = applied.stateAccepted && state.capabilitiesLoaded;
                    if (!result.response.ok) {
                        scheduleHistoryRetry();
                    }
                }
            } catch (error) {
                accepted = false;
            }

            if (accepted && state.connected) {
                awaitingSocketStatus = false;
                clearSocketStatusFallback();
                if (reconnectPending) {
                    reconnectPending = false;
                    global.setTimeout(() => synchronizeAfterReconnect(), 0);
                }
                if (currentUser && currentUser.role === 'admin' && !adminSettingsLoaded) {
                    global.setTimeout(() => loadAdminSettings(), 0);
                }
                renderAllState();
                return;
            }

            if (state.connected && awaitingSocketStatus) {
                scheduleSocketStatusFallback();
            }
        }, delay);
    }

    function handleRealtimeMessage(message) {
        if (!message || !CHAT_EVENT_TYPES.has(message.type)) {
            return false;
        }
        if (message.serverId && message.serverId !== SERVER_ID) {
            return true;
        }
        if (message.type === 'minecraft-chat-message') {
            const wasNearBottom = state.nearBottom;
            const inserted = upsertChatMessage(message.message, { unread: 'auto' });
            if (inserted) {
                appendLiveMessage(message.message, { stickToBottom: wasNearBottom });
                renderAllState();
            }
            return true;
        }

        const priorBaselineReady = Boolean(state.session && state.session.historyBaselineReady);
        const applied = applyStateSnapshot(message, 'ws');
        if (!applied.stateAccepted) {
            return true;
        }
        awaitingSocketStatus = false;
        clearSocketStatusFallback();
        if (applied.epochChanged || applied.sessionChanged || message.type === 'minecraft-chat-session-reset') {
            scheduleInitialHistoryReload();
        } else if (!priorBaselineReady
            && state.session
            && state.session.historyBaselineReady
            && state.baselinePending) {
            global.setTimeout(() => resolveReadyBaseline(), 0);
        } else if (classificationDeferred && historyInitialized && !state.baselinePending) {
            reconnectPending = true;
        }
        if (reconnectPending) {
            reconnectPending = false;
            global.setTimeout(() => synchronizeAfterReconnect(), 0);
        }
        if (currentUser && currentUser.role === 'admin' && !adminSettingsLoaded) {
            global.setTimeout(() => loadAdminSettings(), 0);
        }
        renderAllState();
        return true;
    }

    function handleSocketOpen() {
        state.connected = true;
        awaitingSocketStatus = true;
        setCapabilitiesUnknown({ preserveAdminRequest: true });
        // Even the first successful socket may follow a failed upgrade while the
        // initial HTTP snapshot was loading, so every open gets an afterId pass.
        reconnectPending = started;
        reconnectFrozenCursor = state.scanThroughId || state.lastMergedId;
        classificationDeferred = true;
        everConnected = true;
        clearSocketStatusFallback();
        scheduleSocketStatusFallback();
        renderAllState();
    }

    function handleSocketClose() {
        state.connected = false;
        awaitingSocketStatus = false;
        clearSocketStatusFallback();
        renderAllState();
    }

    function cacheDom() {
        const entries = {
            shell: 'server-chat-shell',
            panel: 'server-chat-panel',
            toggle: 'server-chat-toggle',
            unreadBadge: 'server-chat-unread-badge',
            close: 'server-chat-close',
            connectionStatus: 'server-chat-connection-status',
            sessionMeta: 'server-chat-session-meta',
            historyStatus: 'server-chat-history-status',
            filters: 'server-chat-filters',
            adminControls: 'server-chat-admin-controls',
            sendingEnabled: 'server-chat-sending-enabled',
            diagnostics: 'server-chat-admin-diagnostics',
            diagnosticsValues: 'server-chat-diagnostics-values',
            diagnosticsRefresh: 'server-chat-diagnostics-refresh',
            messages: 'server-chat-messages',
            newMessages: 'server-chat-new-messages',
            form: 'server-chat-form',
            input: 'server-chat-input',
            sendButton: 'server-chat-send',
            inputMeter: 'server-chat-input-meter',
            sendStatus: 'server-chat-send-status',
            cornerStack: 'corner-action-stack',
            updateButton: 'update-server'
        };
        Object.entries(entries).forEach(([key, id]) => {
            dom[key] = document.getElementById(id);
        });
        return Object.values(entries).every((id) => document.getElementById(id));
    }

    function bindEvents() {
        dom.toggle.addEventListener('click', () => state.open ? closePanel() : openPanel());
        dom.close.addEventListener('click', closePanel);
        dom.shell.querySelectorAll('[data-close-server-chat="true"]').forEach((node) => {
            node.addEventListener('click', closePanel);
        });
        dom.filters.querySelectorAll('[data-chat-filter]').forEach((button) => {
            button.addEventListener('click', toggleFilter);
        });
        dom.messages.addEventListener('scroll', () => {
            updateNearBottom();
            if (dom.messages.scrollTop <= 32) {
                loadOlderPage();
            }
        }, { passive: true });
        dom.newMessages.addEventListener('click', () => {
            const reduceMotion = global.matchMedia('(prefers-reduced-motion: reduce)').matches;
            dom.messages.scrollTo({
                top: dom.messages.scrollHeight,
                behavior: reduceMotion ? 'auto' : 'smooth'
            });
            if (reduceMotion) {
                global.requestAnimationFrame(updateNearBottom);
            }
        });
        dom.input.addEventListener('input', () => {
            if (pendingSendAttempt && pendingSendAttempt.normalizedText !== normalizeChatText(dom.input.value)) {
                pendingSendAttempt = null;
            }
            sendNotice = '';
            sendNoticeIsError = false;
            renderSendNotice();
            renderMeter();
        });
        dom.form.addEventListener('submit', submitMessage);
        dom.sendingEnabled.addEventListener('change', changeAdminSetting);
        dom.diagnostics.addEventListener('toggle', () => {
            if (dom.diagnostics.open) {
                loadAdminHealth();
            }
        });
        dom.diagnosticsRefresh.addEventListener('click', loadAdminHealth);
        dom.panel.addEventListener('keydown', handlePanelKeydown);
        dom.toggle.addEventListener('keydown', handlePanelKeydown);
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) {
                updateNearBottom();
            }
        });
        mobileQuery = global.matchMedia('(max-width: 768px)');
        if (typeof mobileQuery.addEventListener === 'function') {
            mobileQuery.addEventListener('change', updateResponsiveSemantics);
        } else if (typeof mobileQuery.addListener === 'function') {
            mobileQuery.addListener(updateResponsiveSemantics);
        }
    }

    function init({ user } = {}) {
        if (state.initialized) {
            return true;
        }
        currentUser = user || null;
        if (!currentUser || !cacheDom()) {
            return false;
        }
        loadFilters();
        bindEvents();
        state.initialized = true;
        renderMessages({ bulk: true });
        renderAllState();
        return true;
    }

    function start() {
        if (!state.initialized || started) {
            return;
        }
        started = true;
        loadInitialHistory();
        if (currentUser && currentUser.role === 'admin') {
            loadAdminSettings();
        }
    }

    const publicApi = {
        init,
        start,
        handleSocketOpen,
        handleSocketClose,
        handleRealtimeMessage,
        normalizeChatText,
        buildTellrawMeasurement
    };
    if (global.__SERVER_CHAT_TESTING__ === true) {
        publicApi.__testing = Object.freeze({
            localCalendarDayDifference,
            normalizeTimestampConfidence,
            sessionEndLabel
        });
    }
    global.ServerChat = Object.freeze(publicApi);
})(window);
