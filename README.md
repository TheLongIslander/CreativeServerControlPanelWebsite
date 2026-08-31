# Minecraft Server Control Panel + SFTP Browser

Engineering specification for the current implementation.

## 1. Purpose

This service is a self-hosted web control plane for:

- Minecraft server lifecycle operations (start, stop, restart).
- Compatibility-aware Minecraft/Fabric server version changes with preflight checks, rollback snapshots, and mod migration.
- Scheduled backup execution and backup browsing over SFTP.
- Read-only server information, installed-mod metadata, server lore, and screenshot gallery browsing.
- Multi-user authentication with admin-managed accounts.
- Optional passkey (WebAuthn) login and passkey lifecycle management.
- Authenticated Minecraft chat and player-activity history, including safe panel-to-game messages.
- A Player Center with live presence, UUID profiles, backup-derived playtime trends,
  selected statistics/advancements, verified panel-account linking, and owned whitelist grants.

The system is implemented as a single Node.js process with Express HTTP routes, a WebSocket server, SQLite persistence, and worker threads for heavy I/O/CPU operations.

## 2. Scope

### In scope

- HTTP UI serving and JSON APIs.
- JWT auth, role enforcement, onboarding enforcement, account lockout and login throttling.
- Admin user management and user audit trails.
- SFTP file browsing, upload, preview, and download orchestration.
- Backup execution with progress telemetry.
- End-to-end update/downgrade orchestration (status detection, preflight, apply, rollback, and update history).
- Server Info modal data API, dynamic screenshot discovery, and installed-mod inventory display.
- Graceful maintenance broadcast + process shutdown.
- User appearance preferences (theme + color mode).
- Session-aware Minecraft chat ingestion, pagination, reconnect catch-up, health reporting, and an admin sending switch.

### Out of scope

- Container orchestration.
- Horizontal scaling and distributed state.
- TLS termination.
- External identity providers.
- Automated DB migrations beyond startup-time SQLite column evolution.
- Raw Minecraft console access, arbitrary command passthrough, private messages, and multi-server chat UI.
- Guaranteed player-visible delivery acknowledgement from Minecraft; the v1 Screen transport can confirm only that Screen accepted the command bytes.

## 3. Runtime Architecture

### Process model

One Node.js process (`app.js`) hosts:

1. HTTP server (Express).
2. Explicit public and authenticated WebSocket upgrade paths backed by `ws`.
3. Worker threads for download zipping and HEIC conversion.
4. An authoritative Screen/log runtime reconciler.
5. A byte-oriented Minecraft log tailer and dedicated chat SQLite store.
6. In-memory coordination state in `backend/state.js`.
7. An independently degradable Player Center store, world/backup collectors, live roster,
   and optional native Minecraft Management Protocol client.

### External dependencies

- Minecraft server host controlled through argv-only `screen`/launch-process calls.
- SFTP server accessed via `ssh2`.
- Local SQLite files for persistence.
- System binaries for backup/preview/archive operations.

### High-level component map

- Entry point: `app.js`
- HTTP routes: `backend/routes/`
- Middleware: `backend/middleware/`
- DB adapters: `backend/db/`
- Services: `backend/services/`
- Workers: `backend/workers/`
- Utilities: `backend/utils/`
- Frontend pages/scripts/styles: `public/`

Chat-specific ownership:

- `backend/services/minecraftProcessService.js`: Screen identity, runtime readiness, lifecycle serialization.
- `backend/services/chatLogTailer.js`: byte cursors, rotation/truncation recovery, bounded archive backfill.
- `backend/services/chatParser.js`: strict allowlist parser for chat/join/leave/death/advancement lines.
- `backend/db/chatStore.js`: `chat.db` migrations, sessions, messages, cursor, settings, and audit outbox.
- `backend/services/chatService.js`: state snapshots, history, sending, idempotency, health, and recovery.
- `backend/services/realtimeHub.js`: authenticated/public WebSocket scoping and liveness.
- `public/serverChat.js` and `public/chat.css`: desktop/mobile chat surface.

Player Center ownership:

- `backend/config/serverRegistry.js`: exact single-server context and path/secret boundary.
- `backend/db/playerStore.js`: `players.db` identities, snapshots, events, links, and access grants.
- `backend/services/playerPresenceService.js`: authoritative Management Protocol roster with a
  privacy-bounded `latest.log` fallback.
- `backend/services/playerFileCollector.js`: safe stats, advancements, scoreboard, identity ingestion,
  and evidence-based activity timestamps. Modern live playerdata remains filename/`lstat`-only. For
  legacy Bukkit worlds and retained backups, a bounded selective NBT reader extracts only
  `firstPlayed`, `lastPlayed`, and `lastKnownName` while structurally skipping every other payload.
- `backend/services/playerBackupTrendService.js`: daily-sampled backup backfill and cumulative deltas.
- `backend/services/playerLinkService.js` and `playerAccessService.js`: reverse private challenges and
  typed allowlist reconciliation.
- `public/playerCenter.js` and `public/playerCenter.css`: lower-right purple Player Tracking surface.

## 4. Startup and Shutdown Lifecycle

### Startup sequence

1. Load environment via `dotenv`.
2. Construct dependency instances and the side-effect-free Express application.
3. Initialize users DB schema (`initUsersDb`).
4. Ensure bootstrap `admin` account (`ensureAdminUser`).
5. Initialize update DB/schema and recover update lock/run state (`updateService.initialize`).
6. Initialize the current Player Center store, observations, roster, and timers before accepting HTTP
   requests. Historical backup/log ingestion is deferred to the background; Player Center failure is
   contained to that subsystem.
7. Start the HTTP listener on `PORT` (default `8087`) and attach explicit WebSocket upgrade handling.
8. Start authoritative Minecraft runtime reconciliation.
9. Initialize chat storage/settings, reconcile the current session, and begin bounded backfill/tailing. Chat failure degrades only chat and does not abort core startup.
10. Start periodic update status refresh.
11. Trigger background video thumbnail pre-cache crawl from SFTP root (`/`).

### Graceful shutdown

Triggers: typing `stop` in server STDIN (TTY only), `SIGINT`, `SIGTERM`, or the programmatic server handle's `close()` method.

Steps:
1. Set `maintenanceMode = true` and the sticky `shutdownInProgress = true` guard (in-memory).
2. Broadcast maintenance to public and authenticated WebSocket clients.
3. Stop accepting new HTTP connections and begin draining active requests.
4. Close WebSocket clients and the WebSocket server with a bounded grace period.
5. Await the bounded HTTP drain, then ask the existing lifecycle service to stop Minecraft exactly
   once and wait for Screen to disappear. This has a 65-second outer bound; failure is reported but
   does not prevent the remaining panel cleanup.
6. Stop update/runtime/tailer/retry timers and preview/download workers. In-flight backup and update
   paths observe the sticky shutdown guard and cannot restart Minecraft.
7. Checkpoint and close `chat.db` and the existing SQLite handles.
8. Cancel Player Center history work, stop roster/access timers and Management Protocol reconnects,
   checkpoint, and close `players.db` before closing `users.db`.
9. Exit on terminal/signal shutdown; programmatic close does not terminate the Node process.

Startup-failure cleanup intentionally does not stop an independently running Minecraft server.
`SIGKILL` and host power loss cannot execute application cleanup; use `stop`, `SIGINT`, or `SIGTERM`
when a Minecraft shutdown is required.

## 5. Configuration Contract

Copy `.env.example` to `.env` and populate values.

```bash
cp .env.example .env
```

### Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `JWT_SECRET` | Yes | None | JWT signing/verification secret. |
| `ADMIN_PASSWORD_HASH` | Yes | None | Bcrypt hash for bootstrap `admin` account. |
| `TEMP_PASSWORD_ENCRYPTION_KEY` | Yes | None | Base64-encoded 32-byte key for AES-256-GCM encryption of stored temp passwords. |
| `WEBAUTHN_RP_ID` | No | `localhost` | WebAuthn RP ID. |
| `WEBAUTHN_RP_NAME` | No | `Server Control` | WebAuthn RP display name. |
| `WEBAUTHN_ORIGIN` | Conditionally | None | Primary allowed WebAuthn origin. Required for production passkey flows. |
| `WEBAUTHN_ORIGINS` | No | None | Comma-separated additional allowed WebAuthn origins. |
| `APP_ORIGINS` | Production | WebAuthn origins, otherwise fixed localhost origins in development | Comma-separated exact HTTP(S) origins allowed for authenticated WS upgrades and chat mutations. Credentials, paths, wildcards, opaque origins, query strings, and fragments are rejected. |
| `START_COMMAND_PATH` | Yes | None | Script path executed for server start/restart. |
| `MINECRAFT_SERVER_PATH` | Yes | None | Source directory for backups. |
| `MINECRAFT_SCREEN_SESSION` | No | `MinecraftSession` | Exact detached Screen session name observed and controlled by the runtime service. |
| `MINECRAFT_LOG_PATH` | No | `$MINECRAFT_SERVER_PATH/logs/latest.log` | Explicit current Minecraft log path override. |
| `MINECRAFT_TIME_ZONE` | No | Host resolved time zone, then `UTC` | IANA time zone used to reconstruct dates from Minecraft's time-only log prefix. |
| `CHAT_DB_PATH` | No | `./chat.db` | Dedicated chat SQLite database path. |
| `CHAT_SCREEN_MAX_COMMAND_BYTES` | No | `512` | Maximum UTF-8 bytes accepted for the complete Screen payload, including the trailing carriage return. Smoke-test before production use. |
| `CHAT_RETENTION_DAYS` | No | `0` | Ended-session retention; `0` retains history indefinitely and a positive value prunes old ended sessions while preserving current/latest. |
| `PLAYER_DB_PATH` | No | `./players.db` | Dedicated Player Center SQLite database. |
| `PLAYER_FILE_COLLECTION_INTERVAL_MS` | No | `86400000` | Current cumulative world-file snapshot cadence; minimum 10 seconds, with daily strongly recommended because each snapshot is high-cardinality. |
| `PLAYER_HISTORY_BACKFILL_ENABLED` | No | `true` | Enables background backup/log reconstruction. Backup snapshots are sampled to the latest per day by default. |
| `PLAYER_ROSTER_POLL_MS` | No | `1500` | Best-effort log roster poll cadence; native Management Protocol notifications remain event-driven. |
| `PLAYER_ACCESS_RECONCILE_INTERVAL_MS` | No | `60000` | Durable allowlist grant reconciliation cadence. |
| `PLAYER_LINK_HMAC_SECRET` | No | Domain-separated key derived from `JWT_SECRET` | Optional stable key material for hashing one-time link codes. Codes themselves are never stored. |
| `MINECRAFT_MANAGEMENT_URL` | No | Derived from `server.properties` | Optional exact `ws://` or `wss://` native Management Protocol endpoint. Credentials in URLs are rejected. |
| `MINECRAFT_MANAGEMENT_ALLOW_REMOTE` | No | `false` | Allows a non-loopback Management Protocol endpoint. Leave false unless a private/firewalled transport has been reviewed. |
| `MINECRAFT_MANAGEMENT_TIMEOUT_MS` | No | `5000` | Bounded native protocol discovery/request timeout. |
| `TRUST_PROXY` | No | Disabled | Explicit Express proxy trust (for example `loopback`, an address/CIDR list, or a hop count). Never use unrestricted `true`; this controls trusted client IP and TLS-forwarding data. |
| `BACKUP_PATH` | Yes | None | Target root for backup output hierarchy. |
| `PORT` | No | `8087` | HTTP listen port. |
| `SFTP_HOST` | Yes | None | SFTP host. |
| `SFTP_PORT` | Yes | None | SFTP port. |
| `SFTP_USERNAME` | Yes | None | SFTP username. |
| `SFTP_PASSWORD` | Yes | None | SFTP password. |
| `TMP_UPLOAD_SERVER_PATH` | Yes | None | Temporary upload location for `express-fileupload`. |
| `VIDEO_CACHE_DIR` | No | OS temp-based path | Video thumbnail cache directory override. |
| `NODE_ENV` | No | unset | Affects WebAuthn fallback origins in non-production mode. |

On Minecraft versions that expose the native Management Protocol, live tracking is enabled in
`server.properties`, not through a browser API:
`management-server-enabled`, `management-server-host`, `management-server-port`,
`management-server-secret`, and `management-server-tls-enabled`. The client exposes only typed
player/allowlist methods, keeps the bearer secret server-side, and defaults to loopback. When it is
disabled, profiles and history remain available and current presence is labeled best effort from logs;
linking and access mutation return an explicit unsupported state.

### Required system binaries

- `screen`
- `rsync`
- `zip`
- `unzip`
- `find`
- `ffmpeg`
- `GraphicsMagick` or `ImageMagick` + `Ghostscript` (PDF preview path)
- `df` (disk-space preflight for update flow)
- `java` (or explicit Java path used by launch script; required for Fabric installer and runtime checks)

## 6. Middleware and Global HTTP Settings

Configured in `app.js`:

- General URL-encoded and JSON parser limits: `1mb`.
- `/chat` and `/admin/chat` are mounted first with a strict 4 KiB body limit and stable JSON parse/size errors.
- File upload middleware: mounted only on authenticated/onboarded `/upload` requests, with temp-file mode enabled.
- File upload temp directory: `TMP_UPLOAD_SERVER_PATH`.
- File upload max file size: `50GB`.
- File-size overflow handler returns HTTP `413`.

Static serving:

- `express.static('public')`
- `express.static('assets')` mounted at `/assets`
- Server Info screenshots are served from `assets/server-info/`; generated optimized display/thumb assets may live under `assets/server-info/_generated/`.

## 7. In-Memory Runtime State

Defined in `backend/state.js`:

- `serverRunning` (`boolean`) default `false`
- `lastBackupHour` (`string|null`) default `null`
- `maintenanceMode` (`boolean`) default `false`
- `updateLocked` (`boolean`) default `false`
- `updateLockOwner` (`string|null`) default `null`
- `serverState` (`offline|starting|ready|stopping`) mirrored from the process reconciler
- `serverReady` (`boolean`) mirrored from the process reconciler
- `backupInProgress` (`boolean`) lifecycle lock
- `shutdownInProgress` (`boolean`) sticky guard that prevents Minecraft restart during panel teardown

Notes:

- State is process-local and resets on restart.
- `serverRunning`, `serverState`, and `serverReady` are compatibility mirrors of the authoritative Screen/log observation. Route intent is only a transition hint.
- Chat maintains a separate epoch plus monotonic revision for capability/session snapshots; it is not stored in this shared state object.

## 8. Authentication and Authorization Model

### Credential types

- Password login (`/login`)
- Passkey login (WebAuthn `/webauthn/auth-*`)

### Token model

- JWT contains: `userId`, `role`, `tokenVersion`.
- Token TTL: `1h`.
- Token transport: bearer token in `Authorization` header (primary API pattern).
- `auth_token` HTTP-only cookie is also set on login/passkey auth and refreshed on password changes.

### Token invalidation

- Logout inserts JWT into blacklist (`token_blacklist.db`).
- Token version increments force session invalidation for password set/change, admin force logout, and admin disable user.

### Route protection middleware

- `authenticateJWT`: validates JWT, blacklist status, user existence, user disabled state, token version match.
- `requireOnboarded`: blocks users with `must_reset_password = 1` using HTTP `428` and message `PASSWORD_RESET_REQUIRED`.
- `requireAdmin`: requires `req.user.role === 'admin'`.

### Password policy

- Minimum length: 12.
- Rejects common passwords list.
- Rejects passwords containing username (case-insensitive).

### Login hardening

- Per-account lockout max failed attempts: 5.
- Per-account lock duration: 15 minutes.
- Per-IP in-memory throttling window: 5 minutes.
- Per-IP in-memory throttling limit: 20 login attempts.

## 9. WebAuthn (Passkey) Specification

### Allowed origin derivation

