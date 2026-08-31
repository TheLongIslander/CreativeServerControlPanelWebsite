(function playerCenterModule(global) {
    'use strict';

    const SERVER_ID = 'default';
    const API_ROOT = `/api/servers/${encodeURIComponent(SERVER_ID)}`;
    const POLL_OPEN_MS = 15000;
    const POLL_CLOSED_MS = 45000;
    const STALE_AFTER_MS = 60000;
    const AVATAR_RETRY_MS = 5 * 60 * 1000;
    const PLAYER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

    const dom = {};
    const state = {
        initialized: false,
        started: false,
        open: false,
        user: null,
        activeView: 'players',
        selectedUuid: null,
        query: '',
        list: null,
        listLoading: false,
        listError: null,
        listUnavailable: false,
        socketConnected: false,
        lastRevision: null,
        profiles: new Map(),
        profileLoadingUuid: null,
        profileErrors: new Map(),
        linkLoaded: false,
        linkLoading: false,
        linkUnavailable: false,
        linkError: null,
        link: null,
        challenge: null,
        linkRosterSignature: null,
        linkPending: false,
        confirmUnlink: false,
        grantsLoaded: false,
        grantsLoading: false,
        grantsUnavailable: false,
        grantsError: null,
        grants: [],
        grantPending: false,
        grantDraft: null,
        grantSubmission: null,
        confirmGrantId: null,
        legacyPendingName: null,
        legacyErrors: new Map(),
        notice: null,
        previousFocus: null
    };

    let pollTimer = null;
    let freshnessTimer = null;
    let rosterController = null;
    let profileController = null;
    let mobileQuery = null;
    let focusTrapRecords = [];
    const avatarCache = new Map();
    const trendScrollPositions = new Map();
    let activeTrendBinding = null;

    class ApiError extends Error {
        constructor(message, status, payload) {
            super(message);
            this.name = 'ApiError';
            this.status = status;
            this.payload = payload;
        }
    }

    function isObject(value) {
        return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
    }

    function nonEmptyString(...values) {
        for (const value of values) {
            if (typeof value === 'string' && value.trim()) {
                return value.trim();
            }
        }
        return null;
    }

    function finiteNumber(...values) {
        for (const value of values) {
            if (value === null || value === undefined || value === '' || typeof value === 'boolean') {
                continue;
            }
            const number = Number(value);
            if (Number.isFinite(number)) {
                return number;
            }
        }
        return null;
    }

    function newIdempotencyKey() {
        if (global.crypto && typeof global.crypto.randomUUID === 'function') {
            return `player-grant-${global.crypto.randomUUID()}`;
        }
        if (global.crypto && typeof global.crypto.getRandomValues === 'function') {
            const bytes = new Uint8Array(16);
            global.crypto.getRandomValues(bytes);
            return `player-grant-${Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('')}`;
        }
        return `player-grant-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    }

    function humanize(value) {
        const text = String(value || '')
            .replace(/^minecraft:/, '')
            .replace(/[._:/-]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        if (!text) {
            return 'Unknown';
        }
        return text.replace(/\b\w/g, (character) => character.toUpperCase());
    }

    function formatDuration(totalSeconds, { compact = false } = {}) {
        const seconds = Math.max(0, finiteNumber(totalSeconds) || 0);
        if (seconds === 0) {
            return compact ? '0m' : 'No time observed';
        }
        if (seconds < 60) {
            return compact ? '<1m' : 'Less than a minute';
        }
        const totalMinutes = Math.floor(seconds / 60);
        const days = Math.floor(totalMinutes / 1440);
        const hours = Math.floor((totalMinutes % 1440) / 60);
        const minutes = totalMinutes % 60;
        if (days > 0) {
            return compact
                ? `${days}d ${hours}h`
                : `${days} ${days === 1 ? 'day' : 'days'} ${hours} ${hours === 1 ? 'hour' : 'hours'}`;
        }
        if (hours > 0) {
            return compact
                ? `${hours}h ${minutes}m`
                : `${hours} ${hours === 1 ? 'hour' : 'hours'} ${minutes} min`;
        }
        return compact ? `${minutes}m` : `${minutes} min`;
    }

    function formatNumber(value) {
        const number = finiteNumber(value);
        if (number === null) {
            return 'Not observed';
        }
        return new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(number);
    }

    function formatDateTime(value, { dateOnly = false } = {}) {
        if (!value) {
            return 'Not observed';
        }
        const date = new Date(value);
        if (!Number.isFinite(date.getTime())) {
            return 'Not observed';
        }
        try {
            return new Intl.DateTimeFormat(undefined, dateOnly ? {
                dateStyle: 'medium'
            } : {
                dateStyle: 'medium',
                timeStyle: 'short'
            }).format(date);
        } catch (error) {
            return date.toLocaleString();
        }
    }

    function formatRelativeTime(value) {
        if (!value) {
            return 'time unknown';
        }
        const then = new Date(value).getTime();
        if (!Number.isFinite(then)) {
            return 'time unknown';
        }
        const seconds = Math.round((Date.now() - then) / 1000);
        if (seconds < 0) {
            const remaining = Math.abs(seconds);
            if (remaining < 60) {
                return `in ${remaining}s`;
            }
            if (remaining < 3600) {
                return `in ${Math.ceil(remaining / 60)}m`;
            }
            if (remaining < 86400) {
                return `in ${Math.ceil(remaining / 3600)}h`;
            }
            return `in ${Math.ceil(remaining / 86400)}d`;
        }
        if (seconds < 10) {
            return 'just now';
        }
        if (seconds < 60) {
            return `${seconds}s ago`;
        }
        if (seconds < 3600) {
            return `${Math.floor(seconds / 60)}m ago`;
        }
        if (seconds < 86400) {
            return `${Math.floor(seconds / 3600)}h ago`;
        }
        const days = Math.floor(seconds / 86400);
        if (days < 45) {
            return `${days}d ago`;
        }
        if (days < 548) {
            const months = Math.max(1, Math.floor(days / 30.4375));
            return `${months}mo ago`;
        }
        const years = Math.max(1, Math.floor(days / 365.25));
        return `${years}y ago`;
    }

    function playtimeSeconds(raw) {
        const directSeconds = finiteNumber(raw && raw.playtimeSeconds, raw && raw.playTimeSeconds);
        if (directSeconds !== null) {
            return Math.max(0, directSeconds);
        }
        const ticks = finiteNumber(raw && raw.playtimeTicks, raw && raw.playTimeTicks);
        if (ticks !== null) {
            return Math.max(0, ticks / 20);
        }
        const playtime = isObject(raw && raw.playtime) ? raw.playtime : null;
        if (!playtime) {
            return null;
        }
        const value = finiteNumber(playtime.value);
        if (value === null) {
            return null;
        }
        const unit = String(playtime.unit || '').toLowerCase();
        if (unit.includes('tick')) {
            return Math.max(0, value / 20);
        }
        if (unit.includes('hour')) {
            return Math.max(0, value * 3600);
        }
        if (unit.includes('minute')) {
            return Math.max(0, value * 60);
        }
        return Math.max(0, value);
    }

    function normalizeVerifiedNameHistory(raw, nestedProfile, currentName) {
        const histories = [
            raw.names,
            raw.historicalNames,
            raw.aliases,
            nestedProfile.names,
            nestedProfile.historicalNames,
            nestedProfile.aliases
        ];
        const supplied = histories.some(Array.isArray);
        if (!supplied) {
            // Presence-only realtime payloads do not carry identity history.
            // Keep this undefined so mergePlayer preserves the HTTP roster's
            // authoritative aliases.
            return undefined;
        }

        const currentNameKey = String(currentName || '').toLocaleLowerCase();
        const seen = new Set();
        const normalized = [];
        histories.filter(Array.isArray).flat().forEach((entry) => {
            const record = typeof entry === 'string' ? { name: entry } : (isObject(entry) ? entry : {});
            const name = nonEmptyString(record.name, record.playerName, record.currentName);
            const association = String(record.association || '').trim().toLocaleLowerCase();
            const quality = String(record.quality || '').trim().toLocaleLowerCase();
            if (!name || !/^[A-Za-z0-9_]{1,16}$/.test(name)) {
                return;
            }
            if (record.verified === false || (association && association !== 'verified')) {
                return;
            }
            if (quality === 'external_candidate' || quality === 'legacy_name_only') {
                return;
            }
            const nameKey = name.toLocaleLowerCase();
            if (nameKey === currentNameKey || seen.has(nameKey)) {
                return;
            }
            seen.add(nameKey);
            normalized.push({
                name,
                firstObservedAt: nonEmptyString(record.firstObservedAt, record.first_seen_at),
                lastObservedAt: nonEmptyString(record.lastObservedAt, record.last_seen_at),
                source: nonEmptyString(record.source),
                quality: nonEmptyString(record.quality)
            });
        });
        return normalized;
    }

    function normalizePlayer(rawPlayer) {
        const raw = isObject(rawPlayer) ? rawPlayer : {};
        const presence = isObject(raw.presence) ? raw.presence : {};
        const nestedProfile = isObject(raw.player) ? raw.player : {};
        const uuid = nonEmptyString(raw.uuid, raw.playerUuid, nestedProfile.uuid);
        const observedName = nonEmptyString(
            raw.name,
            raw.currentName,
            raw.playerName,
            nestedProfile.name,
            nestedProfile.currentName
        );
        const name = observedName || (uuid ? `Player ${uuid.slice(0, 8)}` : 'Unresolved player');
        const names = normalizeVerifiedNameHistory(raw, nestedProfile, name);
        const explicitOnline = raw.online !== undefined
            ? Boolean(raw.online)
            : (presence.online !== undefined ? Boolean(presence.online) : String(raw.status || '').toLowerCase() === 'online');
        const nestedPlaytime = isObject(raw.playtime) ? raw.playtime : {};
        const hasLinkedState = Object.prototype.hasOwnProperty.call(raw, 'linkedToCurrentUser')
            || Object.prototype.hasOwnProperty.call(raw, 'isCurrentUser');
        return {
            uuid,
            name,
            names,
            aliases: names ? names.map(entry => entry.name) : undefined,
            online: explicitOnline,
            sessionStartedAt: nonEmptyString(raw.sessionStartedAt, presence.sessionStartedAt),
            firstSeenAt: nonEmptyString(raw.firstSeenAt, raw.firstSeen, nestedProfile.firstSeenAt, nestedProfile.firstSeen),
            lastSeenAt: nonEmptyString(raw.lastSeenAt, raw.lastSeen, presence.lastSeenAt, nestedProfile.lastSeenAt, nestedProfile.lastSeen),
            firstActivitySource: nonEmptyString(raw.firstActivitySource, nestedProfile.firstActivitySource),
            firstActivityQuality: nonEmptyString(raw.firstActivityQuality, nestedProfile.firstActivityQuality),
            activitySource: nonEmptyString(raw.activitySource, nestedProfile.activitySource),
            activityQuality: nonEmptyString(raw.activityQuality, nestedProfile.activityQuality),
            activityEvidenceKind: nonEmptyString(raw.activityEvidenceKind, nestedProfile.activityEvidenceKind),
            firstActivityEvidenceKind: nonEmptyString(raw.firstActivityEvidenceKind, nestedProfile.firstActivityEvidenceKind),
            playtimeSeconds: playtimeSeconds(raw),
            // Presence-only realtime payloads intentionally omit account-link
            // state. Preserve that distinction so they cannot clear an HTTP
            // response's authoritative value.
            linkedToCurrentUser: hasLinkedState
                ? Boolean(raw.linkedToCurrentUser || raw.isCurrentUser)
                : undefined,
            // Leave absent profile-envelope fields undefined so mergePlayer
            // preserves the directory row's more specific activity evidence.
            source: nonEmptyString(raw.source, presence.source, nestedPlaytime.source),
            quality: nonEmptyString(raw.quality, presence.quality, nestedPlaytime.quality),
            observedAt: nonEmptyString(raw.observedAt, presence.observedAt, nestedPlaytime.observedAt),
            unresolved: !uuid,
            nameResolved: Boolean(uuid && observedName),
            raw
        };
    }

    function activityTimestampPresentation(player) {
        const lastSeenAt = nonEmptyString(player && player.lastSeenAt);
        const evidenceKind = nonEmptyString(player && player.activityEvidenceKind) || '';
        const source = nonEmptyString(player && player.activitySource, player && player.source) || 'local evidence';
        const fileEstimate = evidenceKind.endsWith('_file_mtime');
        if (evidenceKind === 'legacy_playtime_score') {
            return {
                label: 'Historical playtime record',
                detail: 'Name-only scoreboard evidence proves recorded playtime, but not a trustworthy last-seen time.',
                estimated: false
            };
        }
        if (!lastSeenAt || !Number.isFinite(new Date(lastSeenAt).getTime())) {
            return {
                label: 'Last activity unavailable',
                detail: 'No trustworthy gameplay timestamp has been observed.',
                estimated: false
            };
        }
        if (evidenceKind === 'bukkit_first_played') {
            return {
                label: `First-known activity ${formatRelativeTime(lastSeenAt)}`,
                detail: `Recovered from the server's embedded legacy Bukkit first-played record (${formatDateTime(lastSeenAt)}). This establishes first-known retained activity, not a last-seen time.`,
                estimated: false,
                firstKnown: true
            };
        }
        if (fileEstimate) {
            return {
                label: `Estimated last active ${formatRelativeTime(lastSeenAt)}`,
                detail: `Estimated from ${humanize(evidenceKind.replace(/_mtime$/, ''))} modification time (${formatDateTime(lastSeenAt)}). Copies, transfers, and restores can reset this timestamp.`,
                estimated: true
            };
        }
        if (evidenceKind === 'bukkit_last_played') {
            return {
                label: `Last seen ${formatRelativeTime(lastSeenAt)}`,
                detail: `Recovered from the server's embedded legacy Bukkit last-played record (${formatDateTime(lastSeenAt)}).`,
                estimated: false
            };
        }
        return {
            label: `Last seen ${formatRelativeTime(lastSeenAt)}`,
            detail: `${humanize(source)} activity observed ${formatDateTime(lastSeenAt)}.`,
            estimated: false
        };
    }

    function firstActivityTimestampPresentation(player) {
        const firstSeenAt = nonEmptyString(player && player.firstSeenAt);
        if (!firstSeenAt || !Number.isFinite(new Date(firstSeenAt).getTime())) {
            return {
                value: 'Not observed',
                detail: 'No trustworthy first-known activity timestamp is available.'
            };
        }
        const sameActivityTimestamp = nonEmptyString(player && player.lastSeenAt) === firstSeenAt;
        const evidenceKind = nonEmptyString(
            player && player.firstActivityEvidenceKind,
            sameActivityTimestamp && player && player.activityEvidenceKind
        ) || '';
        const source = nonEmptyString(
            player && player.firstActivitySource,
            sameActivityTimestamp && player && player.activitySource
        );
        if (evidenceKind === 'bukkit_first_played') {
            return {
                value: formatDateTime(firstSeenAt, { dateOnly: true }),
                detail: `Embedded Bukkit first-played metadata gives the earliest known activity in retained files (${formatDateTime(firstSeenAt)}). It is not a last-seen timestamp.`
            };
        }
        if (evidenceKind.endsWith('_file_mtime')) {
            return {
                value: formatDateTime(firstSeenAt, { dateOnly: true }),
                detail: `Earliest retained filesystem estimate (${formatDateTime(firstSeenAt)}). Copies, transfers, and restores can reset file dates.`
            };
        }
        if (evidenceKind === 'advancement_criterion') {
            return {
                value: formatDateTime(firstSeenAt, { dateOnly: true }),
                detail: `The earliest retained advancement criterion proves activity at ${formatDateTime(firstSeenAt)}. It may be later than the player's actual first join.`
            };
        }
        if (evidenceKind === 'gameplay_event') {
            return {
                value: formatDateTime(firstSeenAt, { dateOnly: true }),
                detail: `The earliest retained gameplay event was observed at ${formatDateTime(firstSeenAt)}. Retained logs may begin after the player's actual first join.`
            };
        }
        return {
            value: formatDateTime(firstSeenAt, { dateOnly: true }),
            detail: `${source ? `${humanize(source)} provides the oldest` : 'Oldest'} trustworthy activity evidence currently retained (${formatDateTime(firstSeenAt)}). It may be later than the player's actual first join.`
        };
    }

    function retainedEventPresentation(summary) {
        const values = isObject(summary) ? summary : {};
        const joins = finiteNumber(values.observedJoinEvents);
        const deaths = finiteNumber(values.observedDeathEvents);
        const hasJoinOrDeathEvent = (joins !== null && joins > 0) || (deaths !== null && deaths > 0);
        let value = 'Not observed';
        if (hasJoinOrDeathEvent) {
            const joinLabel = joins > 0
                ? `${formatNumber(joins)} ${joins === 1 ? 'join' : 'joins'}`
                : 'No retained joins';
            const deathLabel = deaths > 0
                ? `${formatNumber(deaths)} ${deaths === 1 ? 'death' : 'deaths'}`
                : 'No retained deaths';
            value = `${joinLabel} · ${deathLabel}`;
        }
        return { value };
    }

    function mergePlayer(previous, incoming) {
        if (!previous) {
            return incoming;
        }
        const merged = { ...previous };
        Object.entries(incoming).forEach(([key, value]) => {
            if (value !== null && value !== undefined && value !== '') {
                merged[key] = value;
            }
        });
        // Incoming normalized DTOs always carry an explicit presence boolean;
        // a fresh offline observation must clear stale online state.
        merged.online = Boolean(incoming.online);
        // Fresh HTTP DTOs can clear a revoked link, while presence-only
        // realtime DTOs (which omit this field) retain the server-owned value.
        merged.linkedToCurrentUser = incoming.linkedToCurrentUser === undefined
            ? Boolean(previous.linkedToCurrentUser)
            : Boolean(incoming.linkedToCurrentUser);
        merged.unresolved = !merged.uuid;
        return merged;
    }

    function normalizeListPayload(payload) {
        const envelope = isObject(payload && payload.data) ? payload.data : (isObject(payload) ? payload : {});
        const roster = isObject(envelope.roster) ? envelope.roster : {};
        const serverRunning = typeof roster.serverRunning === 'boolean'
            ? roster.serverRunning
            : (typeof envelope.serverRunning === 'boolean' ? envelope.serverRunning : null);
        const rawPlayers = [];
        [envelope.players, envelope.directory, roster.players, envelope.onlinePlayers].forEach((candidate) => {
            if (Array.isArray(candidate)) {
                rawPlayers.push(...candidate);
            }
        });
        const playerMap = new Map();
        rawPlayers.forEach((entry) => {
            const player = normalizePlayer(entry);
            const key = player.uuid ? `uuid:${player.uuid.toLowerCase()}` : `name:${player.name.toLowerCase()}`;
            playerMap.set(key, mergePlayer(playerMap.get(key), player));
        });
        const players = Array.from(playerMap.values()).sort((a, b) => {
            if (a.online !== b.online) {
                return a.online ? -1 : 1;
            }
            return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
        });
        return {
            serverId: nonEmptyString(envelope.serverId) || SERVER_ID,
            observedAt: nonEmptyString(envelope.observedAt, roster.observedAt) || new Date().toISOString(),
            revision: envelope.revision === undefined ? null : envelope.revision,
            roster: {
                source: nonEmptyString(roster.source, envelope.source) || 'world_files',
                quality: nonEmptyString(roster.quality, envelope.quality) || 'observed',
                observedAt: nonEmptyString(roster.observedAt, envelope.observedAt) || null,
                serverRunning,
                serverState: nonEmptyString(roster.serverState, envelope.serverState)
                    || (serverRunning === null ? 'unknown' : (serverRunning ? 'online' : 'offline'))
            },
            players,
            coverage: isObject(envelope.coverage) ? envelope.coverage : {},
            identityReview: isObject(envelope.identityReview) ? envelope.identityReview : {},
            pagination: isObject(envelope.pagination) ? envelope.pagination : {},
            capabilities: isObject(envelope.capabilities) ? envelope.capabilities : {},
            health: isObject(envelope.health) ? envelope.health : {}
        };
    }

    function listContentSignature(list) {
        if (!list) {
            return '';
        }
        return JSON.stringify({
            roster: {
                source: list.roster && list.roster.source,
                quality: list.roster && list.roster.quality,
                serverRunning: list.roster && list.roster.serverRunning,
                serverState: list.roster && list.roster.serverState
            },
            players: (list.players || []).map((player) => [
                player.uuid,
                player.name,
                player.online,
                player.sessionStartedAt,
                player.firstSeenAt,
                player.firstActivitySource,
                player.firstActivityQuality,
                player.firstActivityEvidenceKind,
                player.lastSeenAt,
                player.activitySource,
                player.activityQuality,
                player.activityEvidenceKind,
                player.playtimeSeconds,
                player.linkedToCurrentUser,
                player.source,
                player.quality
            ]),
            coverage: list.coverage || {},
            identityReview: list.identityReview || {},
            pagination: list.pagination || {}
        });
    }

    function overlayRealtimeRoster(currentList, rosterSnapshot) {
        if (!currentList) {
            return rosterSnapshot;
        }
        const liveByUuid = new Map();
        const liveByName = new Map();
        rosterSnapshot.players.forEach((player) => {
            if (player.uuid) {
                liveByUuid.set(player.uuid.toLowerCase(), player);
            }
            liveByName.set(player.name.toLowerCase(), player);
        });
        const matched = new Set();
        const players = currentList.players.map((player) => {
            const uuidMatch = player.uuid ? liveByUuid.get(player.uuid.toLowerCase()) || null : null;
            const nameMatch = liveByName.get(player.name.toLowerCase()) || null;
            // Never attach one UUID's history to another UUID through a reused
            // name. Name fallback is only safe when the live observation is
            // itself name-only (the best-effort log path).
            const live = uuidMatch || (nameMatch && !nameMatch.uuid ? nameMatch : null);
            if (!live) {
                return {
                    ...player,
                    online: false,
                    sessionStartedAt: null
                };
            }
            matched.add(live.uuid ? `uuid:${live.uuid.toLowerCase()}` : `name:${live.name.toLowerCase()}`);
            return {
                ...mergePlayer(player, live),
                online: true
            };
        });
        rosterSnapshot.players.forEach((player) => {
            const key = player.uuid ? `uuid:${player.uuid.toLowerCase()}` : `name:${player.name.toLowerCase()}`;
            if (!matched.has(key)) {
                players.push({ ...player, online: true });
            }
        });
        players.sort((a, b) => {
            if (a.online !== b.online) {
                return a.online ? -1 : 1;
            }
            return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
        });
        return {
            ...currentList,
            observedAt: rosterSnapshot.observedAt,
            revision: rosterSnapshot.revision,
            roster: rosterSnapshot.roster,
            players
        };
    }

    function isStaleRevision(nextRevision, currentRevision) {
        if (nextRevision === null || nextRevision === undefined || currentRevision === null || currentRevision === undefined) {
            return false;
        }
        const nextNumber = Number(nextRevision);
        const currentNumber = Number(currentRevision);
        if (Number.isFinite(nextNumber) && Number.isFinite(currentNumber)) {
            return nextNumber <= currentNumber;
        }
        return String(nextRevision) === String(currentRevision);
    }

    function isStaleRosterSnapshot({
        nextRevision,
        currentRevision,
        nextObservedAt,
        currentObservedAt,
        realtime = false
    }) {
        const nextTime = new Date(nextObservedAt || '').getTime();
        const currentTime = new Date(currentObservedAt || '').getTime();
        if (Number.isFinite(nextTime) && Number.isFinite(currentTime) && nextTime < currentTime) {
            return true;
        }
        if (nextRevision === null || nextRevision === undefined
            || currentRevision === null || currentRevision === undefined) {
            return false;
        }
        const nextNumber = Number(nextRevision);
        const currentNumber = Number(currentRevision);
        if (Number.isFinite(nextNumber) && Number.isFinite(currentNumber)) {
            if (nextNumber === currentNumber) {
                return realtime;
            }
            if (nextNumber < currentNumber) {
                // The presence service's revision counter restarts with the
                // process. A strictly newer observation marks a new epoch.
                return !(Number.isFinite(nextTime) && Number.isFinite(currentTime) && nextTime > currentTime);
            }
            return false;
        }
        return realtime && String(nextRevision) === String(currentRevision);
    }

    function createElement(tagName, className, text) {
        const element = document.createElement(tagName);
        if (className) {
            element.className = className;
        }
        if (text !== undefined && text !== null) {
            element.textContent = String(text);
        }
        return element;
    }

    function createButton(text, className) {
        const button = createElement('button', className, text);
        button.type = 'button';
        button.dataset.pointerProfile = 'compact';
        return button;
    }

    function createBadge(text, stateName) {
        const badge = createElement('span', 'player-center-badge', text);
        if (stateName) {
            badge.dataset.state = stateName;
        }
        return badge;
    }

    async function loadAvatarUrl(uuid) {
        const key = String(uuid || '').trim().toLowerCase();
        if (!PLAYER_UUID.test(key)) {
            return null;
        }
        const cached = avatarCache.get(key);
        if (cached && cached.url) {
            return cached.url;
        }
        if (cached && cached.promise) {
            return cached.promise;
        }
        if (cached && cached.retryAt > Date.now()) {
            return null;
        }
        const promise = (async () => {
            const response = await fetch(`${API_ROOT}/players/${encodeURIComponent(key)}/avatar`, {
                method: 'GET',
                headers: { ...authHeaders(false), Accept: 'image/png' },
                cache: 'force-cache',
                credentials: 'same-origin'
            });
            if (!response.ok || !(response.headers.get('content-type') || '').toLowerCase().startsWith('image/png')) {
                throw new Error('Player avatar is unavailable.');
            }
            const blob = await response.blob();
            if (!blob.size || blob.size > 1024 * 1024 || !global.URL || typeof global.URL.createObjectURL !== 'function') {
                throw new Error('Player avatar response is invalid.');
            }
            const url = global.URL.createObjectURL(blob);
            avatarCache.set(key, { url, promise: null, retryAt: 0 });
            return url;
        })().catch(() => {
            avatarCache.set(key, { url: null, promise: null, retryAt: Date.now() + AVATAR_RETRY_MS });
            return null;
        });
        avatarCache.set(key, { url: null, promise, retryAt: 0 });
        return promise;
    }

    function createPlayerAvatar(player, className = '') {
        const value = isObject(player) ? player : {};
        const name = nonEmptyString(value.name, value.currentName, value.playerName) || 'Player';
        const avatar = createElement('span', `player-center-avatar${className ? ` ${className}` : ''}`, name.slice(0, 2).toUpperCase());
        avatar.setAttribute('aria-hidden', 'true');
        if (value.uuid) {
            void loadAvatarUrl(value.uuid).then((url) => {
                if (!url) return;
                const image = createElement('img', 'player-center-avatar-image');
                image.alt = '';
                image.decoding = 'async';
                image.addEventListener('load', () => {
                    avatar.replaceChildren(image);
                    avatar.classList.add('has-skin');
                }, { once: true });
                image.src = url;
            });
        }
        return avatar;
    }

    function releaseAvatarUrls() {
        for (const entry of avatarCache.values()) {
            if (entry.url && global.URL && typeof global.URL.revokeObjectURL === 'function') {
                global.URL.revokeObjectURL(entry.url);
            }
        }
        avatarCache.clear();
    }

    function createStateCard(kind, title, message, action) {
        const card = createElement('div', 'player-center-state-card');
        card.dataset.pointerProfile = 'surface';
        card.dataset.state = kind;
        if (kind === 'error' || kind === 'unavailable' || kind === 'degraded') {
            card.setAttribute('role', 'alert');
        } else {
            card.setAttribute('role', 'status');
        }
        card.appendChild(createElement('strong', null, title));
        if (message) {
            card.appendChild(createElement('p', null, message));
        }
        if (action && typeof action.onClick === 'function') {
            const button = createButton(action.label || 'Try again', 'player-center-state-action');
            button.addEventListener('click', action.onClick);
            card.appendChild(button);
        }
        return card;
    }

    function focusAfterRender(selector) {
        global.requestAnimationFrame(() => {
            const target = document.querySelector(selector);
            if (target && typeof target.focus === 'function') {
                target.focus();
            }
        });
    }

    function authHeaders(includeJson) {
        const headers = { Accept: 'application/json' };
        const token = localStorage.getItem('token');
        if (token) {
            headers.Authorization = `Bearer ${token}`;
        }
        if (includeJson) {
            headers['Content-Type'] = 'application/json';
        }
        return headers;
    }

    async function apiRequest(path, options = {}) {
        const hasBody = options.body !== undefined;
        const response = await fetch(`${API_ROOT}${path}`, {
            method: options.method || 'GET',
            headers: { ...authHeaders(hasBody), ...(options.headers || {}) },
            body: hasBody ? JSON.stringify(options.body) : undefined,
            cache: 'no-store',
            credentials: 'same-origin',
            signal: options.signal
        });
        if (response.status === 428) {
            window.location.href = '/set-password.html';
            throw new ApiError('Password reset required.', response.status, null);
        }
        if (response.status === 401) {
            localStorage.removeItem('token');
            window.location.href = '/';
            throw new ApiError('Your session has expired.', response.status, null);
        }
        let payload = null;
        const contentType = response.headers.get('content-type') || '';
        if (response.status !== 204) {
            try {
                payload = contentType.includes('application/json') ? await response.json() : null;
            } catch (error) {
                payload = null;
            }
        }
        if (!response.ok) {
            const message = nonEmptyString(
                payload && payload.error && payload.error.message,
                payload && payload.error,
                payload && payload.message
            ) || `Request failed (${response.status}).`;
            throw new ApiError(message.slice(0, 240), response.status, payload);
        }
        return payload;
    }

    function canManageAccess() {
        if (state.user && state.user.role === 'admin') {
            return true;
        }
        const values = state.user && Array.isArray(state.user.capabilities) ? state.user.capabilities : [];
        return values.includes('players.access.manage');
    }

    function isAdmin() {
        return Boolean(state.user && state.user.role === 'admin');
    }

    function playerMatchesQuery(player, rawQuery) {
        const query = String(rawQuery || '').trim().toLocaleLowerCase();
        if (!query) {
            return true;
        }
        const searchableNames = [player && player.name];
        if (Array.isArray(player && player.names)) {
            searchableNames.push(...player.names.map(entry => typeof entry === 'string' ? entry : entry && entry.name));
        }
        if (Array.isArray(player && player.aliases)) {
            searchableNames.push(...player.aliases);
        }
        return searchableNames.some(name => typeof name === 'string' && name.toLocaleLowerCase().includes(query));
    }

    function filteredPlayers() {
        if (!state.list) {
            return [];
        }
        const query = state.query.trim().toLocaleLowerCase();
        if (!query) {
            return state.list.players;
        }
        return state.list.players.filter((player) => playerMatchesQuery(player, query));
    }

    function playerByUuid(uuid) {
        if (!state.list || !uuid) {
            return null;
        }
        return state.list.players.find((player) => player.uuid === uuid) || null;
    }

    function serverHealth() {
        if (!state.list) {
            return { state: 'offline', label: state.listLoading ? 'Checking server' : 'Server offline' };
        }
        const running = state.list.roster && state.list.roster.serverRunning;
        const quality = String(state.list.roster && state.list.roster.quality || '').toLowerCase();
        if (running === false || quality === 'offline') {
            return { state: 'offline', label: 'Server offline' };
        }
        // Older responses did not include serverRunning. Every active presence
        // quality is emitted only while the shared process service is running;
        // retain that compatibility until all panel processes have restarted.
        if (running === true || (quality && !quality.includes('unavailable') && quality !== 'unknown')) {
            return { state: 'online', label: 'Server online' };
        }
        return { state: 'offline', label: 'Server status unavailable' };
    }

    function authoritativeOnlinePlayers(list, nowMs = Date.now()) {
        if (!list || !Array.isArray(list.players)) {
            return [];
        }
        const observedAt = list.roster && (list.roster.observedAt || list.observedAt);
        const age = observedAt ? nowMs - new Date(observedAt).getTime() : Infinity;
        const rosterQuality = String(list.roster && list.roster.quality || '').toLowerCase();
        if (rosterQuality !== 'authoritative' || !Number.isFinite(age) || age < -5000 || age > STALE_AFTER_MS) {
            return [];
        }
        return list.players.filter((player) => (
            player.online
            && player.uuid
            && String(player.quality || '').toLowerCase() === 'authoritative'
        ));
    }

    function linkRosterSignature(list, nowMs = Date.now()) {
        return JSON.stringify(authoritativeOnlinePlayers(list, nowMs).map((player) => [
            player.uuid,
            player.name
        ]));
    }

    function reconcileCachedProfilesFromList() {
        if (!state.list) {
            return;
        }
        for (const [uuid, profile] of state.profiles) {
            const rosterPlayer = state.list.players.find((player) => player.uuid === uuid);
            if (!profile || !rosterPlayer) {
                continue;
            }
            state.profiles.set(uuid, {
                ...profile,
                player: {
                    ...profile.player,
                    name: rosterPlayer.name,
                    online: rosterPlayer.online,
                    linkedToCurrentUser: rosterPlayer.linkedToCurrentUser,
                    sessionStartedAt: rosterPlayer.sessionStartedAt,
                    lastSeenAt: rosterPlayer.lastSeenAt,
                    source: rosterPlayer.source,
                    quality: rosterPlayer.quality,
                    observedAt: rosterPlayer.observedAt || state.list.observedAt
                }
            });
        }
        if (state.activeView === 'profile' && state.selectedUuid && state.profiles.has(state.selectedUuid)) {
            renderProfile();
        }
    }

    function renderHeader() {
        if (!dom.connectionStatus || !dom.sourceLabel) {
            return;
        }
        const health = serverHealth();
        const onlineCount = state.list ? state.list.players.filter((player) => player.online).length : 0;
        dom.connectionStatus.dataset.state = health.state;
        dom.connectionStatus.textContent = health.label;
        const observedAt = state.list ? (state.list.roster.observedAt || state.list.observedAt) : null;
        dom.sourceLabel.textContent = state.list
            ? `${onlineCount} ${onlineCount === 1 ? 'player' : 'players'} online${observedAt ? ` · updated ${formatRelativeTime(observedAt)}` : ''}`
            : 'Waiting for player count';

        dom.toggle.dataset.state = health.state;
        dom.toggleCount.textContent = String(onlineCount);
        dom.toggleCount.setAttribute('aria-label', `${onlineCount} ${onlineCount === 1 ? 'player' : 'players'} online`);
        dom.toggleCount.classList.toggle('hidden', !state.list);
        dom.toggle.setAttribute('aria-label', state.list
            ? `Open Players, ${onlineCount} ${onlineCount === 1 ? 'player' : 'players'} online, ${health.label}`
            : 'Open Players');
    }

    function renderNav() {
        if (!dom.nav) {
            return;
        }
        dom.accessNav.classList.toggle('hidden', !canManageAccess());
        dom.nav.querySelectorAll('[data-player-center-view]').forEach((button) => {
            const view = button.dataset.playerCenterView;
            const active = view === state.activeView || (view === 'players' && state.activeView === 'profile');
            button.setAttribute('aria-pressed', active ? 'true' : 'false');
        });
    }

    function renderSidebar() {
        if (!dom.playerList || !dom.rosterStatus) {
            return;
        }
        const players = filteredPlayers();
        dom.playerList.replaceChildren();
        const appendState = (...args) => {
            const listItem = createElement('div', 'player-center-list-state');
            listItem.setAttribute('role', 'listitem');
            listItem.appendChild(createStateCard(...args));
            dom.playerList.appendChild(listItem);
        };
        if (state.listLoading && !state.list) {
            dom.rosterStatus.textContent = 'Loading player directory…';
            appendState('loading', 'Collecting players', 'Reading the latest roster and world observations.');
            return;
        }
        if (!state.list) {
            dom.rosterStatus.textContent = state.listUnavailable ? 'Player data is not enabled.' : 'Player directory unavailable.';
            appendState(
                state.listUnavailable ? 'unavailable' : 'error',
                state.listUnavailable ? 'Not available yet' : 'Could not load players',
                state.listUnavailable ? 'The Player Center backend has not been enabled for this server.' : (state.listError || 'Try refreshing the roster.'),
                { label: 'Retry', onClick: () => loadRoster({ force: true }) }
            );
            return;
        }
        const onlineCount = state.list.players.filter((player) => player.online).length;
        const truncated = Boolean(state.list.pagination && state.list.pagination.hasMore);
        dom.rosterStatus.textContent = state.query
            ? `${players.length} matching loaded ${players.length === 1 ? 'player' : 'players'}${truncated ? ' · directory continues' : ''}`
            : `${onlineCount} online · ${state.list.players.length} ${state.list.players.length === 1 ? 'player' : 'players'}${truncated ? ` of ${finiteNumber(state.list.pagination.total) || 'more'}` : ''}`;
        if (!players.length) {
            appendState('empty', 'No matching players', 'Try another player name.');
            return;
        }
        const fragment = document.createDocumentFragment();
        players.forEach((player) => {
            const listItem = createElement('div', 'player-center-list-item');
            listItem.setAttribute('role', 'listitem');
            const button = createButton('', 'player-center-list-player');
            button.dataset.pointerProfile = 'anchored';
            button.dataset.playerUuid = player.uuid || '';
            if (state.selectedUuid && player.uuid === state.selectedUuid) {
                button.setAttribute('aria-current', 'true');
            }
            const visual = createElement('span', 'player-center-pointer-visual player-center-list-player-visual');
            const avatar = createPlayerAvatar(player);
            const avatarSensor = createElement('span', 'player-center-avatar-sensor');
            avatarSensor.setAttribute('aria-hidden', 'true');
            const copy = createElement('span', 'player-center-list-player-copy');
            const nameRow = createElement('span', 'player-center-list-player-name');
            nameRow.appendChild(createElement('span', null, player.name));
            if (player.linkedToCurrentUser) {
                nameRow.appendChild(createBadge('You', 'linked'));
            }
            if (!player.uuid) {
                nameRow.appendChild(createBadge('Legacy name only', 'warning'));
            }
            const activity = activityTimestampPresentation(player);
            const meta = player.online
                ? (player.sessionStartedAt ? `Online · ${formatDuration((Date.now() - new Date(player.sessionStartedAt).getTime()) / 1000, { compact: true })}` : 'Online now')
                : activity.label;
            const metaElement = createElement('span', 'player-center-list-player-meta', meta);
            if (!player.online) {
                metaElement.title = activity.detail;
                button.title = activity.detail;
            }
            copy.append(nameRow, metaElement);
            const presence = createElement('span', 'player-center-presence-dot');
            presence.dataset.state = player.online ? 'online' : 'offline';
            presence.setAttribute('aria-label', player.online ? 'Online' : 'Offline');
            visual.append(avatar, copy, presence);
            button.append(visual, avatarSensor);
            button.addEventListener('click', () => selectPlayer(player));
            listItem.appendChild(button);
            fragment.appendChild(listItem);
        });
        dom.playerList.appendChild(fragment);
    }

    function summaryCard(label, value, detail, stateName) {
        const card = createElement('article', 'player-center-summary-card');
        card.dataset.pointerProfile = 'surface';
        if (stateName) {
            card.dataset.state = stateName;
        }
        card.append(createElement('span', 'player-center-summary-label', label));
        card.append(createElement('strong', 'player-center-summary-value', value));
        if (detail) {
            card.append(createElement('span', 'player-center-summary-detail', detail));
        }
        return card;
    }

    function overviewInsights(players) {
        const identified = (Array.isArray(players) ? players : []).filter((player) => player && player.uuid);
        const playtime = identified.reduce((entries, player) => {
            const seconds = finiteNumber(player.playtimeSeconds);
            if (seconds !== null) {
                entries.push({ player, seconds: Math.max(0, seconds) });
            }
            return entries;
        }, []);
        const positivePlaytime = playtime.filter(entry => entry.seconds > 0);
        positivePlaytime.sort((left, right) => (
            right.seconds - left.seconds
            || String(left.player.name || '').localeCompare(String(right.player.name || ''), undefined, { sensitivity: 'base' })
            || String(left.player.uuid).localeCompare(String(right.player.uuid))
        ));

        const activity = identified.reduce((entries, player) => {
            const evidenceKind = nonEmptyString(player.activityEvidenceKind) || '';
            const observedAt = new Date(player.lastSeenAt || '').getTime();
            if (
                Number.isFinite(observedAt)
                && evidenceKind !== 'legacy_playtime_score'
                && evidenceKind !== 'bukkit_first_played'
            ) {
                entries.push({ player, observedAt });
            }
            return entries;
        }, []);
        activity.sort((left, right) => (
            right.observedAt - left.observedAt
            || String(left.player.name || '').localeCompare(String(right.player.name || ''), undefined, { sensitivity: 'base' })
            || String(left.player.uuid).localeCompare(String(right.player.uuid))
        ));

        return {
            playtimeProfileCount: playtime.length,
            totalPlaytimeSeconds: playtime.length
                ? playtime.reduce((total, entry) => total + entry.seconds, 0)
                : null,
            mostPlayed: positivePlaytime[0] || null,
            latestActivity: activity[0] || null
        };
    }

    function hasHistoricalDirectoryData(list) {
        const pagination = isObject(list && list.pagination) ? list.pagination : {};
        return ['total', 'loadedTotal', 'totalIsExact']
            .some(key => Object.prototype.hasOwnProperty.call(pagination, key));
    }

    function playerInsightCard(label, entry, detail) {
        if (!entry || !entry.player) {
            return summaryCard(label, 'Not observed', detail);
        }
        const player = entry.player;
        const card = createElement('article', 'player-center-summary-card player-center-player-insight-card');
        card.dataset.pointerProfile = 'surface';
        card.appendChild(createElement('span', 'player-center-summary-label', label));
        const valueRow = createElement('div', 'player-center-insight-value-row');
        const value = createElement('strong', 'player-center-summary-value', player.name);
        value.title = player.name;
        valueRow.append(createPlayerAvatar(player), value);
        card.append(valueRow, createElement('span', 'player-center-summary-detail', detail));
        return card;
    }

    function renderPlayersOverview() {
        const view = createElement('div', 'player-center-overview');
        const titleRow = createElement('div', 'player-center-view-heading');
        const titleCopy = createElement('div');
        titleCopy.append(createElement('div', 'player-center-kicker', 'Live player tracking'));
        titleCopy.append(createElement('h3', null, 'Players'));
        titleCopy.append(createElement('p', null, 'See who is online now, then open any player for their server history.'));
        titleRow.appendChild(titleCopy);
        view.appendChild(titleRow);

        if (state.listLoading && !state.list) {
            view.appendChild(createStateCard('loading', 'Loading live player tracking', 'Connecting to the roster and collecting historical player records.'));
            dom.view.replaceChildren(view);
            return;
        }
        if (!state.list) {
            view.appendChild(createStateCard(
                state.listUnavailable ? 'unavailable' : 'error',
                state.listUnavailable ? 'Player tracking is not available yet' : 'Player tracking could not load',
                state.listUnavailable ? 'The panel is ready, but this server has not exposed its Player Center API.' : (state.listError || 'Retry when the server connection is available.'),
                { label: 'Retry', onClick: () => loadRoster({ force: true }) }
            ));
            dom.view.replaceChildren(view);
            return;
        }

        const allPlayers = state.list.players;
        const online = allPlayers.filter((player) => player.online);
        const identified = allPlayers.filter((player) => player.uuid);
        const observedPlaytime = allPlayers.filter((player) => player.playtimeSeconds !== null);
        const cards = createElement('div', 'player-center-summary-grid player-center-overview-live-grid');
        const server = serverHealth();
        const liveCountCard = summaryCard(
            'Players online now',
            String(online.length),
            server.state === 'online'
                ? (state.socketConnected ? 'Server online · live updates connected' : 'Server online · latest player count')
                : 'Server offline',
            server.state === 'online' ? 'live' : 'neutral'
        );
        liveCountCard.classList.add('player-center-summary-card-live-count');
        cards.appendChild(liveCountCard);
        view.appendChild(cards);

        const pagination = state.list.pagination;
        if (hasHistoricalDirectoryData(state.list)) {
            const insights = overviewInsights(allPlayers);
            const completeRoster = pagination.hasMore !== true && pagination.totalIsExact !== false;
            const insightCards = createElement('div', 'player-center-overview-insights');
            insightCards.appendChild(summaryCard(
                completeRoster ? 'Combined playtime' : 'Loaded playtime',
                insights.totalPlaytimeSeconds === null
                    ? 'Not observed'
                    : formatDuration(insights.totalPlaytimeSeconds, { compact: true }),
                insights.totalPlaytimeSeconds === null
                    ? 'UUID-backed playtime is not available yet'
                    : `${insights.playtimeProfileCount} UUID ${insights.playtimeProfileCount === 1 ? 'profile' : 'profiles'}`
            ));
            insightCards.appendChild(playerInsightCard(
                completeRoster ? 'Most played' : 'Top loaded player',
                insights.mostPlayed,
                insights.mostPlayed
                    ? `${formatDuration(insights.mostPlayed.seconds, { compact: true })} recorded`
                    : (insights.playtimeProfileCount
                        ? 'No positive UUID-backed playtime observed'
                        : 'UUID-backed playtime is not available yet')
            ));
            if (insights.latestActivity) {
                const latestPlayer = insights.latestActivity.player;
                insightCards.appendChild(playerInsightCard(
                    completeRoster ? 'Latest activity' : 'Latest loaded activity',
                    insights.latestActivity,
                    latestPlayer.online ? 'Online now' : activityTimestampPresentation(latestPlayer).label
                ));
            }
            view.appendChild(insightCards);

            const coverage = createElement('div', 'player-center-overview-meta');
            coverage.setAttribute('aria-label', 'Player history coverage');
            coverage.append(
                createElement('span', null, `Player history: ${allPlayers.length}${completeRoster ? '' : ' loaded'} · ${identified.length} UUID-linked`),
                createElement('span', null, `Playtime history: ${observedPlaytime.length} of ${allPlayers.length}${completeRoster ? '' : ' loaded'} profiles`)
            );
            view.appendChild(coverage);
        }

        const section = createElement('section', 'player-center-section');
        const sectionHeader = createElement('div', 'player-center-section-heading');
        sectionHeader.append(createElement('div', null, 'Online players'));
        sectionHeader.append(createElement('span', null, `${online.length} online`));
        section.appendChild(sectionHeader);
        if (!online.length) {
            section.appendChild(createStateCard('empty', 'Nobody is online'));
        } else {
            const grid = createElement('div', 'player-center-online-grid');
            online.forEach((player) => {
                const button = createButton('', 'player-center-online-card');
                const avatar = createPlayerAvatar(player, 'player-center-avatar-large');
                const copy = createElement('span', 'player-center-online-copy');
                copy.append(createElement('strong', null, player.name));
                copy.append(createElement('span', null, player.sessionStartedAt
                    ? `Current session ${formatDuration((Date.now() - new Date(player.sessionStartedAt).getTime()) / 1000, { compact: true })}`
                    : 'Online now'));
                button.append(avatar, copy, createBadge('Live', 'live'));
                button.addEventListener('click', () => selectPlayer(player));
                grid.appendChild(button);
            });
            section.appendChild(grid);
        }
        view.appendChild(section);

        const unresolved = allPlayers.filter((player) => !player.uuid);
        if (isAdmin() && unresolved.length) {
            const legacySection = createElement('section', 'player-center-section player-center-legacy-section');
            const legacyHeading = createElement('div', 'player-center-section-heading');
            legacyHeading.append(createElement('div', null, 'Legacy identity review'));
            legacyHeading.append(createElement('span', null, `${unresolved.length} name-only`));
            legacySection.appendChild(legacyHeading);
            legacySection.appendChild(createElement(
                'p',
                'player-center-section-note',
                'NameMC can suggest a UUID, but Minecraft names are recyclable: a result may be the current owner, not the person in an older backup. Every result stays a time-stamped, unverified candidate and cannot prove ownership or authorize access.'
            ));
            const legacyList = createElement('div', 'player-center-legacy-list');
            unresolved.forEach((player) => {
                const row = createElement('article', 'player-center-legacy-card');
                const rowHeading = createElement('div');
                const candidateUuid = nonEmptyString(player.raw && player.raw.candidateUuid);
                rowHeading.append(createElement('strong', null, player.name));
                rowHeading.append(createElement('span', null, humanize(player.source)));
                row.appendChild(rowHeading);
                if (candidateUuid) {
                    row.appendChild(createBadge('Unverified candidate recorded', 'warning'));
                    row.appendChild(createElement(
                        'p',
                        'player-center-section-note',
                        `Candidate ${candidateUuid} was recorded ${formatRelativeTime(player.raw.candidateObservedAt)}. A recycled name can point to the wrong person; this record remains isolated until server UUID evidence matches.`
                    ));
                }
                const form = createElement('form', 'player-center-legacy-form');
                const search = createButton('Search NameMC', 'player-center-secondary-button');
                search.addEventListener('click', () => {
                    const popup = global.open(
                        `https://namemc.com/search?q=${encodeURIComponent(player.name)}`,
                        '_blank',
                        'noopener,noreferrer'
                    );
                    if (popup) {
                        popup.opener = null;
                    }
                });
                const label = createElement('label', null, 'Candidate UUID (unverified)');
                const input = createElement('input');
                input.name = 'uuid';
                input.type = 'text';
                input.autocomplete = 'off';
                input.spellcheck = false;
                input.placeholder = 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx';
                input.value = candidateUuid || '';
                input.required = true;
                input.disabled = state.legacyPendingName === player.name;
                label.appendChild(input);
                const submit = createButton(
                    state.legacyPendingName === player.name ? 'Recording…' : (candidateUuid ? 'Update candidate' : 'Record candidate'),
                    'player-center-primary-button'
                );
                submit.type = 'submit';
                submit.disabled = state.legacyPendingName !== null;
                form.append(search, label, submit);
                form.addEventListener('submit', (event) => recordLegacyCandidate(event, player.name));
                row.appendChild(form);
                const error = state.legacyErrors.get(player.name);
                if (error) {
                    row.appendChild(createElement('p', 'player-center-inline-error', error));
                }
                legacyList.appendChild(row);
            });
            legacySection.appendChild(legacyList);
            view.appendChild(legacySection);
        }
        dom.view.replaceChildren(view);
    }

    function normalizeProfilePayload(profilePayload, fallbackPlayer, trendsPayload) {
        const envelope = isObject(profilePayload && profilePayload.data) ? profilePayload.data : (isObject(profilePayload) ? profilePayload : {});
        const rawPlayer = isObject(envelope.player) ? envelope.player : envelope;
        const player = mergePlayer(fallbackPlayer, normalizePlayer(rawPlayer));
        const separateTrends = isObject(trendsPayload && trendsPayload.data) ? trendsPayload.data : trendsPayload;
        return {
            player,
            stats: Array.isArray(envelope.stats) ? envelope.stats : [],
            advancements: Array.isArray(envelope.advancements) ? envelope.advancements : [],
            sessions: Array.isArray(envelope.sessions) ? envelope.sessions : [],
            names: Array.isArray(envelope.names) ? envelope.names : [],
            summary: isObject(envelope.summary) ? envelope.summary : {},
            trends: separateTrends || envelope.trends || envelope.history || {},
            coverage: isObject(envelope.coverage) ? envelope.coverage : (state.list ? state.list.coverage : {})
        };
    }

    function statKey(stat) {
        return nonEmptyString(stat && stat.key, stat && stat.id, stat && stat.name, stat && stat.stat) || 'unknown';
    }

    function statNumericValue(stat) {
        return finiteNumber(stat && stat.value, stat && stat.total, stat && stat.count);
    }

    function formatStatValue(stat) {
        const value = statNumericValue(stat);
        if (value === null) {
            return 'Observed';
        }
        const unit = String(stat && stat.unit || '').toLowerCase();
        if (unit === 'ticks') {
            return formatDuration(value / 20, { compact: true });
        }
        if (unit === 'centimeters') {
            const meters = value / 100;
            return meters >= 1000
                ? `${formatNumber(meters / 1000)} km`
                : `${formatNumber(meters)} m`;
        }
        if (unit === 'tenths_of_hit_point') {
            return `${formatNumber(value / 10)} health`;
        }
        return `${formatNumber(value)}${unit && unit !== 'count' ? ` ${humanize(unit).toLowerCase()}` : ''}`;
    }

    function findStat(stats, patterns) {
        return stats.find((stat) => {
            const key = statKey(stat).toLowerCase();
            return patterns.some((pattern) => key.includes(pattern));
        }) || null;
    }

    function trendScrollMetrics(scroller) {
        const scrollWidth = Math.max(0, finiteNumber(scroller && scroller.scrollWidth) || 0);
        const clientWidth = Math.max(0, finiteNumber(scroller && scroller.clientWidth) || 0);
        const maximum = Math.max(0, scrollWidth - clientWidth);
        const scrollLeft = Math.min(maximum, Math.max(0, finiteNumber(scroller && scroller.scrollLeft) || 0));
        return {
            scrollLeft,
            maximum,
            measurable: scrollWidth > 0 && clientWidth > 0,
            overflow: maximum > 1,
            atStart: scrollLeft <= 2,
            atLatest: maximum - scrollLeft <= 8,
            distanceFromLatest: maximum - scrollLeft
        };
    }

    function formatTrendTickDate(value) {
        const date = new Date(value || '');
        if (!Number.isFinite(date.getTime())) {
            return 'Unknown';
        }
        return new Intl.DateTimeFormat(undefined, {
            month: 'short',
            day: 'numeric',
            year: '2-digit'
        }).format(date);
    }

    function trendItemContentOffset(scroller, item) {
        if (
            scroller
            && item
            && typeof scroller.getBoundingClientRect === 'function'
            && typeof item.getBoundingClientRect === 'function'
        ) {
            const scrollerRect = scroller.getBoundingClientRect();
            const itemRect = item.getBoundingClientRect();
            if (Number.isFinite(scrollerRect.left) && Number.isFinite(itemRect.left)) {
                return itemRect.left - scrollerRect.left + trendScrollMetrics(scroller).scrollLeft;
            }
        }
        return Math.max(0, finiteNumber(item && item.offsetLeft) || 0);
    }

    function rememberTrendScroll(scroller) {
        const playerKey = scroller && scroller.dataset ? scroller.dataset.playerKey : null;
        if (!playerKey) {
            return null;
        }
        const metrics = trendScrollMetrics(scroller);
        if (!metrics.measurable) {
            return trendScrollPositions.get(playerKey) || null;
        }
        const items = Array.from(scroller.children || []);
        const anchor = items.find(item => (
            trendItemContentOffset(scroller, item) + (finiteNumber(item.offsetWidth) || 0) > metrics.scrollLeft + 1
        ))
            || items.at(-1)
            || null;
        const anchorOffset = anchor ? trendItemContentOffset(scroller, anchor) : 0;
        const saved = {
            atLatest: metrics.atLatest,
            scrollLeft: metrics.scrollLeft,
            anchorObservedAt: anchor && anchor.dataset ? anchor.dataset.observedAt || null : null,
            anchorOffset: anchor ? metrics.scrollLeft - anchorOffset : 0,
            hadFocus: typeof document !== 'undefined' && document.activeElement === scroller
        };
        trendScrollPositions.set(playerKey, saved);
        return saved;
    }

    function disposeActiveTrendBinding() {
        if (!activeTrendBinding) {
            return;
        }
        const binding = activeTrendBinding;
        activeTrendBinding = null;
        if (binding.scroller && binding.scroller.isConnected && binding.hasMeasuredPosition()) {
            rememberTrendScroll(binding.scroller);
        }
        binding.cleanup();
    }

    function scrollTrendToLatest(scroller) {
        scroller.scrollLeft = trendScrollMetrics(scroller).maximum;
    }

    function bindTrendScroller({ scroller, viewport, latestButton, playerKey }) {
        const saved = trendScrollPositions.get(playerKey) || null;
        let frame = null;
        let resizeObserver = null;
        let resizeHandler = null;
        let scrollHandler = null;
        let hasMeasuredPosition = false;

        const sync = ({ remember = true } = {}) => {
            const metrics = trendScrollMetrics(scroller);
            hasMeasuredPosition = hasMeasuredPosition || metrics.measurable;
            viewport.dataset.canScrollLeft = String(metrics.overflow && !metrics.atStart);
            viewport.dataset.canScrollRight = String(metrics.overflow && !metrics.atLatest);
            latestButton.hidden = !metrics.overflow || metrics.distanceFromLatest <= 16;
            if (remember) {
                rememberTrendScroll(scroller);
            }
        };

        const latestClick = () => {
            scrollTrendToLatest(scroller);
            if (typeof scroller.focus === 'function') {
                scroller.focus({ preventScroll: true });
            }
            sync();
        };
        latestButton.addEventListener('click', latestClick);

        frame = global.requestAnimationFrame(() => {
            frame = null;
            if (!scroller.isConnected || !activeTrendBinding || activeTrendBinding.scroller !== scroller) {
                return;
            }
            const maximum = trendScrollMetrics(scroller).maximum;
            let target = maximum;
            if (saved && !saved.atLatest) {
                const anchor = Array.from(scroller.children || []).find(item => (
                    item.dataset && item.dataset.observedAt === saved.anchorObservedAt
                ));
                target = anchor
                    ? trendItemContentOffset(scroller, anchor) + saved.anchorOffset
                    : saved.scrollLeft;
            }
            scroller.scrollLeft = Math.min(maximum, Math.max(0, target));
            if (saved && saved.hadFocus && typeof scroller.focus === 'function') {
                scroller.focus({ preventScroll: true });
            }
            sync();
            scrollHandler = () => sync();
            scroller.addEventListener('scroll', scrollHandler, { passive: true });

            const preserveLatestOnResize = () => {
                const position = trendScrollPositions.get(playerKey);
                if (!position || position.atLatest) {
                    scroller.scrollLeft = trendScrollMetrics(scroller).maximum;
                }
                sync();
            };
            if (typeof global.ResizeObserver === 'function') {
                resizeObserver = new global.ResizeObserver(preserveLatestOnResize);
                resizeObserver.observe(scroller);
            } else {
                resizeHandler = preserveLatestOnResize;
                global.addEventListener('resize', resizeHandler);
            }
        });

        const cleanup = () => {
            if (frame !== null && typeof global.cancelAnimationFrame === 'function') {
                global.cancelAnimationFrame(frame);
                frame = null;
            }
            if (scrollHandler) {
                scroller.removeEventListener('scroll', scrollHandler);
            }
            latestButton.removeEventListener('click', latestClick);
            if (resizeObserver) {
                resizeObserver.disconnect();
            }
            if (resizeHandler) {
                global.removeEventListener('resize', resizeHandler);
            }
        };
        activeTrendBinding = {
            scroller,
            cleanup,
            hasMeasuredPosition: () => hasMeasuredPosition
        };
    }

    function trendPoints(trends) {
        let candidates = [];
        if (Array.isArray(trends)) {
            candidates = trends;
        } else if (isObject(trends)) {
            const possible = [trends.points, trends.history, trends.play_time, trends.playTime, trends.playtime];
            candidates = possible.find(Array.isArray) || [];
        }
        return candidates.map((point) => ({
            observedAt: nonEmptyString(point && point.observedAt, point && point.timestamp, point && point.date),
            value: finiteNumber(point && point.value, point && point.playtimeSeconds, point && point.total),
            delta: finiteNumber(point && point.delta, point && point.deltaSeconds),
            source: nonEmptyString(point && point.source) || 'snapshot',
            quality: nonEmptyString(point && point.quality) || 'observed',
            resetDetected: Boolean(point && point.resetDetected)
        })).filter((point) => point.observedAt && (point.value !== null || point.delta !== null))
            .sort((left, right) => {
                const leftTime = new Date(left.observedAt).getTime();
                const rightTime = new Date(right.observedAt).getTime();
                if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) {
                    return leftTime - rightTime;
                }
                if (Number.isFinite(leftTime)) return -1;
                if (Number.isFinite(rightTime)) return 1;
                return 0;
            });
    }

    function renderTrendSection(profile) {
        const section = createElement('section', 'player-center-section player-center-trends-section');
        const points = trendPoints(profile.trends);
        const heading = createElement('div', 'player-center-section-heading');
        heading.append(createElement('div', null, 'Playtime trend'));
        const headingActions = createElement('div', 'player-center-trend-heading-actions');
        const latestPoint = points.at(-1) || null;
        headingActions.appendChild(createElement(
            'span',
            'player-center-trend-latest-label',
            latestPoint ? `Latest ${formatDateTime(latestPoint.observedAt, { dateOnly: true })}` : 'Snapshot deltas'
        ));
        section.appendChild(heading);
        if (points.length < 2 && !points.some((point) => point.delta !== null)) {
            heading.appendChild(headingActions);
            section.appendChild(createStateCard('empty', 'More history is needed to show a trend.'));
            return section;
        }
        const latestButton = createButton('Latest →', 'player-center-trend-latest-button');
        latestButton.hidden = true;
        latestButton.setAttribute('aria-label', 'Jump to the latest playtime snapshot');
        headingActions.appendChild(latestButton);
        heading.appendChild(headingActions);
        const deltas = points.map((point, index) => {
            if (point.delta !== null) {
                return Math.max(0, point.delta);
            }
            if (index === 0 || point.value === null || points[index - 1].value === null) {
                return 0;
            }
            return Math.max(0, point.value - points[index - 1].value);
        });
        const max = Math.max(...deltas, 1);
        const viewport = createElement('div', 'player-center-trend-viewport');
        viewport.dataset.canScrollLeft = 'false';
        viewport.dataset.canScrollRight = 'false';
        const chart = createElement('div', 'player-center-trend-chart');
        chart.setAttribute('role', 'list');
        chart.tabIndex = 0;
        chart.dataset.playerKey = nonEmptyString(profile.player && profile.player.uuid, profile.player && profile.player.name) || 'profile';
        chart.setAttribute(
            'aria-label',
            `Playtime snapshot deltas from oldest to newest. Latest snapshot ${formatDateTime(latestPoint.observedAt, { dateOnly: true })}. Scroll horizontally for older snapshots.`
        );
        points.forEach((point, index) => {
            const item = createElement('div', 'player-center-trend-point');
            item.setAttribute('role', 'listitem');
            item.dataset.observedAt = point.observedAt;
            if (index === points.length - 1) {
                item.dataset.latest = 'true';
            }
            const seconds = deltas[index];
            const resetBaseline = point.resetDetected;
            const baseline = resetBaseline || (index === 0 && point.delta === null);
            const unchanged = !baseline && seconds === 0;
            const bar = createElement('span', 'player-center-trend-bar');
            bar.dataset.state = baseline ? 'baseline' : (unchanged ? 'unchanged' : 'changed');
            bar.style.setProperty('--trend-height', `${baseline || unchanged ? 2 : Math.max(5, Math.round((seconds / max) * 100))}%`);
            const valueLabel = resetBaseline
                ? 'New baseline after statistics reset'
                : (baseline ? 'Baseline observation' : (unchanged ? 'No change' : `${formatDuration(seconds, { compact: true })} added`));
            const label = `${formatDateTime(point.observedAt, { dateOnly: true })}: ${valueLabel}`;
            bar.setAttribute('aria-label', label);
            bar.title = label;
            item.append(
                bar,
                createElement('strong', null, baseline ? 'Baseline' : (unchanged ? 'No change' : formatDuration(seconds, { compact: true }))),
                createElement('span', null, formatTrendTickDate(point.observedAt))
            );
            chart.appendChild(item);
        });
        viewport.appendChild(chart);
        section.appendChild(viewport);
        bindTrendScroller({
            scroller: chart,
            viewport,
            latestButton,
            playerKey: chart.dataset.playerKey
        });
        return section;
    }

    function renderStatsSection(profile) {
        const section = createElement('section', 'player-center-section');
        const heading = createElement('div', 'player-center-section-heading');
        heading.append(createElement('div', null, 'Minecraft statistics'));
        heading.append(createElement('span', null, `${profile.stats.length} observed`));
        section.appendChild(heading);
        if (!profile.stats.length) {
            section.appendChild(createStateCard('empty', 'No statistics available', 'The player may predate retained stats files, or collection may not have run yet.'));
            return section;
        }
        const list = createElement('dl', 'player-center-stat-list');
        profile.stats.slice(0, 40).forEach((stat) => {
            const wrapper = createElement('div', 'player-center-stat-row');
            const key = statKey(stat);
            wrapper.append(createElement('dt', null, humanize(key)));
            wrapper.append(createElement('dd', null, formatStatValue(stat)));
            list.appendChild(wrapper);
        });
        section.appendChild(list);
        if (profile.stats.length > 40) {
            section.appendChild(createElement('p', 'player-center-section-note', `Showing 40 of ${profile.stats.length} statistics.`));
        }
        return section;
    }

    function renderAdvancementsSection(profile) {
        const section = createElement('section', 'player-center-section');
        const complete = profile.advancements.filter((advancement) => advancement.done !== false && advancement.completed !== false);
        const completedTotal = finiteNumber(profile.summary && profile.summary.completedAdvancements, complete.length);
        const heading = createElement('div', 'player-center-section-heading');
        heading.append(createElement('div', null, 'Advancements'));
        heading.append(createElement('span', null, `${completedTotal} completed`));
        section.appendChild(heading);
        if (!profile.advancements.length) {
            section.appendChild(createStateCard('empty', 'No advancement history available', 'Advancement files may not be present for this player.'));
            return section;
        }
        const list = createElement('div', 'player-center-event-list');
        profile.advancements.slice(0, 24).forEach((advancement) => {
            const row = createElement('article', 'player-center-event-row');
            row.dataset.pointerProfile = 'surface';
            const id = nonEmptyString(advancement.id, advancement.key, advancement.name) || 'Unknown advancement';
            const time = nonEmptyString(advancement.completedAt, advancement.observedAt, advancement.timestamp);
            const inProgress = advancement.done === false || advancement.completed === false;
            const criteriaCount = finiteNumber(advancement.criteriaCount);
            const copy = createElement('div');
            copy.append(createElement('strong', null, humanize(id)));
            copy.append(createElement('span', null, inProgress
                ? `${criteriaCount === null ? 'Some' : formatNumber(criteriaCount)} criteria observed${time ? ` · updated ${formatDateTime(time)}` : ''}`
                : (time ? `Completed ${formatDateTime(time)}` : 'Completion time not retained')));
            row.append(copy, createBadge(inProgress ? 'In progress' : 'Complete', inProgress ? 'neutral' : 'positive'));
            list.appendChild(row);
        });
        section.appendChild(list);
        return section;
    }

    function sessionPresentation(session = {}) {
        const startedAt = nonEmptyString(session.startedAt, session.joinedAt, session.start);
        const endedAt = nonEmptyString(session.endedAt, session.leftAt, session.end);
        const status = String(session.status || '').trim().toLowerCase();
        const endReason = String(session.endReason || '').trim().toLowerCase();
        const terminalReasons = new Set(['player_left', 'server_stopped', 'server_restarted']);
        const hasTerminalBoundary = Boolean(endedAt || terminalReasons.has(endReason));
        const durationValue = finiteNumber(session.durationSeconds);
        const calculatedDuration = startedAt && endedAt
            ? (new Date(endedAt).getTime() - new Date(startedAt).getTime()) / 1000
            : null;
        const duration = durationValue !== null ? durationValue : calculatedDuration;
        const durationBadge = duration !== null && Number.isFinite(duration) && duration >= 0
            ? formatDuration(duration, { compact: true })
            : 'Ended';

        // A missing end timestamp is historical uncertainty, not evidence that
        // the player is online. Only the backend's explicit active state may
        // produce the live treatment, and a terminal boundary always wins.
        if (status === 'active' && !hasTerminalBoundary) {
            return {
                startedAt,
                detail: 'Online now',
                badge: 'Live',
                tone: 'live'
            };
        }

        if (status === 'ended' || hasTerminalBoundary) {
            let detail = 'Ended';
            if (endReason === 'server_stopped') {
                detail = 'Ended when server stopped';
            } else if (endReason === 'server_restarted') {
                detail = 'Ended when server restarted';
            } else if (endReason === 'player_left') {
                detail = 'Left';
            }
            if (endedAt) {
                detail += ` · ${formatDateTime(endedAt)}`;
            }
            return {
                startedAt,
                detail,
                badge: durationBadge,
                tone: 'neutral'
            };
        }

        return {
            startedAt,
            detail: 'End time unavailable',
            badge: 'Incomplete',
            tone: 'neutral'
        };
    }

    function renderSessionsSection(profile) {
        const section = createElement('section', 'player-center-section');
        const heading = createElement('div', 'player-center-section-heading');
        heading.append(createElement('div', null, 'Recent sessions'));
        heading.append(createElement('span', null, `${profile.sessions.length} retained`));
        section.appendChild(heading);
        if (!profile.sessions.length) {
            section.appendChild(createStateCard('empty', 'No recent sessions found.'));
            return section;
        }
        const list = createElement('div', 'player-center-event-list');
        profile.sessions.slice(0, 20).forEach((session) => {
            const presentation = sessionPresentation(session);
            const row = createElement('article', 'player-center-event-row');
            row.dataset.pointerProfile = 'surface';
            const copy = createElement('div');
            copy.append(createElement('strong', null, presentation.startedAt
                ? formatDateTime(presentation.startedAt)
                : 'Observed session'));
            copy.append(createElement('span', null, presentation.detail));
            row.append(copy, createBadge(presentation.badge, presentation.tone));
            list.appendChild(row);
        });
        section.appendChild(list);
        return section;
    }

    function renderProfile() {
        disposeActiveTrendBinding();
        const fallback = playerByUuid(state.selectedUuid);
        const profile = state.profiles.get(state.selectedUuid);
        const view = createElement('div', 'player-center-profile');
        const back = createButton('', 'player-center-back-button');
        back.dataset.pointerProfile = 'anchored';
        const backVisual = createElement('span', 'player-center-pointer-visual player-center-back-button-visual');
        backVisual.appendChild(createElement('span', 'player-center-back-button-label', '← All players'));
        back.appendChild(backVisual);
        back.addEventListener('click', () => switchView('players'));
        view.appendChild(back);

        if (state.profileLoadingUuid === state.selectedUuid && !profile) {
            view.appendChild(createStateCard('loading', `Loading ${fallback ? fallback.name : 'player'} profile`, 'Collecting playtime, trends, statistics, advancements, and sessions.'));
            dom.view.replaceChildren(view);
            return;
        }
        if (!profile) {
            const error = state.profileErrors.get(state.selectedUuid);
            view.appendChild(createStateCard('error', 'Profile could not load', error || 'The player profile is temporarily unavailable.', {
                label: 'Retry',
                onClick: () => loadProfile(state.selectedUuid, { force: true })
            }));
            dom.view.replaceChildren(view);
            return;
        }

        const player = profile.player;
        const heading = createElement('div', 'player-center-profile-heading');
        const avatar = createPlayerAvatar(player, 'player-center-avatar-profile');
        const copy = createElement('div');
        const nameLine = createElement('div', 'player-center-profile-name-line');
        nameLine.append(createElement('h3', null, player.name));
        nameLine.append(createBadge(player.online ? 'Online' : 'Offline', player.online ? 'live' : 'neutral'));
        if (player.linkedToCurrentUser) {
            nameLine.append(createBadge('Linked to you', 'linked'));
        }
        copy.append(nameLine);
        copy.append(createElement('p', null, player.uuid || 'Legacy name-only record; UUID not reconciled yet.'));
        copy.append(createElement('small', null, `${player.online ? 'Online now' : humanize(player.source)} · updated ${formatRelativeTime(player.observedAt || player.lastSeenAt)}`));
        heading.append(avatar, copy);
        view.appendChild(heading);

        const profileError = state.profileErrors.get(state.selectedUuid);
        if (profileError) {
            view.appendChild(createStateCard('degraded', 'Some profile data is unavailable', profileError));
        }

        const activity = activityTimestampPresentation(player);
        const firstActivity = firstActivityTimestampPresentation(player);
        const retainedEvents = retainedEventPresentation(profile.summary);
        const cards = createElement('div', 'player-center-summary-grid');
        cards.append(
            summaryCard('Observed playtime', player.playtimeSeconds === null ? 'Not observed' : formatDuration(player.playtimeSeconds, { compact: true })),
            summaryCard('Current session', player.online && player.sessionStartedAt ? formatDuration((Date.now() - new Date(player.sessionStartedAt).getTime()) / 1000, { compact: true }) : (player.online ? 'Online' : 'Offline'), player.online ? 'Currently online' : activity.detail),
            summaryCard(
                'First-known activity',
                firstActivity.value,
                firstActivity.detail
            ),
            summaryCard('Retained log events', retainedEvents.value)
        );
        view.append(cards, renderTrendSection(profile), renderStatsSection(profile), renderAdvancementsSection(profile), renderSessionsSection(profile));
        dom.view.replaceChildren(view);
    }

    function normalizeLinkPayload(payload) {
        const envelope = isObject(payload && payload.data) ? payload.data : (isObject(payload) ? payload : {});
        const rawLink = isObject(envelope.link) ? envelope.link : (envelope.uuid || envelope.playerUuid ? envelope : null);
        if (!rawLink) {
            return null;
        }
        const uuid = nonEmptyString(rawLink.uuid, rawLink.playerUuid);
        const knownPlayer = playerByUuid(uuid);
        return {
            id: nonEmptyString(rawLink.id, rawLink.linkId),
            uuid,
            name: nonEmptyString(rawLink.name, rawLink.playerName, rawLink.currentName, knownPlayer && knownPlayer.name) || 'Linked player',
            verifiedAt: nonEmptyString(rawLink.verifiedAt, rawLink.createdAt),
            source: nonEmptyString(rawLink.source) || 'private_challenge'
        };
    }

    function normalizeChallengePayload(payload, selectedPlayer) {
        const envelope = isObject(payload && payload.data) ? payload.data : (isObject(payload) ? payload : {});
        const raw = isObject(envelope.challenge) ? envelope.challenge : envelope;
        return {
            id: nonEmptyString(raw.id, raw.challengeId),
            playerUuid: nonEmptyString(raw.playerUuid, raw.uuid, raw.player && raw.player.uuid, selectedPlayer && selectedPlayer.uuid),
            playerName: nonEmptyString(raw.playerName, raw.name, raw.player && raw.player.name, selectedPlayer && selectedPlayer.name) || 'the selected player',
            expiresAt: nonEmptyString(raw.expiresAt),
            deliveryState: nonEmptyString(raw.deliveryState, raw.delivery, raw.delivery && raw.delivery.state) || 'requested',
            deliveryStatus: nonEmptyString(raw.deliveryStatus) || 'complete'
        };
    }

    function renderLinkView() {
        const view = createElement('div', 'player-center-link-view');
        const heading = createElement('div', 'player-center-view-heading');
        const copy = createElement('div');
        copy.append(createElement('div', 'player-center-kicker', 'Verified identity'));
        copy.append(createElement('h3', null, 'Link your Minecraft player'));
        copy.append(createElement('p', null, 'Choose your live player, receive a private in-game code, then enter it here. Linking never grants panel administration or Minecraft operator access.'));
        heading.appendChild(copy);
        view.appendChild(heading);

        if (state.linkLoading && !state.linkLoaded) {
            view.appendChild(createStateCard('loading', 'Checking your player link', 'Looking for a verified Minecraft identity on this server.'));
            dom.view.replaceChildren(view);
            return;
        }
        if (state.linkUnavailable) {
            view.appendChild(createStateCard('unavailable', 'Account linking is not enabled yet', 'Live roster profiles still work. Linking will appear here when private challenges are available.'));
            dom.view.replaceChildren(view);
            return;
        }
        if (state.linkError && !state.linkLoaded) {
            view.appendChild(createStateCard('error', 'Could not check your link', state.linkError, {
                label: 'Retry',
                onClick: () => loadLink({ force: true })
            }));
            dom.view.replaceChildren(view);
            return;
        }
        if (state.link) {
            const linked = createElement('section', 'player-center-linked-card');
            const avatar = createPlayerAvatar({ uuid: state.link.playerUuid, name: state.link.name }, 'player-center-avatar-profile');
            const linkedCopy = createElement('div');
            linkedCopy.append(createElement('span', 'player-center-kicker', 'Linked player'));
            linkedCopy.append(createElement('strong', null, state.link.name));
            linkedCopy.append(createElement('span', null, state.link.uuid || 'UUID retained by the server'));
            linkedCopy.append(createElement('small', null, `Verified ${formatDateTime(state.link.verifiedAt)} · ${humanize(state.link.source)}`));
            linked.append(avatar, linkedCopy, createBadge('Verified', 'positive'));
            view.appendChild(linked);
            const safety = createElement('div', 'player-center-safety-note');
            safety.append(createElement('strong', null, 'What linking does'));
            safety.append(createElement('p', null, 'It enables “you” styling and player-specific features. It does not change whitelist, console, operator, filesystem, or admin permissions.'));
            view.appendChild(safety);
            const actions = createElement('div', 'player-center-inline-actions');
            if (state.confirmUnlink) {
                actions.append(createElement('span', null, `Unlink ${state.link.name}?`));
                const cancel = createButton('Keep link', 'player-center-secondary-button');
                cancel.addEventListener('click', () => {
                    state.confirmUnlink = false;
                    renderLinkView();
                });
                const confirm = createButton(state.linkPending ? 'Unlinking…' : 'Confirm unlink', 'player-center-danger-button');
                confirm.disabled = state.linkPending;
                confirm.addEventListener('click', unlinkPlayer);
                actions.append(cancel, confirm);
            } else {
                const unlink = createButton('Unlink player', 'player-center-secondary-button');
                unlink.addEventListener('click', () => {
                    state.confirmUnlink = true;
                    renderLinkView();
                });
                actions.appendChild(unlink);
            }
            view.appendChild(actions);
            dom.view.replaceChildren(view);
            return;
        }

        if (state.challenge && state.challenge.id) {
            const challenge = createElement('section', 'player-center-challenge-card');
            challenge.append(createElement('span', 'player-center-step-number', '2'));
            const challengeCopy = createElement('div');
            challengeCopy.append(createElement('h4', null, `Check Minecraft as ${state.challenge.playerName}`));
            challengeCopy.append(createElement('p', null, 'A short-lived code was requested through the trusted server connection. Enter exactly what appeared in your private in-game message.'));
            if (state.challenge.deliveryStatus === 'degraded') {
                challengeCopy.append(createElement('p', 'player-center-warning-copy', 'The request was committed, but its delivery receipt could not be saved. Use the code you received; do not request a second code.'));
            }
            challengeCopy.append(createElement('small', null, state.challenge.expiresAt
                ? `Expires ${formatRelativeTime(state.challenge.expiresAt)} · delivery ${humanize(state.challenge.deliveryState)}`
                : `Delivery ${humanize(state.challenge.deliveryState)}`));
            challenge.appendChild(challengeCopy);
            const form = createElement('form', 'player-center-code-form');
            const label = createElement('label', null, 'Private verification code');
            label.htmlFor = 'player-center-link-code';
            const input = createElement('input');
            input.id = 'player-center-link-code';
            input.name = 'code';
            input.type = 'text';
            input.autocomplete = 'one-time-code';
            input.spellcheck = false;
            input.required = true;
            input.disabled = state.linkPending;
            const verify = createButton(state.linkPending ? 'Verifying…' : 'Verify player', 'player-center-primary-button');
            verify.type = 'submit';
            verify.disabled = state.linkPending;
            form.append(label, input, verify);
            form.addEventListener('submit', verifyChallenge);
            view.append(challenge, form);
            if (state.linkError) {
                view.appendChild(createStateCard('error', 'Verification did not complete', state.linkError));
            }
            dom.view.replaceChildren(view);
            return;
        }

        const onlinePlayers = authoritativeOnlinePlayers(state.list);
        state.linkRosterSignature = linkRosterSignature(state.list);
        const step = createElement('section', 'player-center-challenge-card');
        step.append(createElement('span', 'player-center-step-number', '1'));
        const stepCopy = createElement('div');
        stepCopy.append(createElement('h4', null, 'Choose yourself from the live roster'));
        stepCopy.append(createElement('p', null, 'The server binds the challenge to this UUID. A typed name in the browser can never claim an identity.'));
        step.appendChild(stepCopy);
        view.appendChild(step);
        if (!onlinePlayers.length) {
            view.appendChild(createStateCard('empty', 'No verified online players available', 'Join the Minecraft server, wait for the roster to show Live, then refresh.'));
        } else {
            const form = createElement('form', 'player-center-link-form');
            const label = createElement('label', null, 'Your online player');
            label.htmlFor = 'player-center-link-player';
            const select = createElement('select');
            select.id = 'player-center-link-player';
            select.name = 'playerUuid';
            select.required = true;
            onlinePlayers.forEach((player) => {
                const option = createElement('option', null, player.name);
                option.value = player.uuid;
                select.appendChild(option);
            });
            const submit = createButton(state.linkPending ? 'Sending privately…' : 'Send private code', 'player-center-primary-button');
            submit.id = 'player-center-link-submit';
            submit.type = 'submit';
            submit.disabled = state.linkPending;
            form.append(label, select, submit);
            form.addEventListener('submit', requestChallenge);
            view.appendChild(form);
        }
        if (state.linkError) {
            view.appendChild(createStateCard('error', 'Challenge could not start', state.linkError));
        }
        const note = createElement('div', 'player-center-safety-note');
        note.append(createElement('strong', null, 'Why not NameMC alone?'));
        note.append(createElement('p', null, 'Minecraft names can be reassigned to another person. External name history can only suggest a candidate; matching authenticated server UUID evidence plus the private code is required for a panel link.'));
        view.appendChild(note);
        dom.view.replaceChildren(view);
    }

    function refreshLinkRosterViewIfNeeded() {
        if (state.activeView !== 'link'
            || state.linkLoading
            || !state.linkLoaded
            || state.linkUnavailable
            || state.link
            || state.challenge
            || state.linkPending) {
            return;
        }
        const nextSignature = linkRosterSignature(state.list);
        if (nextSignature === state.linkRosterSignature) {
            return;
        }
        const previousSelect = document.getElementById('player-center-link-player');
        const selectedUuid = previousSelect && previousSelect.value;
        const activeElement = document.activeElement;
        const restoreSelector = activeElement === previousSelect
            ? '#player-center-link-player'
            : (activeElement && activeElement.id === 'player-center-link-submit'
                ? '#player-center-link-submit'
                : null);
        renderLinkView();
        const nextSelect = document.getElementById('player-center-link-player');
        if (nextSelect && selectedUuid && Array.from(nextSelect.options).some(option => option.value === selectedUuid)) {
            nextSelect.value = selectedUuid;
        }
        if (restoreSelector) {
            const nextFocus = document.querySelector(restoreSelector);
            if (nextFocus && typeof nextFocus.focus === 'function') {
                nextFocus.focus({ preventScroll: true });
            }
        }
    }

    function normalizeGrantsPayload(payload) {
        const envelope = isObject(payload && payload.data) ? payload.data : payload;
        const raw = Array.isArray(envelope) ? envelope : (isObject(envelope) && Array.isArray(envelope.grants) ? envelope.grants : []);
        return raw.map((grant) => ({
            id: nonEmptyString(grant.id, grant.grantId),
            playerUuid: nonEmptyString(grant.playerUuid, grant.uuid),
            playerName: nonEmptyString(grant.playerName, grant.name, grant.currentName) || 'Unknown player',
            kind: nonEmptyString(grant.kind, grant.type) || (grant.expiresAt ? 'temporary' : 'permanent'),
            startsAt: nonEmptyString(grant.startsAt, grant.startAt, grant.createdAt),
            expiresAt: nonEmptyString(grant.expiresAt, grant.endAt),
            sponsor: nonEmptyString(grant.sponsor, grant.sponsorName, grant.sponsoredBy),
            reason: nonEmptyString(grant.reason),
            status: nonEmptyString(grant.status, grant.state) || 'pending',
            ownership: nonEmptyString(grant.ownership, grant.owner) || 'unknown',
            observedAllowlisted: grant.observedAllowlisted === undefined ? null : Boolean(grant.observedAllowlisted)
        }));
    }

    function renderAccessView() {
        const view = createElement('div', 'player-center-access-view');
        const heading = createElement('div', 'player-center-view-heading');
        const copy = createElement('div');
        copy.append(createElement('div', 'player-center-kicker', 'Typed and audited'));
        copy.append(createElement('h3', null, 'Access management'));
        copy.append(createElement('p', null, 'Create permanent or expiring whitelist grants without taking ownership of entries managed outside this panel.'));
        heading.appendChild(copy);
        view.appendChild(heading);
        if (!canManageAccess()) {
            view.appendChild(createStateCard('unavailable', 'Permission required', 'Your panel account cannot manage player access.'));
            dom.view.replaceChildren(view);
            return;
        }
        if (state.grantsLoading && !state.grantsLoaded) {
            view.appendChild(createStateCard('loading', 'Loading access grants', 'Comparing desired panel grants with the observed Minecraft allowlist.'));
            dom.view.replaceChildren(view);
            return;
        }
        if (state.grantsUnavailable) {
            view.appendChild(createStateCard('unavailable', 'Access management is not enabled yet', 'Existing whitelist entries remain untouched. This view will activate with the durable grant reconciler.'));
            dom.view.replaceChildren(view);
            return;
        }
        if (state.grantsError && !state.grantsLoaded) {
            view.appendChild(createStateCard('error', 'Could not load access grants', state.grantsError, {
                label: 'Retry',
                onClick: () => loadGrants({ force: true })
            }));
            dom.view.replaceChildren(view);
            return;
        }

        const safety = createElement('div', 'player-center-safety-note');
        safety.append(createElement('strong', null, 'Ownership rule'));
        safety.append(createElement('p', null, 'The panel may revoke only entries it can prove it introduced. Manual whitelist changes are displayed as drift, never silently overwritten.'));
        view.appendChild(safety);

        const formSection = createElement('section', 'player-center-section');
        const formHeading = createElement('div', 'player-center-section-heading');
        formHeading.append(createElement('div', null, 'New access grant'));
        formHeading.append(createElement('span', null, 'Audited operation'));
        formSection.appendChild(formHeading);
        const resolvedPlayers = state.list ? state.list.players.filter((player) => player.uuid && player.nameResolved) : [];
        if (!resolvedPlayers.length) {
            formSection.appendChild(createStateCard('empty', 'No UUID-backed players available', 'A grant needs a locally reconciled Minecraft UUID.'));
        } else {
            const form = createElement('form', 'player-center-access-form');
            const playerLabel = createElement('label', null, 'Player');
            const playerSelect = createElement('select');
            playerSelect.name = 'playerUuid';
            playerSelect.required = true;
            resolvedPlayers.forEach((player) => {
                const option = createElement('option', null, player.name);
                option.value = player.uuid;
                playerSelect.appendChild(option);
            });
            if (state.grantDraft && resolvedPlayers.some(player => player.uuid === state.grantDraft.playerUuid)) {
                playerSelect.value = state.grantDraft.playerUuid;
            }
            playerLabel.appendChild(playerSelect);
            const kindLabel = createElement('label', null, 'Grant type');
            const kindSelect = createElement('select');
            kindSelect.name = 'kind';
            const permanent = createElement('option', null, 'Permanent');
            permanent.value = 'permanent';
            const temporary = createElement('option', null, 'Temporary guest');
            temporary.value = 'temporary';
            kindSelect.append(permanent, temporary);
            kindSelect.value = state.grantDraft && state.grantDraft.kind === 'temporary' ? 'temporary' : 'permanent';
            kindLabel.appendChild(kindSelect);
            const startLabel = createElement('label', null, 'Starts (optional)');
            const startInput = createElement('input');
            startInput.type = 'datetime-local';
            startInput.name = 'startsAt';
            startInput.value = state.grantDraft ? state.grantDraft.startsAt : '';
            startLabel.appendChild(startInput);
            const expiryLabel = createElement(
                'label',
                `player-center-expiry-field${kindSelect.value === 'temporary' ? '' : ' hidden'}`,
                'Expires'
            );
            const expiryInput = createElement('input');
            expiryInput.type = 'datetime-local';
            expiryInput.name = 'expiresAt';
            expiryInput.value = state.grantDraft ? state.grantDraft.expiresAt : '';
            expiryInput.required = kindSelect.value === 'temporary';
            expiryLabel.appendChild(expiryInput);
            const sponsorLabel = createElement('label', null, 'Sponsor');
            const sponsorInput = createElement('input');
            sponsorInput.name = 'sponsor';
            sponsorInput.value = state.grantDraft
                ? state.grantDraft.sponsor
                : (state.user && state.user.username ? state.user.username : '');
            sponsorInput.required = true;
            sponsorLabel.appendChild(sponsorInput);
            const reasonLabel = createElement('label', 'player-center-reason-field', 'Reason');
            const reasonInput = createElement('input');
            reasonInput.name = 'reason';
            reasonInput.placeholder = 'Why access is being granted';
            reasonInput.value = state.grantDraft ? state.grantDraft.reason : '';
            reasonInput.required = true;
            reasonLabel.appendChild(reasonInput);
            const submit = createButton(state.grantPending ? 'Saving…' : 'Create grant', 'player-center-primary-button');
            submit.type = 'submit';
            submit.disabled = state.grantPending;
            [playerSelect, kindSelect, startInput, expiryInput, sponsorInput, reasonInput].forEach((control) => {
                control.disabled = state.grantPending;
            });
            kindSelect.addEventListener('change', () => {
                const isTemporary = kindSelect.value === 'temporary';
                expiryLabel.classList.toggle('hidden', !isTemporary);
                expiryInput.required = isTemporary;
            });
            form.append(playerLabel, kindLabel, startLabel, expiryLabel, sponsorLabel, reasonLabel, submit);
            form.addEventListener('submit', createGrant);
            formSection.appendChild(form);
        }
        view.appendChild(formSection);

        const grantsSection = createElement('section', 'player-center-section');
        const grantsHeading = createElement('div', 'player-center-section-heading');
        grantsHeading.append(createElement('div', null, 'Current grants'));
        grantsHeading.append(createElement('span', null, `${state.grants.length} retained`));
        grantsSection.appendChild(grantsHeading);
        if (!state.grants.length) {
            grantsSection.appendChild(createStateCard('empty', 'No panel grants', 'Externally managed whitelist entries remain outside panel ownership.'));
        } else {
            const list = createElement('div', 'player-center-grant-list');
            state.grants.forEach((grant) => {
                const row = createElement('article', 'player-center-grant-card');
                const rowHeading = createElement('div', 'player-center-grant-heading');
                const rowCopy = createElement('div');
                rowCopy.append(createElement('strong', null, grant.playerName));
                rowCopy.append(createElement('span', null, `${humanize(grant.kind)} · ${grant.expiresAt ? `expires ${formatDateTime(grant.expiresAt)}` : 'no expiration'}`));
                rowHeading.append(rowCopy, createBadge(humanize(grant.status), grant.status.toLowerCase()));
                row.appendChild(rowHeading);
                const facts = createElement('dl', 'player-center-grant-facts');
                [
                    ['Ownership', humanize(grant.ownership)],
                    ['Sponsor', grant.sponsor || 'Not recorded'],
                    ['Reason', grant.reason || 'Not recorded'],
                    ['Observed allowlist', grant.observedAllowlisted === null ? 'Not reconciled' : (grant.observedAllowlisted ? 'Present' : 'Missing')]
                ].forEach(([label, value]) => {
                    const fact = createElement('div');
                    fact.append(createElement('dt', null, label), createElement('dd', null, value));
                    facts.appendChild(fact);
                });
                row.appendChild(facts);
                const actions = createElement('div', 'player-center-inline-actions');
                const panelOwned = grant.ownership.toLowerCase() === 'panel';
                if (panelOwned && grant.kind.toLowerCase().includes('temp') && grant.status !== 'revoked') {
                    const extend = createButton('Extend 24h', 'player-center-secondary-button');
                    extend.disabled = state.grantPending;
                    extend.addEventListener('click', () => extendGrant(grant));
                    actions.appendChild(extend);
                }
                if (panelOwned && ['drifted', 'failed'].includes(grant.status.toLowerCase())) {
                    const reconcile = createButton('Reconcile', 'player-center-secondary-button');
                    reconcile.disabled = state.grantPending;
                    reconcile.addEventListener('click', () => patchGrant(grant.id, { action: 'reconcile' }, 'Reconciliation requested.'));
                    actions.appendChild(reconcile);
                }
                if (panelOwned && !['revoked', 'expired'].includes(grant.status.toLowerCase())) {
                    if (state.confirmGrantId === grant.id) {
                        actions.appendChild(createElement('span', null, `Revoke ${grant.playerName}?`));
                        const keep = createButton('Keep', 'player-center-secondary-button');
                        keep.addEventListener('click', () => {
                            state.confirmGrantId = null;
                            renderAccessView();
                        });
                        const confirm = createButton('Confirm revoke', 'player-center-danger-button');
                        confirm.disabled = state.grantPending;
                        confirm.addEventListener('click', () => patchGrant(grant.id, { status: 'revoked' }, 'Grant revoked.'));
                        actions.append(keep, confirm);
                    } else {
                        const revoke = createButton('Revoke', 'player-center-secondary-button');
                        revoke.disabled = state.grantPending;
                        revoke.addEventListener('click', () => {
                            state.confirmGrantId = grant.id;
                            renderAccessView();
                        });
                        actions.appendChild(revoke);
                    }
                }
                if (!panelOwned) {
                    actions.appendChild(createElement('span', 'player-center-external-label', 'Externally managed · read only'));
                }
                if (actions.childNodes.length) {
                    row.appendChild(actions);
                }
                list.appendChild(row);
            });
            grantsSection.appendChild(list);
        }
        view.appendChild(grantsSection);
        if (state.grantsError) {
            view.appendChild(createStateCard('degraded', 'Latest access operation needs attention', state.grantsError));
        }
        dom.view.replaceChildren(view);
    }

    function renderNotice() {
        if (!dom.viewStatus) {
            return;
        }
        dom.viewStatus.textContent = state.notice ? state.notice.message : '';
        dom.viewStatus.dataset.state = state.notice ? state.notice.kind : '';
        dom.viewStatus.classList.toggle('hidden', !state.notice);
    }

    function renderView() {
        renderNav();
        renderNotice();
        if (state.activeView !== 'profile') {
            disposeActiveTrendBinding();
        }
        if (state.activeView === 'profile') {
            renderProfile();
        } else if (state.activeView === 'link') {
            renderLinkView();
        } else if (state.activeView === 'access') {
            renderAccessView();
        } else {
            renderPlayersOverview();
        }
    }

    function renderAll() {
        renderHeader();
        renderNav();
        renderSidebar();
        renderView();
    }

    function applyListPayload(payload, { realtime = false } = {}) {
        const normalized = normalizeListPayload(payload);
        if (normalized.serverId !== SERVER_ID) {
            return false;
        }
        if (state.list && isStaleRosterSnapshot({
            nextRevision: normalized.revision,
            currentRevision: state.lastRevision,
            nextObservedAt: normalized.roster.observedAt || normalized.observedAt,
            currentObservedAt: state.list.roster.observedAt || state.list.observedAt,
            realtime
        })) {
            return false;
        }
        const previousSignature = listContentSignature(state.list);
        state.list = realtime ? overlayRealtimeRoster(state.list, normalized) : normalized;
        const contentChanged = previousSignature !== listContentSignature(state.list);
        state.lastRevision = normalized.revision !== null ? normalized.revision : state.lastRevision;
        state.listError = null;
        state.listUnavailable = false;
        if (realtime) {
            state.socketConnected = true;
        }
        reconcileCachedProfilesFromList();
        renderHeader();
        if (contentChanged) {
            renderSidebar();
            if (state.activeView === 'players') {
                renderPlayersOverview();
            }
        }
        refreshLinkRosterViewIfNeeded();
        return true;
    }

    async function loadRoster({ force = false } = {}) {
        if (state.listLoading && !force) {
            return;
        }
        if (rosterController) {
            rosterController.abort();
        }
        const controller = new AbortController();
        rosterController = controller;
        state.listLoading = true;
        if (!state.list) {
            renderAll();
        } else {
            renderHeader();
        }
        try {
            const payload = await apiRequest('/players', { signal: controller.signal });
            if (rosterController !== controller) {
                return;
            }
            applyListPayload(payload);
        } catch (error) {
            if (error && error.name === 'AbortError') {
                return;
            }
            if (rosterController !== controller) {
                return;
            }
            state.listUnavailable = error instanceof ApiError && (error.status === 404 || error.status === 501);
            state.listError = error instanceof ApiError ? error.message : 'The player roster request could not reach the server.';
            renderHeader();
            renderSidebar();
            if (state.activeView === 'players') {
                renderPlayersOverview();
            }
        } finally {
            if (rosterController === controller) {
                state.listLoading = false;
                rosterController = null;
                renderHeader();
                schedulePoll();
            }
        }
    }

    async function loadProfile(uuid, { force = false } = {}) {
        if (!uuid) {
            return;
        }
        if (!force && state.profiles.has(uuid)) {
            renderProfile();
            return;
        }
        if (profileController) {
            profileController.abort();
        }
        const controller = new AbortController();
        profileController = controller;
        state.profileLoadingUuid = uuid;
        state.profileErrors.delete(uuid);
        renderProfile();
        try {
            const encodedUuid = encodeURIComponent(uuid);
            const [profileResult, trendsResult] = await Promise.allSettled([
                apiRequest(`/players/${encodedUuid}`, { signal: controller.signal }),
                apiRequest(`/players/${encodedUuid}/trends?metric=play_time`, { signal: controller.signal })
            ]);
            if (profileController !== controller) {
                return;
            }
            if (profileResult.status === 'rejected') {
                throw profileResult.reason;
            }
            const trends = trendsResult.status === 'fulfilled' ? trendsResult.value : null;
            state.profiles.set(uuid, normalizeProfilePayload(profileResult.value, playerByUuid(uuid), trends));
            if (trendsResult.status === 'rejected' && trendsResult.reason && trendsResult.reason.name !== 'AbortError') {
                state.profileErrors.set(uuid, 'Playtime totals loaded, but the trend series is temporarily unavailable.');
            }
        } catch (error) {
            if (error && error.name === 'AbortError') {
                return;
            }
            if (profileController !== controller) {
                return;
            }
            state.profileErrors.set(uuid, error instanceof ApiError ? error.message : 'The profile request could not reach the server.');
        } finally {
            if (profileController === controller) {
                if (state.profileLoadingUuid === uuid) {
                    state.profileLoadingUuid = null;
                }
                profileController = null;
                if (state.activeView === 'profile' && state.selectedUuid === uuid) {
                    renderProfile();
                }
            }
        }
    }

    async function loadLink({ force = false } = {}) {
        if ((state.linkLoaded || state.linkLoading) && !force) {
            return;
        }
        state.linkLoading = true;
        state.linkError = null;
        renderLinkView();
        try {
            const payload = await apiRequest('/player-links/me');
            state.link = normalizeLinkPayload(payload);
            state.linkLoaded = true;
            state.linkUnavailable = false;
        } catch (error) {
            state.linkUnavailable = error instanceof ApiError && (error.status === 404 || error.status === 501);
            state.linkError = error instanceof ApiError ? error.message : 'The player-link request could not reach the server.';
        } finally {
            state.linkLoading = false;
            if (state.activeView === 'link') {
                renderLinkView();
            }
        }
    }

    async function requestChallenge(event) {
        event.preventDefault();
        if (state.linkPending) {
            return;
        }
        const formData = new FormData(event.currentTarget);
        const playerUuid = String(formData.get('playerUuid') || '');
        const selectedPlayer = authoritativeOnlinePlayers(state.list)
            .find((player) => player.uuid === playerUuid);
        if (!selectedPlayer) {
            state.linkError = 'Choose a player from a fresh, authoritative live roster.';
            renderLinkView();
            return;
        }
        state.linkPending = true;
        state.linkError = null;
        renderLinkView();
        try {
            const payload = await apiRequest('/player-links/challenges', {
                method: 'POST',
                body: { playerUuid }
            });
            state.challenge = normalizeChallengePayload(payload, selectedPlayer);
            if (!state.challenge.id) {
                throw new ApiError('The server did not return a usable challenge.', 502, payload);
            }
        } catch (error) {
            state.linkError = error instanceof ApiError ? error.message : 'The private challenge could not be delivered.';
        } finally {
            state.linkPending = false;
            renderLinkView();
            const input = document.getElementById('player-center-link-code');
            if (input) {
                input.focus();
            } else if (state.linkError) {
                focusAfterRender('#player-center-link-player');
            }
        }
    }

    async function verifyChallenge(event) {
        event.preventDefault();
        if (state.linkPending || !state.challenge || !state.challenge.id) {
            return;
        }
        const formData = new FormData(event.currentTarget);
        const code = String(formData.get('code') || '').trim();
        if (!code) {
            state.linkError = 'Enter the private code from Minecraft.';
            renderLinkView();
            return;
        }
        state.linkPending = true;
        state.linkError = null;
        renderLinkView();
        try {
            const payload = await apiRequest(`/player-links/challenges/${encodeURIComponent(state.challenge.id)}/verify`, {
                method: 'POST',
                body: { code }
            });
            state.link = normalizeLinkPayload(payload);
            state.challenge = null;
            state.linkLoaded = true;
            state.notice = { kind: 'success', message: 'Minecraft identity linked successfully.' };
            await loadRoster({ force: true });
        } catch (error) {
            state.linkError = error instanceof ApiError ? error.message : 'The code could not be verified.';
        } finally {
            state.linkPending = false;
            renderNotice();
            renderLinkView();
            focusAfterRender(state.linkError ? '#player-center-link-code' : '.player-center-link-view button');
        }
    }

    async function unlinkPlayer() {
        if (state.linkPending) {
            return;
        }
        state.linkPending = true;
        renderLinkView();
        try {
            await apiRequest('/player-links/me', { method: 'DELETE' });
            state.link = null;
            state.challenge = null;
            state.confirmUnlink = false;
            state.notice = { kind: 'success', message: 'Minecraft identity unlinked.' };
            await loadRoster({ force: true });
        } catch (error) {
            state.linkError = error instanceof ApiError ? error.message : 'The link could not be removed.';
        } finally {
            state.linkPending = false;
            renderNotice();
            renderLinkView();
        }
    }

    async function loadGrants({ force = false } = {}) {
        if ((state.grantsLoaded || state.grantsLoading) && !force) {
            return;
        }
        state.grantsLoading = true;
        state.grantsError = null;
        renderAccessView();
        try {
            const payload = await apiRequest('/access-grants');
            state.grants = normalizeGrantsPayload(payload);
            state.grantsLoaded = true;
            state.grantsUnavailable = false;
        } catch (error) {
            state.grantsUnavailable = error instanceof ApiError && (error.status === 404 || error.status === 501);
            state.grantsError = error instanceof ApiError ? error.message : 'The grant request could not reach the server.';
        } finally {
            state.grantsLoading = false;
            if (state.activeView === 'access') {
                renderAccessView();
            }
        }
    }

    function localDateToIso(value) {
        if (!value) {
            return null;
        }
        const date = new Date(value);
        return Number.isFinite(date.getTime()) ? date.toISOString() : null;
    }

    async function createGrant(event) {
        event.preventDefault();
        if (state.grantPending) {
            return;
        }
        const formData = new FormData(event.currentTarget);
        const kind = String(formData.get('kind') || 'permanent');
        const draft = {
            playerUuid: String(formData.get('playerUuid') || ''),
            kind,
            startsAt: String(formData.get('startsAt') || ''),
            expiresAt: String(formData.get('expiresAt') || ''),
            sponsor: String(formData.get('sponsor') || '').trim(),
            reason: String(formData.get('reason') || '').trim()
        };
        state.grantDraft = draft;
        const expiresAt = localDateToIso(draft.expiresAt);
        if (kind === 'temporary' && !expiresAt) {
            state.grantsError = 'Temporary guest access requires a valid expiration.';
            renderAccessView();
            return;
        }
        const body = {
            playerUuid: draft.playerUuid,
            kind,
            startsAt: localDateToIso(draft.startsAt),
            expiresAt: kind === 'temporary' ? expiresAt : null,
            sponsor: draft.sponsor,
            reason: draft.reason
        };
        if (!body.playerUuid || !body.sponsor || !body.reason) {
            state.grantsError = 'Player, sponsor, and reason are required.';
            renderAccessView();
            return;
        }
        state.grantPending = true;
        state.grantsError = null;
        const bodySignature = JSON.stringify(body);
        if (!state.grantSubmission || state.grantSubmission.bodySignature !== bodySignature) {
            state.grantSubmission = { bodySignature, key: newIdempotencyKey() };
        }
        const idempotencyKey = state.grantSubmission.key;
        renderAccessView();
        try {
            const payload = await apiRequest('/access-grants', {
                method: 'POST',
                body,
                headers: { 'Idempotency-Key': idempotencyKey }
            });
            const result = isObject(payload && payload.data) ? payload.data : payload;
            state.notice = result && result.reconciliationStatus === 'degraded'
                ? { kind: 'warning', message: 'Access grant saved. Minecraft reconciliation is degraded and will retry automatically.' }
                : {
                    kind: 'success',
                    message: result && result.deduplicated
                        ? 'This access grant was already saved; no duplicate was created.'
                        : 'Access grant saved and reconciled.'
                };
            state.grantDraft = null;
            state.grantSubmission = null;
            await loadGrants({ force: true });
        } catch (error) {
            state.grantsError = error instanceof ApiError ? error.message : 'The grant could not be created.';
        } finally {
            state.grantPending = false;
            renderNotice();
            renderAccessView();
            focusAfterRender('.player-center-access-form select, .player-center-access-form input, #player-center-access-nav');
        }
    }

    async function patchGrant(id, body, successMessage) {
        if (!id || state.grantPending) {
            return;
        }
        state.grantPending = true;
        state.grantsError = null;
        renderAccessView();
        try {
            await apiRequest(`/access-grants/${encodeURIComponent(id)}`, { method: 'PATCH', body });
            state.confirmGrantId = null;
            state.notice = { kind: 'success', message: successMessage };
            await loadGrants({ force: true });
        } catch (error) {
            state.grantsError = error instanceof ApiError ? error.message : 'The access grant could not be updated.';
        } finally {
            state.grantPending = false;
            renderNotice();
            renderAccessView();
            focusAfterRender('.player-center-grant-list button, #player-center-access-nav');
        }
    }

    function extendGrant(grant) {
        const baseline = grant.expiresAt && Number.isFinite(new Date(grant.expiresAt).getTime())
            ? Math.max(Date.now(), new Date(grant.expiresAt).getTime())
            : Date.now();
        patchGrant(grant.id, { expiresAt: new Date(baseline + 24 * 60 * 60 * 1000).toISOString() }, 'Guest access extended by 24 hours.');
    }

    async function recordLegacyCandidate(event, name) {
        event.preventDefault();
        if (!isAdmin() || state.legacyPendingName) {
            return;
        }
        const formData = new FormData(event.currentTarget);
        const uuid = String(formData.get('uuid') || '').trim().toLowerCase();
        const uuidPattern = /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
        if (!uuidPattern.test(uuid)) {
            state.legacyErrors.set(name, 'Enter a complete UUID from the NameMC result.');
            renderPlayersOverview();
            return;
        }
        state.legacyPendingName = name;
        state.legacyErrors.delete(name);
        renderPlayersOverview();
        try {
            await apiRequest('/players/legacy-identities/resolve', {
                method: 'POST',
                body: { name, uuid, source: 'namemc' }
            });
            state.notice = {
                kind: 'warning',
                message: `${name} now has an unverified NameMC candidate. It is not an account link or access proof.`
            };
            await loadRoster({ force: true });
        } catch (error) {
            state.legacyErrors.set(name, error instanceof ApiError ? error.message : 'The external identity candidate could not be recorded.');
        } finally {
            state.legacyPendingName = null;
            renderNotice();
            if (state.activeView === 'players') {
                renderPlayersOverview();
            }
        }
    }

    function selectPlayer(player) {
        if (!player || !player.uuid) {
            state.notice = { kind: 'warning', message: `${player ? player.name : 'This record'} is still a legacy name-only entry and cannot open a UUID profile yet.` };
            renderNotice();
            return;
        }
        state.selectedUuid = player.uuid;
        state.activeView = 'profile';
        state.notice = null;
        renderAll();
        loadProfile(player.uuid);
        dom.content.scrollTop = 0;
        dom.content.focus({ preventScroll: true });
    }

    function switchView(view) {
        if (!['players', 'link', 'access'].includes(view)) {
            return;
        }
        if (view === 'access' && !canManageAccess()) {
            return;
        }
        state.activeView = view;
        state.selectedUuid = null;
        state.notice = null;
        renderAll();
        dom.content.scrollTop = 0;
        if (view === 'link') {
            loadLink();
        } else if (view === 'access') {
            loadGrants();
        }
    }

    function isMobile() {
        return Boolean(mobileQuery && mobileQuery.matches);
    }

    function setBackgroundInert(enabled) {
        if (enabled) {
            focusTrapRecords = [];
            Array.from(document.body.children).forEach((node) => {
                if (node === dom.shell || node.tagName === 'SCRIPT') {
                    return;
                }
                focusTrapRecords.push({
                    node,
                    inert: Boolean(node.inert),
                    ariaHidden: node.getAttribute('aria-hidden')
                });
                node.inert = true;
                node.setAttribute('aria-hidden', 'true');
            });
            return;
        }
        focusTrapRecords.forEach(({ node, inert, ariaHidden }) => {
            if (!node.isConnected) {
                return;
            }
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
        if (!dom.panel) {
            return;
        }
        const mobile = isMobile();
        if (mobile) {
            dom.panel.setAttribute('aria-modal', 'true');
        } else {
            dom.panel.removeAttribute('aria-modal');
        }
        document.body.classList.toggle('player-center-mobile-open', state.open && mobile);
        setBackgroundInert(state.open && mobile);
    }

    function focusableElements() {
        if (!dom.panel) {
            return [];
        }
        return Array.from(dom.panel.querySelectorAll(
            'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
        )).filter((node) => !node.closest('.hidden') && node.getClientRects().length > 0);
    }

    function handlePanelKeydown(event) {
        if (!state.open) {
            return;
        }
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
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
        const chatToggle = document.getElementById('server-chat-toggle');
        if (isMobile() && document.body.classList.contains('server-chat-open') && chatToggle) {
            chatToggle.click();
        }
        state.open = true;
        document.body.classList.add('player-center-open');
        dom.shell.classList.remove('hidden');
        dom.shell.setAttribute('aria-hidden', 'false');
        dom.toggle.setAttribute('aria-expanded', 'true');
        updateResponsiveSemantics();
        renderAll();
        loadRoster({ force: true });
        global.requestAnimationFrame(() => {
            if (dom.search && state.activeView === 'players') {
                dom.search.focus();
            } else {
                dom.close.focus();
            }
        });
        schedulePoll();
    }

    function closePanel({ restoreFocus = true } = {}) {
        if (!state.open) {
            return;
        }
        document.dispatchEvent(new Event('ui-pointer-lighting-reset'));
        state.open = false;
        dom.shell.classList.add('hidden');
        dom.shell.setAttribute('aria-hidden', 'true');
        dom.toggle.setAttribute('aria-expanded', 'false');
        document.body.classList.remove('player-center-open', 'player-center-mobile-open');
        setBackgroundInert(false);
        const restore = state.previousFocus;
        state.previousFocus = null;
        if (restoreFocus) {
            if (restore && restore.isConnected && typeof restore.focus === 'function') {
                restore.focus();
            } else {
                dom.toggle.focus();
            }
        }
        schedulePoll();
    }

    function refreshActiveView() {
        state.notice = null;
        loadRoster({ force: true });
        if (state.activeView === 'profile' && state.selectedUuid) {
            loadProfile(state.selectedUuid, { force: true });
        } else if (state.activeView === 'link') {
            loadLink({ force: true });
        } else if (state.activeView === 'access') {
            loadGrants({ force: true });
        }
    }

    function schedulePoll() {
        if (pollTimer) {
            global.clearTimeout(pollTimer);
            pollTimer = null;
        }
        if (!state.started) {
            return;
        }
        pollTimer = global.setTimeout(() => {
            pollTimer = null;
            if (!document.hidden) {
                loadRoster();
            } else {
                schedulePoll();
            }
        }, state.open ? POLL_OPEN_MS : POLL_CLOSED_MS);
    }

    function handleSocketOpen() {
        state.socketConnected = true;
        renderHeader();
        if (state.started) {
            loadRoster();
        }
    }

    function handleSocketClose() {
        state.socketConnected = false;
        renderHeader();
    }

    function handleRealtimeMessage(message) {
        if (!isObject(message)) {
            return false;
        }
        if (message.type === 'player-roster-snapshot') {
            if (message.serverId && message.serverId !== SERVER_ID) {
                return true;
            }
            applyListPayload(message, { realtime: true });
            return true;
        }
        if (message.type === 'player-center-invalidation') {
            if (!message.serverId || message.serverId === SERVER_ID) {
                state.profiles.clear();
                state.grantsLoaded = false;
                loadRoster({ force: true });
                if (state.activeView === 'profile' && state.selectedUuid) {
                    loadProfile(state.selectedUuid, { force: true });
                }
                if (state.activeView === 'access') {
                    loadGrants({ force: true });
                }
            }
            return true;
        }
        if (message.type === 'player-presence' || message.type === 'player-joined' || message.type === 'player-left') {
            if (message.serverId && message.serverId !== SERVER_ID) {
                return true;
            }
            if (isStaleRevision(message.revision, state.lastRevision)) {
                return true;
            }
            const rawPresence = message.player || message.payload;
            if (state.list && isObject(rawPresence)) {
                const incoming = normalizePlayer({
                    ...rawPresence,
                    online: message.type === 'player-joined'
                        ? true
                        : (message.type === 'player-left' ? false : rawPresence.online)
                });
                let matched = false;
                const players = state.list.players.map((player) => {
                    const same = incoming.uuid ? player.uuid === incoming.uuid : player.name === incoming.name;
                    if (!same) {
                        return player;
                    }
                    matched = true;
                    return {
                        ...mergePlayer(player, incoming),
                        online: incoming.online
                    };
                });
                if (!matched && incoming.online) {
                    players.push(incoming);
                }
                players.sort((a, b) => {
                    if (a.online !== b.online) {
                        return a.online ? -1 : 1;
                    }
                    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
                });
                state.list = {
                    ...state.list,
                    observedAt: nonEmptyString(message.observedAt) || new Date().toISOString(),
                    revision: message.revision === undefined ? state.list.revision : message.revision,
                    players
                };
                if (message.revision !== null && message.revision !== undefined) {
                    state.lastRevision = message.revision;
                }
                state.socketConnected = true;
                reconcileCachedProfilesFromList();
                renderHeader();
                renderSidebar();
                if (state.activeView === 'players') {
                    renderPlayersOverview();
                }
                refreshLinkRosterViewIfNeeded();
            } else {
                loadRoster();
            }
            return true;
        }
        return false;
    }

    function cacheDom() {
        const entries = {
            shell: 'player-center-shell',
            panel: 'player-center-panel',
            toggle: 'player-center-toggle',
            toggleCount: 'player-center-toggle-count',
            close: 'player-center-close',
            refresh: 'player-center-refresh',
            connectionStatus: 'player-center-connection-status',
            sourceLabel: 'player-center-source-label',
            nav: 'player-center-nav',
            accessNav: 'player-center-access-nav',
            search: 'player-center-search',
            rosterStatus: 'player-center-roster-status',
            playerList: 'player-center-player-list',
            content: 'player-center-content',
            viewStatus: 'player-center-view-status',
            view: 'player-center-view'
        };
        Object.entries(entries).forEach(([key, id]) => {
            dom[key] = document.getElementById(id);
        });
        return Object.values(dom).every(Boolean);
    }

    function bindEvents() {
        dom.toggle.addEventListener('click', () => state.open ? closePanel() : openPanel());
        dom.close.addEventListener('click', closePanel);
        dom.refresh.addEventListener('click', refreshActiveView);
        dom.shell.querySelectorAll('[data-close-player-center="true"]').forEach((node) => {
            node.addEventListener('click', closePanel);
        });
        dom.nav.querySelectorAll('[data-player-center-view]').forEach((button) => {
            button.addEventListener('click', () => switchView(button.dataset.playerCenterView));
        });
        dom.search.addEventListener('input', () => {
            state.query = dom.search.value;
            renderSidebar();
            if (state.activeView === 'players') {
                renderPlayersOverview();
            }
        });
        dom.panel.addEventListener('keydown', handlePanelKeydown);
        const chatToggle = document.getElementById('server-chat-toggle');
        if (chatToggle) {
            chatToggle.addEventListener('click', () => {
                if (state.open && isMobile()) {
                    closePanel({ restoreFocus: false });
                }
            }, true);
        }
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden && state.started) {
                loadRoster();
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
        state.user = user || null;
        if (!state.user || !cacheDom()) {
            return false;
        }
        bindEvents();
        global.addEventListener('pagehide', releaseAvatarUrls, { once: true });
        state.initialized = true;
        renderAll();
        return true;
    }

    function start() {
        if (!state.initialized || state.started) {
            return;
        }
        state.started = true;
        loadRoster();
        freshnessTimer = global.setInterval(() => {
            renderHeader();
            refreshLinkRosterViewIfNeeded();
        }, 5000);
    }

    function stop() {
        state.started = false;
        disposeActiveTrendBinding();
        if (pollTimer) {
            global.clearTimeout(pollTimer);
            pollTimer = null;
        }
        if (freshnessTimer) {
            global.clearInterval(freshnessTimer);
            freshnessTimer = null;
        }
        if (rosterController) {
            rosterController.abort();
        }
        if (profileController) {
            profileController.abort();
        }
    }

    const publicApi = {
        init,
        start,
        stop,
        handleSocketOpen,
        handleSocketClose,
        handleRealtimeMessage
    };
    if (global.__PLAYER_CENTER_TESTING__ === true) {
        publicApi.__testing = Object.freeze({
            formatDuration,
            formatStatValue,
            activityTimestampPresentation,
            firstActivityTimestampPresentation,
            retainedEventPresentation,
            overviewInsights,
            hasHistoricalDirectoryData,
            normalizePlayer,
            playerMatchesQuery,
            normalizeListPayload,
            mergePlayer,
            overlayRealtimeRoster,
            authoritativeOnlinePlayers,
            normalizeChallengePayload,
            isStaleRevision,
            isStaleRosterSnapshot,
            trendPoints,
            trendScrollMetrics,
            formatTrendTickDate,
            sessionPresentation,
            loadAvatarUrl
        });
    }
    global.PlayerCenter = Object.freeze(publicApi);
})(window);
