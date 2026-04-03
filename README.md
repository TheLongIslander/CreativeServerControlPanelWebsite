# Minecraft Server Control Panel + SFTP Browser

Engineering specification for the current implementation.

## 1. Purpose

This service is a self-hosted web control plane for:

- Minecraft server lifecycle operations (start, stop, restart).
- Compatibility-aware Minecraft/Fabric server updates with preflight checks, rollback snapshots, and mod migration.
- Scheduled backup execution and backup browsing over SFTP.
- Multi-user authentication with admin-managed accounts.
- Optional passkey (WebAuthn) login and passkey lifecycle management.

The system is implemented as a single Node.js process with Express HTTP routes, a WebSocket server, SQLite persistence, and worker threads for heavy I/O/CPU operations.

## 2. Scope

### In scope

- HTTP UI serving and JSON APIs.
- JWT auth, role enforcement, onboarding enforcement, account lockout and login throttling.
- Admin user management and user audit trails.
- SFTP file browsing, upload, preview, and download orchestration.
- Backup execution with progress telemetry.
- End-to-end update orchestration (status detection, preflight, apply, rollback, and update history).
- Graceful maintenance broadcast + process shutdown.
- User appearance preferences (theme + color mode).

### Out of scope

- Container orchestration.
- Horizontal scaling and distributed state.
- TLS termination.
- External identity providers.
- Automated DB migrations beyond startup-time SQLite column evolution.

## 3. Runtime Architecture

### Process model

One Node.js process (`app.js`) hosts:

1. HTTP server (Express).
2. WebSocket server (`ws`) attached to the HTTP server.
3. Worker threads for download zipping and HEIC conversion.
4. In-memory runtime state in `backend/state.js`.

### External dependencies

- Minecraft server host controlled via shell commands.
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

## 4. Startup and Shutdown Lifecycle

### Startup sequence

1. Load environment via `dotenv`.
2. Construct Express app and middleware stack.
3. Initialize users DB schema (`initUsersDb`).
4. Ensure bootstrap `admin` account (`ensureAdminUser`).
5. Initialize update DB/schema and recover update lock/run state (`updateService.initialize`).
6. Prime current/latest Minecraft version state for update status.
7. Start periodic update status refresh timer (`updateService.startStatusRefreshTimer`).
8. Start HTTP listener on `PORT` (default `8087`).
9. Attach WebSocket server to HTTP server.
10. Trigger background video thumbnail pre-cache crawl from SFTP root (`/`).

### Graceful shutdown

Trigger: typing `stop` in server STDIN (TTY only).

Steps:
1. Set `maintenanceMode = true` (in-memory).
2. Broadcast WebSocket maintenance message to all clients.
3. After delay, close WS clients/server, then close HTTP server.
4. Exit process (`0` on graceful path, forced `1` after timeout fallback).

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
| `START_COMMAND_PATH` | Yes | None | Script path executed for server start/restart. |
| `MINECRAFT_SERVER_PATH` | Yes | None | Source directory for backups. |
| `BACKUP_PATH` | Yes | None | Target root for backup output hierarchy. |
| `PORT` | No | `8087` | HTTP listen port. |
| `SFTP_HOST` | Yes | None | SFTP host. |
| `SFTP_PORT` | Yes | None | SFTP port. |
| `SFTP_USERNAME` | Yes | None | SFTP username. |
| `SFTP_PASSWORD` | Yes | None | SFTP password. |
| `TMP_UPLOAD_SERVER_PATH` | Yes | None | Temporary upload location for `express-fileupload`. |
| `VIDEO_CACHE_DIR` | No | OS temp-based path | Video thumbnail cache directory override. |
| `NODE_ENV` | No | unset | Affects WebAuthn fallback origins in non-production mode. |

### Required system binaries

- `screen`
- `rsync`
- `zip`
- `unzip`
- `find`
- `ffmpeg`
- `GraphicsMagick` or `ImageMagick` + `Ghostscript` (PDF preview path)
- `stdbuf` (used by directory zipping in download worker)
- `df` (disk-space preflight for update flow)
- `java` (or explicit Java path used by launch script; required for Fabric installer and runtime checks)

## 6. Middleware and Global HTTP Settings

Configured in `app.js`:

- URL-encoded parser limit: `50gb`.
- JSON parser limit: `50gb`.
- File upload middleware: temp-file mode enabled.
- File upload temp directory: `TMP_UPLOAD_SERVER_PATH`.
- File upload max file size: `50GB`.
- File-size overflow handler returns HTTP `413`.