Computed in `backend/routes/webauthn.js`:

- Include `WEBAUTHN_ORIGIN` if set.
- Include entries from `WEBAUTHN_ORIGINS` if set.
- In non-production, also allow `http://localhost:3000` and `http://localhost:8087`.

If no expected origins are configured, passkey endpoints return HTTP `500` with `WEBAUTHN_ORIGIN is not configured.`

### Challenge lifecycle

- Challenge TTL: 5 minutes.
- Persisted in `webauthn_challenges` table.
- Expired challenges are cleaned before insertion.
- For user-scoped challenge creation, previous same-type challenge is replaced.

### Credential lifecycle

- Stored in `webauthn_credentials` with counter + transport metadata.
- Account page supports listing and deleting own passkeys.

## 10. HTTP API Reference

All routes are mounted at root.

### 10.1 Page routes

| Method | Path | Auth | Behavior |
|---|---|---|---|
| `GET` | `/` | No | Serves `public/login.html`. |
| `GET` | `/maintenance.html` | Conditional | Serves maintenance page only when maintenance mode is true; otherwise redirects to `/` or `/index.html` based on cookie token validity. |

### 10.2 Auth and profile routes

| Method | Path | Auth | Request body | Success response |
|---|---|---|---|---|
| `POST` | `/login` | No | `{ username, password }` | `{ message, token, mustResetPassword, role, username }` |
| `GET` | `/me` | JWT | None | `{ id, username, role, mustResetPassword, disabled, lastLoginAt, uiTheme, colorScheme }` |
| `POST` | `/appearance` | JWT | `{ uiTheme, colorScheme }` | `{ uiTheme, colorScheme }` |
| `POST` | `/set-password` | JWT | `{ password }` | `{ message: 'Password updated', token }` |
| `POST` | `/change-password` | JWT | `{ currentPassword, newPassword }` | `{ message: 'Password updated', token }` |
| `POST` | `/logout` | JWT | None | `'Logged out'` |

Key failure statuses:

- `400` invalid payload or policy failure.
- `401` invalid credentials/session.
- `403` invalid/forbidden token state.
- `429` IP throttle or account lockout active.

### 10.3 Admin user-management routes

All `/admin/*` routes require `authenticateJWT + requireOnboarded + requireAdmin`.

| Method | Path | Request | Success response |
|---|---|---|---|
| `GET` | `/admin/users` | None | Array of users with admin-facing state fields (including decrypted temp password where available). |
| `GET` | `/admin/users/:id/logins` | None | `{ user, logins[] }` |
| `GET` | `/admin/audit` | Query: `actor,target,action,ip,from,to,limit` | Array of audit events (limit max 500). |
| `GET` | `/admin/updates` | Query: `limit` | Update/downgrade run history with operation-aware mode labels, version path, counts, status, and detailed summary payload. |
| `POST` | `/admin/users` | `{ username }` | Created user payload with generated temp password. |
| `PATCH` | `/admin/users/:id` | `{ disabled: boolean }` | `{ message: 'User updated' }` |
| `POST` | `/admin/users/:id/reset-temp-password` | None | `{ message, tempPassword }` |
| `POST` | `/admin/users/:id/force-logout` | None | `{ message: 'User logged out' }` |
| `POST` | `/admin/users/:id/unlock` | None | `{ message: 'User unlocked' }` |
| `DELETE` | `/admin/users/:id` | None | `{ message: 'User deleted' }` |

Protection rules enforced server-side:

- Cannot modify/delete `admin` via these endpoints.
- Cannot self-modify/delete through these admin actions.

### 10.4 WebAuthn routes

| Method | Path | Auth | Request | Success response |
|---|---|---|---|---|
| `GET` | `/webauthn/credentials` | JWT + onboarded | None | Array of `{ credentialId, createdAt, lastUsedAt }` |
| `DELETE` | `/webauthn/credentials/:id` | JWT + onboarded | None | `{ message: 'Passkey deleted' }` |
| `POST` | `/webauthn/register-options` | JWT + onboarded | `{}` | `{ options }` |
| `POST` | `/webauthn/register` | JWT + onboarded | `{ credential, challenge }` | `{ message: 'Passkey registered' }` |
| `POST` | `/webauthn/auth-options` | No | `{}` | `{ options }` |
| `POST` | `/webauthn/auth` | No | `{ credential, challenge }` | `{ message, token, mustResetPassword, role, username }` |

### 10.5 Minecraft server control routes

| Method | Path | Auth | Behavior |
|---|---|---|---|
| `GET` | `/status` | No | Returns `{ running, ready, state, updateInProgress }` from the authoritative runtime snapshot. |
| `POST` | `/start` | JWT + onboarded | Serializes an argv-only launch through the process service and reconciles Screen state. Returns `423` while lifecycle-locked. |
| `POST` | `/stop` | JWT + onboarded | Serializes a Screen `stop\r`, waits for the session to disappear, and reconciles state. Returns `423` while lifecycle-locked. |
| `POST` | `/restart` | JWT + onboarded | Reconciles, then serializes stop/start as one priority lifecycle operation. Returns `423` while lifecycle-locked. |

### 10.6 Backup route

| Method | Path | Auth | Behavior |
|---|---|---|---|
| `POST` | `/backup` | JWT + onboarded | Enforces once-per-hour window, optionally stops server, runs `rsync`, streams progress via WebSocket, restarts server if previously running. Returns `423` if update is in progress. |

Operational details:

- Backup destination path shape: `$BACKUP_PATH/<FormattedDate>/<HourLabel>`.
- Progress estimation uses recursive file-size summing + parsed rsync output.
- On success, updates in-memory `lastBackupHour`.

### 10.7 SFTP browse/mutation routes

All require `authenticateJWT + requireOnboarded`.

| Method | Path | Request | Behavior |
|---|---|---|---|
| `GET` | `/sftp/list` | Query: `path` | Returns non-hidden directory entries sorted by modification time desc. |
| `POST` | `/change-directory` | `{ path }` | Updates process-global `currentPath` and returns it. |
| `POST` | `/open-directory` | `{ path }` | Updates process-global `currentPath` and returns it. |
| `POST` | `/sftp/create-directory` | `{ path, directoryName }` | Creates directory if missing; errors if already exists. |

Deleted-path recovery:

- If a listed directory no longer exists, API returns `404` JSON with `deletedPath` and `fallbackPath` (closest existing ancestor).

### 10.8 Upload route

All require `authenticateJWT + requireOnboarded`.

| Method | Path | Content type | Inputs |
|---|---|---|---|
| `POST` | `/upload` | `multipart/form-data` | `files` (one or many), `path`, `lastModified` |

Behavior:

- Uploads to SFTP via `fastPut`.
- Ensures remote directories exist recursively.
- Avoids filename collisions by suffixing ` copyN`.
- Sets remote file mtime from client-provided `lastModified`.
- If uploaded file is `.zip`, the server verifies size when available, unzips to temp dir, uploads extracted tree into a unique destination directory (`name`, then `name-2`, ...), then deletes the uploaded zip from remote.
- Logs SFTP upload action.

### 10.9 Download routes

| Method | Path | Auth | Request | Behavior |
|---|---|---|---|---|
| `POST` | `/download` | JWT + onboarded | `{ path, requestId? }` | Starts/reuses worker job, returns `{ requestId, message }`, logs action. |
| `GET` | `/downloads/:requestId` | JWT + onboarded, request owner | None | Streams that user's temp ZIP file and deletes it after response finishes. Other users receive `404`. |

Worker behavior:

- Directory targets: recursively download then zip with progress.
- File targets: download and zip unless already `.zip` (then renamed).
- Progress, completion, and failure events are sent only to authenticated sockets belonging to the requesting user.
- Jobs use isolated random temp paths and in-process ZIP streams. The service caps concurrent/outstanding jobs globally and per user, terminates stalled workers, and expires unclaimed archives after 15 minutes.

### 10.10 Preview route

| Method | Path | Auth | Request | Behavior |
|---|---|---|---|---|
| `GET` | `/download-preview` | JWT + onboarded | Query: `path` | Returns preview image or raw stream depending on extension/handler path. |

