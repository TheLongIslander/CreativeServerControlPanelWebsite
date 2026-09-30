# Multi-server panel usage

After login or password setup, `/servers.html` shows a floating tile for each server the account can access. `/servers` redirects to this overview. Tiles show the observed lifecycle state, current operation when present, and backup-browser connection state. The overview refreshes every ten seconds while visible; connection failures mark the displayed information as stale.

Choose a tile to open `/servers/:serverId`. Each page retains the existing lifecycle, update, chat, Player Center, Server Info, and backup-browser layout. The server name stays visible above its controls and in stop/restart/update confirmations. **All servers** returns to the overview. Opening a different page does not stop servers or cancel backend operations. Old Creative links through `/index.html` still resolve to `default`.

Non-admin users share two active-server slots. When both are occupied, Start is disabled on another stopped server with an explanation. Stop and Restart remain available on an accessible running server, subject to operation locks. Administrators can start beyond the two-slot limit. The backend makes the authoritative admission decision; stale browser information cannot reserve a slot.

## Tab-local memory and server identity

The URL determines the server for every request and WebSocket subscription. There is no shared “current server” preference. Different tabs can manage different servers independently.

Chat drafts, chat scroll position, unread/filter state, and backup-browser directories are stored separately for each account and server in `sessionStorage`. Returning to a server in the same tab restores its state without sending its draft. A changed chat session resets the old session's scroll position. Logging out clears remembered state. Losing server access clears that server's remembered data and returns to the overview. Back/forward cache restoration reloads the page to revalidate access and discard stale confirmations.

## Administration

Open **Account → Admin Management → Server Profiles** to register an existing installation. Enter a stable ID, display name, existing server directory, startup script, unique Screen session, timezone, and optional local backup folder. Java executable and heap overrides are optional; Pogeg's agreed maximum and initial heap are both `12288` MiB. SFTP remains disabled when registering a profile.

**Edit profile** changes a stopped server's configuration. The stable ID is not editable. Disabling or removing a profile requires the server to be stopped and preserves its files, backups, and history. Backend validation rejects unsafe paths, listener conflicts, and concurrent edits.

**User access** lists the panel accounts for that server. Expand a user to toggle server access and individual features: start, stop, restart, backup creation, backup browsing, downloads/previews, uploads/folder creation, updates/restores, reading chat, sending chat, player information, and linking their Minecraft account. Changes save immediately and persist across panel restarts. Existing users keep all features until restricted. Administrators always retain every permission. These restrictions supplement existing role checks; enabling a feature never grants admin privileges.

To prevent a user from taking a world copy, turn off **Browse server backups** for that user on the relevant server. This also blocks direct download, preview, and upload URLs. Alternatively, leave browsing enabled and turn off **Download and preview backup files**. Sending chat requires both read and send permissions. Turning off overall server access blocks every feature while preserving the individual settings for later.

Backend checks apply to scoped and legacy URLs and live chat/player events. Connected server pages reload when feature permissions change. Files already downloaded cannot be recalled, and operations already completed are not undone. Settings on one server do not affect other servers.

The **Server Update History** selector loads only the chosen server's runs. Switching the selector closes the previous summary and cancels its pending request; late responses cannot replace the selected server's history.

## Backup browser

**Server Management → Server Backups Browser** opens `/sftp.html?serverId=:serverId`. Once configured, the selected server's backup folder appears as `/`, with no parent navigation above it. The path bar, uploads, previews, and downloads all remain inside that folder. Visiting another server opens its own folder; returning in the same tab can restore that server's last subfolder. **Control Panel** returns to that same server. With SFTP unconfigured, the page instead shows an “awaiting setup” message and disables browsing and file mutations.

## Verification

The automated frontend tests cover fixed URL identity, separate user/server/tab memory, obsolete read cancellation, retained mutation targets, access revocation, back/forward revalidation, two-slot control behavior, unavailable runtime states, and delayed admin history responses. Existing chat, Player Center, and window-motion tests also pass.

Safari desktop was checked against an isolated fixture for tile navigation, the familiar server panel, admin profile/access views, dark and light glass themes, separate Creative/Survival drafts, and the disconnected SFTP page and return link. No production server or SFTP connection was used for these browser checks. Physical mobile-device verification remains separate from the responsive CSS and reduced-motion coverage.