Static serving:

- `express.static('public')`
- `express.static('assets')` mounted at `/assets`

## 7. In-Memory Runtime State

Defined in `backend/state.js`:

- `serverRunning` (`boolean`) default `false`
- `lastBackupHour` (`string|null`) default `null`
- `maintenanceMode` (`boolean`) default `false`
- `updateLocked` (`boolean`) default `false`
- `updateLockOwner` (`string|null`) default `null`

Notes:

- State is process-local and resets on restart.
- `serverRunning` reflects route-side intent/state transitions, not a direct OS process probe.

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
| `GET` | `/admin/updates` | Query: `limit` | Update run history with mode labels, version path, counts, status, and detailed summary payload. |
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
| `GET` | `/status` | No | Returns `{ running, updateInProgress }` from in-memory state. |
| `POST` | `/start` | JWT + onboarded | Executes `sh $START_COMMAND_PATH`, sets `serverRunning=true`, logs action. Returns `423` if update is in progress. |
| `POST` | `/stop` | JWT + onboarded | Sends `stop` to `screen -S MinecraftSession`, sets `serverRunning=false`, logs action. Returns `423` if update is in progress. |
| `POST` | `/restart` | JWT + onboarded | Stops via `screen`, waits 3s, starts via service helper, logs action. Returns `423` if update is in progress. |

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
| `GET` | `/downloads/:requestId` | No | None | Streams temp ZIP file and deletes it after response finishes. |

Worker behavior:

- Directory targets: recursively download then zip with progress.
- File targets: download and zip unless already `.zip` (then renamed).
- Progress events sent via WebSocket.

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

### 10.11 Update routes

All update routes require `authenticateJWT + requireOnboarded`.

| Method | Path | Request | Behavior |
|---|---|---|---|
| `GET` | `/updates/status` | Query: `refresh=1|true` (optional) | Returns update status snapshot: current version, latest Mojang release, latest Fabric-supported release, availability, lock state, and snapshot-restorability state. |
| `POST` | `/updates/check` | `{ targetVersion? }` | Runs preflight: Java, disk, Fabric support, mod compatibility, conflict analysis, recommended compatible target lookup. Persists check in `updates.db`. |
| `GET` | `/updates/check/:id` | None | Returns a stored preflight check report by id. |
| `POST` | `/updates/apply` | `{ checkId, mode }` | Applies update using a fresh preflight check (`<= 30m`), with lock, snapshot, artifact install, mod migration, smoke test, auto-rollback on failure, and run summary persistence. |
| `POST` | `/updates/restore-latest` | None | Restores latest snapshot-bearing update run. Intended for administrative/manual recovery paths. |

Supported apply modes:

- `server_and_compatible_mods`: update server and keep compatible mods (archive moved/replaced jars).
- `server_only_move_all_mods`: update server and move all current mods out of `mods/` into versioned archive folder.

Apply pipeline (high-level):

1. Acquire global update lock.
2. Stop running server session (if running).
3. Create full snapshot backup (`UpdateSnapshots/...`).
4. Download target server jar + Fabric installer + install loader.
5. Apply mod plan (download compatible updates, move blocked/unknown/old jars to archive).
6. Run startup smoke test (process, logs, and local TCP probe).
7. Persist final state + detailed summary and release lock.
8. On failure: rollback from snapshot and restore prior running/offline state.

## 11. WebSocket Protocol

The server sends broadcast messages to all connected clients.

### Message types

| Type | Payload |
|---|---|
| `maintenance` | `{ type: 'maintenance', reason }` |
| `progress` (backup) | `{ type: 'progress', value }` |
| `progress` (download) | `{ type: 'progress', requestId, progress }` |
| `complete` (download) | `{ type: 'complete', requestId }` |
| `update-progress` | `{ type: 'update-progress', stage, message, value, ...extra }` |
| `update-complete` | `{ type: 'update-complete', success, runId, summary }` |
| `update-restore-complete` | `{ type: 'update-restore-complete', success, runId, details|error }` |

Notes:

- Backup and download share `type: 'progress'` with different payload shapes.
- Update flow uses separate message types (`update-progress`, `update-complete`, `update-restore-complete`).
- No authenticated channel separation exists at WS level.
- Frontend pages selectively ignore irrelevant payload shapes.

## 12. Data Persistence Specification

### SQLite files