File-type handling:

- Images: resized JPEG cache.
- Videos: ffmpeg thumbnail cache.
- HEIC: worker conversion + cache.
- PDF: first-page render + cache.
- Other: raw octet-stream relay.

### 10.11 Server info route

Requires `authenticateJWT + requireOnboarded`.

| Method | Path | Request | Behavior |
|---|---|---|---|
| `GET` | `/server-info` | None | Returns current server version, installed mods, founding/start metadata, lore sections, and dynamic screenshot gallery groups. |

Data behavior:

- Current version comes from the update service when available.
- Mods are read from `$MINECRAFT_SERVER_PATH/mods` and parsed from Fabric `fabric.mod.json` metadata when possible.
- Curated screenshot groups are loaded from `assets/server-info/<era>/`.
- Additional subfolders under `assets/server-info/` are discovered automatically after curated eras.
- Root-level screenshots under `assets/server-info/` appear in an `Unsorted` group.
- Optimized derivatives under `assets/server-info/_generated/display/<era>/` and `assets/server-info/_generated/thumbs/<era>/` are preferred when present; originals remain the fallback and full-resolution target.

### 10.12 Update routes

All update routes require `authenticateJWT + requireOnboarded`.

| Method | Path | Request | Behavior |
|---|---|---|---|
| `GET` | `/updates/status` | Query: `refresh=1|true` (optional) | Returns update status snapshot: current version, latest Mojang release, latest Fabric-supported release, availability, lock state, and snapshot-restorability state. |
| `POST` | `/updates/check` | `{ targetVersion? }` | Runs preflight: Java, disk, Fabric support, mod compatibility, conflict analysis, recommended compatible target lookup. Persists check in `updates.db`. |
| `GET` | `/updates/advanced/versions` | Query: `direction=update|downgrade` | Returns eligible release targets for the requested advanced direction. Update targets are newer than current; downgrade targets are older than current and filtered by backend policy. |
| `POST` | `/updates/advanced/check` | `{ targetVersion, direction }` | Runs advanced preflight for an explicit target. Supports update and downgrade operations, returns operation metadata and compatible alternative targets when conflicts exist. |
| `GET` | `/updates/check/:id` | None | Returns a stored preflight check report by id. |
| `POST` | `/updates/apply` | `{ checkId, mode, acknowledgeDowngradeRisk? }` | Applies a version change using a fresh preflight check (`<= 30m`), with lock, snapshot, artifact install, mod migration, smoke test, auto-rollback on failure, and run summary persistence. Downgrade checks require explicit acknowledgement. |
| `POST` | `/updates/restore-latest` | None | Restores latest snapshot-bearing update run. Intended for administrative/manual recovery paths. |

Supported apply modes:

- `server_and_compatible_mods`: change server version and keep compatible mods (archive moved/replaced jars).
- `server_only_move_all_mods`: change server version and move all current mods out of `mods/` into versioned archive folder.

Advanced version-change policy:

- Normal left-click update flow remains update-only and targets the latest Fabric-supported release.
- Server Management > Server Version opens the advanced flow with an explicit Minecraft release target and derives update vs downgrade from the selected version. Right-clicking the visible update button remains a shortcut when an update is available.
- Advanced downgrade targets are constrained server-side by a hardcoded minimum release policy.
- Downgrade apply requests must include `acknowledgeDowngradeRisk: true`; otherwise `/updates/apply` rejects the run.
- Advanced conflict checks may return multiple `compatibleTargets`; the frontend can let the user switch to one before applying.

Apply pipeline (high-level):

1. Acquire global update lock.
2. Stop running server session (if running).
3. Create full snapshot backup (`UpdateSnapshots/...`).
4. Download target server jar + Fabric installer + install loader.
5. Apply mod plan (download compatible updates, move blocked/unknown/old jars to archive).
6. Run startup smoke test (process, logs, and local TCP probe).
7. Persist final state + detailed summary and release lock.
8. On failure: rollback from snapshot and restore prior running/offline state.

### 10.13 Minecraft chat routes

Every chat response uses `Cache-Control: no-store`. Authenticated chat readers must also be onboarded. Mutations require `Content-Type: application/json` plus an exact `Origin` from `APP_ORIGINS`.

| Method | Path | Auth | Request | Behavior |
|---|---|---|---|---|
| `GET` | `/chat/messages` | JWT + onboarded | Query: `limit` (default 200, max 500), one of `beforeId` or `afterId` | Returns the current/latest session, committed visible messages in ascending ID order, pagination state, limits, health, runtime state, and the caller's send capability. |
| `POST` | `/chat/messages` | JWT + onboarded + allowed Origin | `{ message, clientMessageId }` | Normalizes with NFC/trim, validates, reserves a pending row, writes one fixed `tellraw` command through Screen, commits `sent`, then broadcasts. New sends return `201`; a successful idempotent replay returns `200`. |
| `GET` | `/admin/chat/settings` | Admin | None | Returns the persistent panel-sending setting and its epoch/revision. |
| `PATCH` | `/admin/chat/settings` | Admin + allowed Origin | Exactly `{ sendingEnabled: boolean }` | Applies the priority sending barrier, commits setting plus audit intent, and updates every connected composer through the standard session-status event. |
| `GET` | `/admin/chat/health` | Admin | None | Returns redacted aggregate health/tailer/store/queue/socket metrics. |

`GET /chat/messages` does not accept a session selector in v1. “Current” means the active normal runtime session while ready, otherwise the most recently ended normal session. Stored history remains readable while Minecraft is offline or sending is disabled.

Messages are DTOs, never pre-rendered HTML:

```json
{
  "id": 126,
  "sessionKey": "sess_...",
  "origin": "panel",
  "kind": "chat",
  "actorName": "TheLongIslander",
  "panelUserId": 7,
  "panelUsername": "TheLongIslander",
  "message": "Hello everyone",
  "occurredAt": "2026-08-28T18:21:00.000Z",
  "timestampConfidence": "exact"
}
```

The history response includes `stateEpoch` and `stateRevision`, a sanitized session, `permissions`, and authoritative limits:

```json
{
  "limits": {
    "maxMessageCodePoints": 256,
    "maxCommandBytes": 512,
    "commandFormatVersion": "tellraw-v1"
  },
  "permissions": {
    "canRead": true,
    "canSend": true,
    "sendBlockedReason": null
  }
}
```

Important stable chat errors:

| HTTP | Code | Meaning |
|---|---|---|
| `400` | `CHAT_INVALID_MESSAGE`, `CHAT_INVALID_QUERY`, `CHAT_INVALID_SETTINGS` | Invalid body, cursor, normalized message, UUID, or settings shape. |
| `400` | `CHAT_INVALID_JSON`, `CHAT_COMMAND_TOO_LARGE` | Malformed JSON or final Screen payload over the configured byte cap. |
| `401/403/428` | `AUTH_REQUIRED`, `AUTH_INVALID`, `PASSWORD_RESET_REQUIRED` | Authentication/onboarding failed. |
| `403` | `ORIGIN_NOT_ALLOWED` | Mutation Origin is absent, malformed, or not exactly allowed. |
| `409` | `CHAT_SERVER_OFFLINE`, `CHAT_CATCHING_UP`, `CHAT_IDEMPOTENCY_CONFLICT`, `CHAT_DELIVERY_UNKNOWN` | Runtime/baseline/idempotency state prevents a safe new send. |
| `413/415` | `CHAT_BODY_TOO_LARGE`, `CHAT_JSON_REQUIRED` | Body exceeds 4 KiB or is not JSON. |
| `423` | `CHAT_LOCKED`, `CHAT_READ_ONLY` | Maintenance/update or the persistent admin switch blocks sending. |
| `429` | `CHAT_RATE_LIMITED` | Per-user burst/rolling limit or the global send queue is full; inspect `Retry-After`. |
| `503` | `CHAT_CONSOLE_UNAVAILABLE`, `CHAT_PREVIOUS_SEND_FAILED`, `CHAT_UNAVAILABLE`, `CHAT_SETTINGS_UNAVAILABLE` | Screen, retained send, chat storage, or persistent settings are unavailable. |

A `503 CHAT_UNAVAILABLE` history response intentionally omits `messages`; clients retain cached rows. Public health reasons are stable redacted codes such as `database_unavailable`, `log_unreadable`, `history_incomplete`, and `send_transport_unavailable`.

### 10.14 Player Center routes

All routes are scoped to the one exact configured `serverId` (`default` today), return
`Cache-Control: no-store`, and require an authenticated onboarded account. Unknown server IDs return
`404`; they never fall through to the default server. Mutations additionally require exact-Origin JSON.

| Method | Path | Capability | Behavior |
|---|---|---|---|
| `GET` | `/api/servers/:serverId/players` | `players.roster.read` | Returns the UUID directory overlaid with current presence, playtime, provenance, freshness, coverage, and a roster revision that is monotonic between panel restarts. `observedAt` safely identifies a newer restart epoch. |
| `GET` | `/api/servers/:serverId/players/:uuid` | `players.activity.read` | Returns names, selected public stats, advancements, observed sessions/activity, and honest coverage. |
| `GET` | `/api/servers/:serverId/players/:uuid/avatar` | `players.roster.read` | Returns a cached 64 px PNG face for the verified UUID, including the skin hat layer; missing/upstream-unavailable skins fall back to initials in the browser. |
| `GET` | `/api/servers/:serverId/players/:uuid/trends?metric=play_time` | `players.activity.read` | Returns second-based chart points plus retained raw ticks, reset boundaries, sources, and known gaps. |
| `POST` | `/api/servers/:serverId/players/legacy-identities/resolve` | `players.link.override` | Admin-only NameMC/manual research candidate. It remains time-stamped, unverified evidence and cannot verify/link/authorize. |
| `GET` | `/api/servers/:serverId/player-links/me` | `players.link.self` | Returns the caller's verified link or `null`. |
| `POST` | `/api/servers/:serverId/player-links/challenges` | `players.link.self` | Selects one authoritative online UUID and privately delivers a short-lived reverse challenge in game. |
| `POST` | `/api/servers/:serverId/player-links/challenges/:id/verify` | `players.link.self` | Consumes that exact account/server/challenge ID and code atomically. |
| `DELETE` | `/api/servers/:serverId/player-links/me` | `players.link.self` | Revokes the caller's link; it does not alter admin, operator, filesystem, or whitelist access. |
| `GET` | `/api/servers/:serverId/access-grants` | `players.access.manage` | Lists panel grants with observed allowlist ownership/drift. |
| `POST` | `/api/servers/:serverId/access-grants` | `players.access.manage` | Creates an audited permanent, future, or expiring grant for a UUID/current-name pair. `Idempotency-Key` makes retries safe. |
| `PATCH` | `/api/servers/:serverId/access-grants/:id` | `players.access.manage` | Performs exactly one extension, revoke, or explicit drift reconciliation. |

Linking does not require Fabric. It uses Minecraft's native Management Protocol for an
authoritative online UUID/name roster and the existing typed Screen transport for a private
`tellraw <exact-player-name>` code. The browser never supplies the identity proof: it selects a UUID
already present in the authoritative roster, then returns the code received by that player. Only an
HMAC digest is stored, with expiry, creation throttling, attempt limits, replay rejection, and exact
challenge-ID scoping. A delivered challenge remains committed if only its delivery receipt cannot be
persisted; the response/UI reports that degraded receipt and never sends a second code automatically.

Allowlist changes use only `minecraft:allowlist`, `minecraft:allowlist/add`, and
`minecraft:allowlist/remove`. Existing/manual entries are imported as external and are never removed.
The panel removes an expired/revoked entry only when it can prove panel ownership; manual removal
becomes visible drift and requires an explicit reapply.
Durable grant writes return `committed: true` even when the immediate Minecraft reconciliation is
degraded; the scheduler retries them. The browser reuses one idempotency key for an ambiguous retry,
so a lost response cannot create a duplicate grant.

Minecraft names are recyclable. A current NameMC owner, current live player, or name-keyed
scoreboard row is never merged into a UUID profile merely because the spelling matches. NameMC
lookups remain candidates; scoreboard history is attached to a UUID trend only when that same
snapshot contains an exact, verified UUID/name observation for exactly one known owner. Two sightings
around a gap are never stretched into continuous ownership.
`usercache.json`, allowlists, access grants, and authentication handshakes can enrich identity or
access records, but none independently proves that a person played. The ordinary roster requires
gameplay files/events, positive playtime-score evidence, or current live presence.

## 11. WebSocket Protocol

The realtime hub uses `WebSocket.Server({ noServer: true, perMessageDeflate: false })` and handles only two explicit upgrade paths. Both require an exact configured Origin.

- `/ws`: authenticated and onboarded operational/chat channel. Authentication comes from the HttpOnly `auth_token` cookie; JWTs are never placed in the URL.
- `/ws/public`: unauthenticated maintenance-only channel used by the login surface.

`/ws` applies signature/expiry, blacklist, enabled-user, token-version, and onboarding checks. It periodically revalidates clients, closes them at token expiry or account invalidation, uses ping/pong liveness, caps connections, and drops slow clients. Logout, force logout, and account disable can disconnect matching sockets immediately.

### Message types

| Scope | Type | Payload |
|---|---|---|
| Both | `maintenance` | `{ type: 'maintenance', reason }` |
| Authenticated | `progress` (backup) | `{ type: 'progress', value }` |
| Authenticated | `progress` (download) | `{ type: 'progress', requestId, progress }` |
| Authenticated | `complete` (download) | `{ type: 'complete', requestId }` |
| Authenticated | `download-error` (download) | `{ type: 'download-error', requestId }` |
| Authenticated | `update-progress` | `{ type: 'update-progress', stage, message, value, ...extra }` |
| Authenticated | `update-complete` | `{ type: 'update-complete', success, runId, summary }` |
| Authenticated | `update-restore-complete` | `{ type: 'update-restore-complete', success, runId, details|error }` |
| Authenticated | `minecraft-chat-message` | Complete GET-equivalent committed message DTO. |
| Authenticated | `minecraft-chat-session-reset` | New current session plus epoch/revision, runtime, setting, and health state. |
| Authenticated | `minecraft-chat-session-status` | Current epoch/revision, capability, health, runtime, session, and baseline fields. |
| Authenticated | `player-roster-snapshot` | `{ serverId, observedAt, revision, roster: { source, quality, observedAt }, players }`. |
| Authenticated | `player-center-invalidation` | A reason/revision notification telling clients to refetch durable player/profile/access state. |

An authenticated connection receives the current `minecraft-chat-session-status` snapshot before ordinary events. Events racing that snapshot are held in a bounded initialization FIFO; stale status revisions are discarded and newer events drain in order. Overflow closes with code `1013`, after which the client uses paged `afterId` history catch-up. Chat messages are broadcast only after the corresponding `sent` database transition commits.

Backup and download retain their existing shared `progress` type with different payload shapes. Frontend consumers ignore authenticated event types that are irrelevant to their page.

## 12. Data Persistence Specification

### SQLite files

- `users.db`
- `token_blacklist.db`
- `server_logs.db`
- `sftp_activity_log.db`
- `updates.db`
- `chat.db` (or `CHAT_DB_PATH`)
- `players.db` (or `PLAYER_DB_PATH`)

### 12.1 `users.db` tables

#### `users`

| Column |
|---|
| `id` |
| `username` |
| `username_normalized` |
| `password_hash` |
| `role` |
| `must_reset_password` |
| `temp_password_enc` |
| `disabled` |
| `token_version` |
| `last_login_at` |
| `last_failed_login_at` |
| `failed_login_count` |
| `locked_until` |
| `last_password_reset_at` |
| `ui_theme` |
| `color_scheme` |
| `created_at` |
| `updated_at` |

Indexes:

- Unique index on `username_normalized`.

#### `user_login_history`

| Column |
|---|
| `id` |
| `user_id` |
| `logged_in_at` |
| `ip_address` |