- `users.db`
- `token_blacklist.db`
- `server_logs.db`
- `sftp_activity_log.db`
- `updates.db`

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
- `update_checks(...)`: persisted preflight reports (`report_json`) including Java, disk, Fabric, mods, and recommendation metadata.
- `update_runs(...)`: apply/restore run records, status, error, timings, and full summary payload (`details_json`).
- `mod_source_cache(...)`: Modrinth resolution cache keyed by file SHA-1.
- `update_lock(id=1, owner, created_at)`: single-writer lock to prevent concurrent updates.

Recovery behavior:

- On process start, stale `update_lock` is removed.
- Any `update_runs` left in `running` state are marked failed with restart reason.

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
- `public/script.js`: control panel actions + backup progress UI + update status polling/preflight/apply UX + WS handling.
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
- Clicking update always runs preflight before apply.
- If no conflicts and preflight is clear, update starts immediately (no choice modal).
- If conflicts exist, modal presents explicit options (Cancel, update server + compatible mods, or update server-only with mods moved out).
- Optional compatible intermediate target button is shown when discovered.
- During update apply, main server controls are disabled.
- During update apply, update button switches to animated `Updating...`.
- During update apply, status text and WS progress messages drive in-page progress feedback.
- On completion/failure, a summary modal renders updated vs not-updated mods plus run metadata.
- Summary metadata/path details are role-aware: admins can see full archive/snapshot paths, non-admin users see sanitized labels.
- Admin Management includes a server update history table with one-click summary modal replay per run.

### Theme system

- Base glass theme: `public/style.css`
- Flat theme override: `public/style.flat.css`
- Page-specific layers: `styleSFTP.css`, `styleAdmin.css`, `styleLogin.css`, `styleMaintenance.css`
- User settings are persisted via `/appearance` and reflected as `data-ui-theme` on `<body>` (`glass` or `flat`) and `data-color-scheme` on `<body>` (`system`, `light`, `dark`).

Detailed UI contract is documented in `STYLE_GUIDE.md`.

## 15. Operational Behavior Notes

- SFTP page performs frequent refresh polling while user is active (1s interval) and stops after inactivity timeout (5 minutes).
- Backup frequency limit is enforced in-memory by hour key; process restarts reset the limiter.
- Maintenance mode flag is in-memory; process restart clears it.
- Update status refresh is cached/polled on multiple layers: backend refresh timer every 6 hours (`updateService.startStatusRefreshTimer`), frontend status polling every 5 minutes plus tab-visibility return, and frontend background preflight TTL of 10 minutes for warning/icon refresh.
- Video thumbnail pre-caching can be expensive on large SFTP trees because it recursively crawls from `/` at startup.
- Logging timestamps are written using `America/New_York` locale formatting, not ISO-8601.
- Backup hour-gating uses Eastern date-hour keying and in-memory state only.

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

Important design properties to be aware of:

- Some pages are statically accessible, but protected actions rely on API auth + frontend redirects.
- WebSocket messages are broadcast globally and not scoped per-user.
- `/downloads/:requestId` is unauthenticated and functions as a temporary capability URL.
- `auth_token` cookie uses `secure: req.secure`; behind reverse proxies this requires proper proxy/TLS configuration.
- No explicit CSRF defense is implemented for cookie-authenticated routes.
- `localStorage` stores bearer token for frontend API usage.

## 17. Known Implementation Caveats

- `GET /status` is public and driven by in-memory flags, not direct process introspection.
- Process-global `currentPath` in SFTP route module is shared state, not per-session state.
- Preview cache filenames are based on basename, so same-name files in different directories can collide.
- Backup and download share WS `type: 'progress'` with different payload shapes.
- Download worker requires `stdbuf`; missing utility will break directory zip progress pipeline.
- Recommended compatible-target lookup scans a bounded release window (currently first 15 candidates between current and latest).
- Update apply requires a non-stale preflight check (`<= 30 minutes`).

## 18. Local Development and Runbook

### Install and run

```bash
npm install
npm run start
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

## 19. Repository Layout

- `app.js`: server entrypoint and route wiring.
- `backend/config/`: external service config.
- `backend/db/`: SQLite adapters and schema evolution.
- `backend/middleware/`: auth/role/onboarding enforcement.
- `backend/routes/`: all HTTP API/page routes.
- `backend/services/`: maintenance/server-control services.
- `backend/state.js`: in-memory runtime state.
- `backend/utils/`: logging, crypto, validation, parsing helpers.
- `backend/workers/`: worker thread implementations.
- `public/`: HTML/CSS/JS frontend.
- `assets/`: icons and static images.
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