#### `user_audit_log`

| Column |
|---|
| `id` |
| `actor_user_id` |
| `target_user_id` |
| `action` |
| `metadata` |
| `ip_address` |
| `created_at` |
| `source_event_id` (nullable, uniquely indexed when present) |

#### `webauthn_credentials`

| Column |
|---|
| `id` |
| `user_id` |
| `credential_id` |
| `public_key` |
| `counter` |
| `transports` |
| `created_at` |
| `last_used_at` |

Indexes:

- Index on `user_id`.
- Unique `credential_id`.

#### `webauthn_challenges`

| Column |
|---|
| `id` |
| `user_id` |
| `type` |
| `challenge` |
| `expires_at` |

Constraints:

- Unique `challenge`.

### 12.2 `token_blacklist.db`

Table: `blacklisted_tokens(token TEXT UNIQUE)`

Purpose:

- Stores invalidated JWTs post-logout.
- Cleanup routine removes expired blacklisted tokens by decoding JWT `exp`.

### 12.3 `server_logs.db`

Table: `server_logs(id, action, timestamp)`

Purpose:

- Records high-level server actions (login/logout/start/stop/restart/backup milestones).

### 12.4 `sftp_activity_log.db`

Table: `sftp_activity_log(id, username, action, file_path, timestamp, ip_address)`

Purpose:

- Records SFTP upload/download activity events.

### 12.5 `updates.db`

Tables:

- `update_state(key, value, updated_at)`: latest/current version cache and refresh timestamps.
- `update_checks(...)`: persisted preflight reports (`report_json`) including Java, disk, Fabric, mods, operation, recommendation metadata, and advanced compatible-target metadata.
- `update_runs(...)`: apply/restore run records, status, error, timings, operation-aware mode details, and full summary payload (`details_json`).
- `mod_source_cache(...)`: Modrinth resolution cache keyed by file SHA-1.
- `update_lock(id=1, owner, created_at)`: single-writer lock to prevent concurrent updates.

Recovery behavior:

- On process start, stale `update_lock` is removed.
- Any `update_runs` left in `running` state are marked failed with restart reason.

### 12.6 `chat.db`

The chat store is independent of the control-plane databases so a chat migration/runtime failure can be isolated. It opens lazily with foreign keys, WAL mode, `synchronous=FULL`, and a busy timeout. Store writes are serialized, and message ingestion commits parsed rows and the byte cursor in one transaction.

Tables:

- `chat_sessions`: one active session per `server_id`, runtime identity, start/end reasons, history completeness, and baseline readiness.
- `chat_messages`: structured Minecraft/panel events, actor snapshots, timestamps/confidence, log provenance, client idempotency UUID, and `pending|sent|failed|unknown` delivery state.
- `chat_ingest_cursor`: current session, log provenance/generation, committed byte offset, and timestamp-reconstruction state.
- `chat_settings`: persistent global panel-sending switch.
- `chat_audit_outbox`: atomic settings-change audit intents delivered idempotently into `users.db` using `source_event_id`.

Only `sent` rows are returned to readers. A stale `pending` panel message becomes `unknown` after process restart and is never automatically resent. Minecraft rows are unique by log provenance/generation/offset rather than message body, so identical legitimate chat lines remain distinct.

`CHAT_RETENTION_DAYS=0` retains ended sessions. Positive retention prunes only sufficiently old ended sessions and preserves active/current history. Delivered settings-audit outbox rows are pruned separately after their retention window.

Do not back up a live `chat.db` as an ordinary single-file copy while WAL is active. Use SQLite's backup mechanism or checkpoint and copy the database consistently with its WAL/SHM files. Graceful shutdown performs a truncate checkpoint before closing.

### 12.7 `players.db`

The Player Store is server-scoped, serialized, restart-safe, WAL-backed, `synchronous=FULL`, and
created with owner-only file permissions. Its forward-only schema separates:

- UUID profiles and bounded verified name history;
- lower-confidence/name-only/external identity observations;
- deduplicated live/backup snapshots with sparse changed statistics/advancements, retained playtime
  observations, and scoreboard values;
- privacy-bounded player events and current observed presence;
- HMAC-only link challenges and unique active panel-player links;
- durable permanent/temporary access grants and observed allowlist ownership; and
- durable backup/log fingerprints plus collector cursors/status.

Inventories, coordinates, health, IP addresses, private messages, authentication tokens, and raw
logs are not ingested. Modern player `.dat` files contribute only safe UUID filename/`lstat`
metadata. A legacy Bukkit/backups-only reader may open bounded `.dat`/`.dat_old` files, but it
constructs and persists only `bukkit.firstPlayed`, `bukkit.lastPlayed`, and
`bukkit.lastKnownName`; all other NBT payloads are structurally skipped and never materialized.
Current cumulative snapshots default to daily. Historical world backups default to the
latest snapshot per backup date folder; both legacy `date/world` and newer `date/hour/world` layouts
are supported. Explicit maintenance tooling can request all snapshots, but the web API cannot control
filesystem sampling. Unchanged backup/log inputs are skipped across restarts; changed versions are
reprocessed.

## 13. Background Workers and Heavy Pipelines

### `backend/workers/downloadWorker.js`

Responsibilities:

- Connect to SFTP independently.
- Download target (file or directory).
- Create ZIP artifact in OS temp.
- Emit progress messages to parent thread.

Key implementation details:

- Directory zipping invokes `stdbuf -oL zip -r` and parses `zip` stdout.
- File counting for zip progress uses `find ... | wc -l`.
- Generated archive path uses `<requestId>.zip` in OS temp.

### `backend/workers/heicWorker.js`

Responsibilities:

- Convert HEIC buffer to JPEG (`heic-convert`).
- Resize with `sharp` to 800x600.
- Persist cache file and return status to parent.

## 14. Frontend Surface and Page Contracts

### Pages

- `/` -> `public/login.html`
- `/index.html` -> control panel
- `/sftp.html` -> SFTP browser
- `/set-password.html` -> onboarding password reset
- `/account.html` -> password + passkey management
- `/admin.html` -> user administration
- `/admin-logins.html` -> per-user login history
- `/admin-audit.html` -> audit log explorer
- `/maintenance.html` -> maintenance notice page

### Frontend script ownership

- `public/login.js`: password and passkey login flows.
- `public/script.js`: control panel actions + backup progress UI + Server Info modal/gallery + update status polling/preflight/apply UX + WS handling.
- `public/serverChat.js`: chat history/reconnect/send state, epoch/revision reconciliation, unread/filter preferences, rendering, modal focus, and admin diagnostics/settings.
- `public/playerCenter.js`: live roster revisions, profile/trend rendering, link challenges, admin access grants, and unverified legacy candidate review.
- `public/sftp.js`: browse/upload/download/preview UX + WS download tracking.
- `public/account.js`: password change and passkey CRUD.
- `public/admin.js`: admin user lifecycle UI + update history table + update summary modal.
- `public/admin-logins.js`: login history UI.
- `public/admin-audit.js`: audit log filters and rendering.
- `public/webauthn.js`: browser-side WebAuthn helper transformations.
- `public/appearance.js`: shared account menu, theming, and button-lighting behavior.

### Update UX contract (control panel + admin)

- Update button is hidden when no newer Fabric-supported Minecraft target exists (`latestFabricSupportedVersion <= currentVersion`).
- Update button severity icon is yellow hazard for compatibility warnings and red stop for Java-blocking conditions.
- Clicking update always runs preflight before apply and preserves the normal update-only latest-target flow.
- Server Management > Server Version opens the advanced version selector even when no update is available. Right-clicking the update button also opens Advanced when the update button is visible. Advanced uses one Minecraft version dropdown; the action button changes between update and downgrade based on the selected version.
- Advanced downgrade selections show a prominent warning and an acknowledgement checkbox. That warning/checkbox is not shown for update selections.
- If no conflicts and preflight is clear, update starts immediately (no choice modal).
- If conflicts exist, modal presents explicit options (Cancel, change server + compatible mods, or server-only with mods moved out).
- Regular update conflicts may show a compatible intermediate target button when discovered. Advanced conflicts may show multiple compatible target options.
- During update/downgrade apply, main server controls are disabled.
- During apply, the update button switches to animated `Updating...` or `Downgrading...`.
- During apply, status text and WS progress messages drive in-page progress feedback.
- On completion/failure, a summary modal renders updated vs not-updated mods plus run metadata.
- Summary metadata/path details are role-aware: admins can see full archive/snapshot paths, non-admin users see sanitized labels.
- Admin Management includes a server update history table with operation-aware labels and one-click summary modal replay per run.

### Server Info UX contract

- Server Management > Server Info opens the read-only Server Info modal.
- The modal fetches `/server-info`, renders server facts, lore, screenshot eras, and installed mods.
- The `Current Mods` fact is an in-modal jump link to the installed-mods section.
- Screenshot tabs switch eras; thumbnail clicks switch the active image; Prev/Next and arrow keys move through the active era.
- The thumbnail rail scrolls vertically when image count exceeds the main screenshot stage height. Hidden thumbnails are hinted through scroll-linked blurred top/bottom edge flows so the rail does not become a long unbounded column.
- Clicking the stage image opens a full image viewer with wheel zoom and drag-to-pan. `Full Resolution` links to the original asset.

### Server Chat UX contract

- Desktop uses a fixed corner chat panel; mobile (`max-width: 768px`) uses a full-viewport modal with safe-area padding and a focus trap.
- The Update and Server Chat buttons share a bottom-left action stack. Update remains above Chat when visible.
- History initially loads the newest 200 rows, loads older pages at the top, and uses lossless paged `afterId` catch-up after reconnect.
- GET, POST, and WebSocket DTOs merge idempotently by session key and database ID. Epoch/revision guards prevent delayed HTTP responses from regressing newer socket state.
- Chat and Activity filters are display-only. Activity covers join, leave, death, and advancement events.
- Unread state is browser-local and keyed by panel user/server/session. First-visit backfill is a read baseline; later unseen rows are counted. The badge displays `500+` after the presentation cap while synchronization continues without a cap.
- The composer starts disabled and remains fail-closed until authoritative capabilities load. It is disabled while offline, catching up, locked, read-only, unavailable, disconnected, or sending.
- Input is NFC-normalized/trimmed for preview. The UI shows Unicode code points and, for `tellraw-v1`, exact UTF-8 Screen payload bytes including the trailing carriage return. Server validation remains authoritative.
- Rendering creates DOM nodes and assigns `textContent`; Minecraft/player text is never inserted as HTML.
- The header separates socket connection state from chat health and shows sanitized session start/end/completeness context.
- Admins can persistently disable panel sending and request redacted diagnostics. Non-admins never receive admin diagnostic payloads.
- Escape/toggle/X close the surface; desktop is non-modal, mobile uses `aria-modal`, background inertness, focus restoration, 44 px targets, and reduced-motion behavior.

### Player Center UX contract

- A purple `Player Tracking` launcher is fixed in the lower-right safe area, opposite the existing
  lower-left chat/update stack, and uses the control panel's pointer lighting variables.
- Desktop opens a large anchored panel; mobile uses the full viewport with safe-area padding, inert
  background, focus trap, Escape close, and focus restoration.
- Roster authority/freshness is stated in text as well as color. Cached profiles remain useful while
  live presence is stale, offline, best effort, or unavailable.
- Profiles show observed playtime, current session, first/last evidence, selected stats,
  advancements, backup-derived deltas, and observed sessions. Missing or pre-coverage history is not
  rendered as zero or “lifetime.”
- “Last seen” comes only from gameplay activity. File modification times are visibly labeled as
  estimates because transfers, copies, and restores can reset them; cache/import time is never shown
  as player activity.
- Legacy Bukkit `firstPlayed`/`lastPlayed` values are direct server-embedded evidence. They may repair
  an advancement history reset, but never override a newer exact join/leave event. Embedded
  `lastKnownName` creates bounded verified name history for that UUID; it does not make an old name
  the current name when newer server-authenticated evidence exists.
- Current-name projection prefers the server profile cache/authentication history over a stale
  whitelist label. Both names remain searchable verified history when their UUID evidence agrees.
- All remote values are inserted through `textContent` and safe element attributes. NameMC opens in a
  new `noopener,noreferrer` tab and recorded results remain visibly unverified, time-stamped candidates;
  the UI warns that names may have been reassigned.
- Admin Access and ordinary self-linking are separate capability-gated views. Linking never grants
  panel administration or Minecraft operator status.

### Theme system

- Base glass theme: `public/style.css`
- Flat theme override: `public/style.flat.css`
- Shared late-loaded chat component layer: `public/chat.css`
- Shared late-loaded Player Center layer: `public/playerCenter.css`
- Page-specific layers: `styleSFTP.css`, `styleAdmin.css`, `styleLogin.css`, `styleMaintenance.css`
- User settings are persisted via `/appearance` and reflected as `data-ui-theme` on `<body>` (`glass` or `flat`) and `data-color-scheme` on `<body>` (`system`, `light`, `dark`).

Detailed UI contract is documented in `STYLE_GUIDE.md`.

## 15. Operational Behavior Notes

- SFTP page performs frequent refresh polling while user is active (1s interval) and stops after inactivity timeout (5 minutes).
- Backup frequency limit is enforced in-memory by hour key; process restarts reset the limiter.
- Maintenance mode flag is in-memory; process restart clears it.
- Update status refresh is cached/polled on multiple layers: backend refresh timer every 6 hours (`updateService.startStatusRefreshTimer`), frontend status polling every 5 minutes plus tab-visibility return, and frontend background preflight TTL of 10 minutes for warning/icon refresh.
- Video thumbnail pre-caching can be expensive on large SFTP trees because it recursively crawls from `/` at startup.
- Server Info screenshot assets are intentionally ignored by git via `assets/server-info/`; dropping new supported images into that folder tree is enough for the endpoint to discover them on the next request.
- Logging timestamps are written using `America/New_York` locale formatting, not ISO-8601.
- Backup hour-gating uses Eastern date-hour keying and in-memory state only.
- Minecraft runtime reconciliation polls Screen/log state without overlapping probes. `starting` means Screen exists but the current runtime has not proved readiness; only `ready` permits panel sending.
- Chat backfill reads bounded byte chunks and normal `YYYY-MM-DD-N.log.gz` archives. Missing segments or exhausted safety bounds are surfaced as incomplete history rather than silently treated as complete.
- Backfill rows commit silently. Live chat WebSocket events begin only after the immutable baseline target commits, which prevents first-visit history from becoming unread noise.
- Chat storage failure starts one jittered recovery loop (5 seconds, doubling to 5 minutes). Log/tailer failure keeps stored reads available and retries independently. Screen failure disables only sending and never automatically resends uncertain messages.
- The admin sending switch is durable and fail-closed. A priority admission barrier prevents queued/new sends from passing an accepted disable request; one send already holding the mutex may finish before the disable commit.
- Chat health payloads contain stable reason codes and aggregate counters only. Raw log lines, filesystem paths, exception text, usernames, message bodies, credentials, and IPs are not exposed.
- Player world files are collected daily with stable bounded reads. Unchanged current snapshots and
  durable unchanged backup/log fingerprints are skipped; dated backups are sampled daily, processed
  with event-loop yields, and imported in the background so live roster delivery is not blocked by
  historical reconstruction.
- Cache-only identities, allowlist-only entries, access subjects, and rejected authentication
  handshakes remain outside the main player count. Same-spelling legacy scoreboard evidence may be
  suppressed from the main list without transferring its data to a UUID; ambiguity stays visible in
  identity-review metadata.
- Native Management Protocol failure degrades live authority/link/access independently. The exact-log
  roster remains best effort, while stored profiles and trends remain readable.

## 16. Security Characteristics

Implemented safeguards:

- JWT expiration and verification.
- Blacklist on logout.
- Token version invalidation for sensitive account actions.
- Account disable support.
- Failed-login lockout and per-IP throttling.
- Admin-only route gating.
- Onboarding gate for users with temporary credentials.
- Temp password encryption at rest (AES-256-GCM).
- Exact configured Origin checks for authenticated WS upgrades and chat mutations; trust is never derived from the request Host header.
- Authenticated/public WebSocket separation, token revalidation, connection/buffer caps, and heartbeat cleanup.
- Fixed-component `tellraw` construction through `JSON.stringify`, a 256-code-point limit, final UTF-8 payload cap, control/bidi rejection, leading-command rejection, and argv-only Screen execution.
- Chat idempotency UUIDs and explicit `pending`, `sent`, `failed`, and `unknown` delivery states prevent unsafe automatic replay.
- Chat and admin-health responses are `no-store`; message rendering uses `textContent`.
- Player Center uses exact server scoping, role capabilities, 8 KiB mutation bodies, strict field
  allowlists, UUID/name validation, same-origin mutation checks, typed native protocol methods, audit
  metadata without codes/secrets, HMAC-only link challenges, and panel-owned allowlist removal.

Important design properties to be aware of:

- Some pages are statically accessible, but protected actions rely on API auth + frontend redirects.
- Operational/chat WebSocket messages are authenticated and onboarded; the public path can receive maintenance only.
- `/downloads/:requestId` requires an authenticated, onboarded account and is visible only to the user who created that request. Progress, completion, and error events are scoped to that same user.
- `auth_token` cookie uses `secure: req.secure`; behind reverse proxies this requires proper proxy/TLS configuration.
- Chat mutations have explicit Origin-based CSRF protection. Older cookie-authenticated mutations should be reviewed separately because that protection is not automatically global.
- `localStorage` stores bearer token for frontend API usage.

## 17. Known Implementation Caveats

- `GET /status` remains public, but its values come from the authoritative Screen/log reconciler.
- Process-global `currentPath` in SFTP route module is shared state, not per-session state.
- Preview cache filenames are based on basename, so same-name files in different directories can collide.
- Backup and download share WS `type: 'progress'` with different payload shapes.
- Download archives are built inside isolated worker-thread temp directories and expire if they are not claimed within 15 minutes.
- Recommended compatible-target lookup scans a bounded release window (currently first 15 candidates between current and latest).
- Advanced compatible-target lookup scans a bounded release window and returns a limited set of compatible alternatives.
- Update/downgrade apply requires a non-stale preflight check (`<= 30 minutes`).
- Screen exit zero means Screen accepted the bytes; it does not prove Minecraft parsed the command or every player rendered it. RCON or a server-side bridge is required for stronger acknowledgement.
- Minecraft's default log prefix contains time of day but no date. Archive names, file metadata, session state, and midnight rollover are used to infer historical dates; ambiguous rows are marked with lower timestamp confidence.
- The log parser intentionally omits unknown/modded formats. Strict false negatives are preferred over exposing console or plugin output.
- Without the native Minecraft Management Protocol, live presence is a labeled best-effort log
  projection and private account linking/access mutation are intentionally unsupported. Enabling the
  protocol requires an explicit server configuration change and restart.
- Backup-derived trend lines represent observations and deltas between them. Missing intervals stay
  visible as gaps; the panel does not claim to know when activity occurred inside a gap.
- A name-keyed scoreboard row remains a legacy identity unless its own snapshot has an exact verified
  UUID/name co-observation for one known owner. Reacquisition gaps, recycled names, truncated identity
  history, and ambiguous owners all fail closed instead of being assigned automatically.
- Filesystem modification time is estimated activity evidence, not proof of a login time. In
  particular, a server transfer may give many older files the same timestamp; embedded advancement
  and region timestamps can establish older world history without changing that limitation. Legacy
  Bukkit `firstPlayed`/`lastPlayed` metadata is preferred for the exact historical boundary it
  records, while later file mtimes remain visibly estimated.
- Unread/filter preferences are local to one browser profile. They are isolated by panel user and session but are not synchronized across devices.
- v1 exposes only the current/latest chat session even though older ended sessions may remain in `chat.db`.

## 18. Local Development and Runbook

### Install and run

```bash
npm install
npm run start
```

Run the automated suite without touching the real Minecraft process or production databases:

```bash
npm test
```

### Default URLs

- `http://localhost:8087/`
- `http://localhost:8087/index.html`
- `http://localhost:8087/sftp.html`

### First-time bootstrap flow

1. Set `ADMIN_PASSWORD_HASH` in `.env`.
2. Start server.
3. Login as `admin` using password matching the configured hash.
4. Create users in Admin Management.
5. Users login with temporary password and are forced through `/set-password.html`.

### Chat deployment checklist

1. Set one or more exact production `APP_ORIGINS`; do not use wildcards or paths.
2. Confirm `MINECRAFT_SERVER_PATH/logs/latest.log` or set `MINECRAFT_LOG_PATH` explicitly.
3. Set the correct `MINECRAFT_SCREEN_SESSION` and optional `MINECRAFT_TIME_ZONE`.
4. Keep `CHAT_DB_PATH` on durable local storage with restrictive filesystem permissions.
5. Start with `CHAT_SCREEN_MAX_COMMAND_BYTES=512`. Before production, smoke-test that configured value with a test server/player using ASCII, escaped quotes/backslashes, and emoji near the limit; do not raise it without a new host-level test.
6. Start the panel while Minecraft is both offline and already running; verify runtime/session recovery and that sending becomes available only after readiness/baseline status.
7. Exercise a panel restart, Minecraft restart/crash, backup, update, log rotation, and socket reconnect before production sign-off.
8. Verify the admin sending switch survives panel restart and keeps history readable while disabled.

### Chat troubleshooting

- `database_unavailable`: verify `CHAT_DB_PATH` parent permissions/disk availability. Core controls should remain usable while the bounded retry loop runs.
- `log_unreadable`: verify the Minecraft log path and permissions. Stored history remains readable; new ingestion pauses and retries.
- `send_transport_unavailable`: verify the named Screen session exists and the panel user can execute `screen -ls`/`screen -S ... -X stuff`.
- `history_incomplete`: the configured archive/byte recovery bound could not prove a complete runtime chain; existing parsed data remains usable.
- `CHAT_CATCHING_UP`: wait for the baseline-ready status. Sending is deliberately blocked until initial recovery reaches a stable boundary.
- `CHAT_DELIVERY_UNKNOWN`: do not automatically reuse the UUID. The command may have reached Screen; deliberate retry creates a new UUID.

For diagnostics, admins can expand Chat diagnostics in the UI or call `GET /admin/chat/health`. Responses are intentionally redacted; use server-side structured logs for deeper investigation.

## 19. Repository Layout

- `app.js`: server entrypoint and route wiring.
- `backend/config/`: external service config.
- `backend/db/`: SQLite adapters and schema evolution.
- `backend/middleware/`: auth/role/onboarding enforcement.
- `backend/routes/`: all HTTP API/page routes.
- `backend/services/`: maintenance, authoritative Minecraft process/console, chat/tailer/realtime, update, and server-info services.
- `backend/state.js`: in-memory runtime state.
- `backend/utils/`: logging, crypto, validation, parsing helpers.
- `backend/workers/`: worker thread implementations.
- `public/`: HTML/CSS/JS frontend.
- `assets/`: icons, static images, and ignored Server Info screenshots.
- `test/`: Node test-runner suites and sanitized command/log fixtures.
- `STYLE_GUIDE.md`: frontend appearance contract.

## 20. Direct NPM Runtime Dependencies

From `package.json`:

- `@simplewebauthn/server`
- `archiver`
- `bcrypt`
- `dotenv`
- `express`
- `express-fileupload`
- `express-session`
- `fs-extra`
- `get-folder-size`
- `heic-convert`
- `jsonwebtoken`
- `jszip`
- `path`
- `pdf-image`
- `pipeline`
- `promises`
- `promisify`
- `recursive-readdir`
- `sharp`
- `sqlite3`
- `ssh2-sftp-client`
- `stream`
- `tslib`
- `unzipper`
- `ws`
