# Multi-server operation

The panel manages existing Minecraft installations on this Mac. `/servers.html` is the server tile overview; `/servers/<id>` opens that server's familiar control panel. The server ID stays fixed for each page and request. Opening a different tile does not start, stop, or retarget an operation.

## Profiles and access

Administrators register existing directories and scripts in **Admin → Servers**. Each profile owns its root directory, Screen session, launcher, Java/heap overrides, timezone, local backup destination, and optional SFTP root. Startup scripts are trusted administrator configuration. The panel generates a private launcher on each start. With **Panel RAM override** off, the admin editor reads RAM from the startup script and saving RAM edits updates its explicit `-Xmx`/`-Xms` flags; blank fields keep existing script values. Reopen the editor to pick up file changes. With the toggle on, RAM overrides apply only to the private launcher and leave the source script unchanged. Existing profiles with saved RAM overrides retain that mode. Script sync rejects ambiguous or dynamic heap flags and detects script changes made after opening the editor. It preserves the script’s GUI/headless arguments and never adds `nogui` automatically. It supports ordinary foreground Java scripts such as Creative's and Pogeg's `start.command`, as well as legacy scripts that already start their own Screen session.

The registry persists in `servers.db` (`SERVER_REGISTRY_DB_PATH`). On first startup, the existing environment configuration seeds ID `default`, preserving Creative's original `chat.db`, `players.db`, and `updates.db`. Later servers have separate databases and launchers under `data/servers/<id>` (`SERVER_DATA_PATH`). Once seeded, saved profiles are authoritative; edit them in Admin rather than changing the legacy environment paths. Existing data and files survive profile removal; IDs cannot be reused. Stop a server before editing, disabling, or removing its profile. Local backup storage is optional for lifecycle control, but backup creation, update application, and snapshot restore remain disabled until its explicit local backup destination is configured.

Users can access all enabled servers by default. Admins can deny a particular user's access to a particular server. The same rule applies to tiles, direct APIs, live events, files, previews, and downloads. Revocation closes affected WebSockets and rejects subsequent requests. Authentication and existing admin-only capabilities remain panel-wide.

## Runtime limits

Non-admins share two active/starting slots. Administrators can start additional servers; those servers still occupy slots when a non-admin attempts a start. No automatic eviction or start queue exists. Restart and maintenance operations retain a reservation while temporarily stopping a server. Unknown runtime state blocks admission until it can be verified.

One backup or update operation runs across the panel at a time to bound disk work. Each server also has its own operation guard. Update smoke tests use that server's managed launcher and reservation. Stop acts only on the chosen server. Graceful panel shutdown stops every owned runtime independently and suppresses maintenance restarts; failure to stop one does not skip the others. An abrupt OS kill or power loss cannot perform graceful shutdown; startup reconciles Screen sessions and retains existing update recovery records. Run one panel process for a registry. If an operation exceeds the shutdown drain deadline, shutdown reports failure and preserves its stores until the handler finishes; signal-based shutdown then exits with a failure status.

Directory overlap, duplicate Screen identities, and configured TCP/UDP listener conflicts are rejected. Game, query, RCON, Management Protocol, Simple Voice Chat, and Geyser listeners are inspected. Unrecognized mods may have additional listeners, so inventory these when registering another installation. Profiles register existing installations; they do not install Minecraft or configure remote hosts.

## Shared-account SFTP configuration

All migrated profiles start with `sftp.enabled=false` and no remote root. Existing environment credentials alone cannot enable file access. Startup does not connect or crawl thumbnails. An unconfigured server's file UI shows a pending-setup message; file APIs return `503 SFTP_NOT_CONFIGURED` before connection or worker creation.

When the account is ready:

1. Configure the shared backend `SFTP_HOST`, `SFTP_PORT`, `SFTP_USERNAME`, and `SFTP_PASSWORD` privately.
2. Set each profile's **SFTP root** to its exact, distinct absolute directory as seen by that account, and enable SFTP for the profile.
3. Verify that each remote root corresponds to its intended **local backup destination**. These are separate mappings, not interchangeable paths.
4. Test browsing, previews, uploads, and downloads with a restricted non-admin account before broadening the account's home directory.

The browser exposes the selected subtree as `/`. Parent traversal, injected absolute paths, sibling roots, and symbolic links are rejected. The shared SFTP account itself is not an OS isolation boundary; people with its raw credentials retain its underlying filesystem access. Folder permissions and SFTP jail/home settings are administered outside this app.

For example, an account whose home is `VirtualGladiators Server` can map Creative to `/Java Edition Servers/The Creative Server` and Pogeg Farm Server to `/Java Edition Servers/Pogeg Farm Server`. Each browser begins at its own virtual `/`; a previously visited subfolder can be restored within that server's scope in the same browser tab. Local backup roots must point to those same physical folders on the mounted backup drive.

Backups require an existing, writable destination before stopping Minecraft. A backup is copied into a hidden staging folder, then published under the date/hour folder only after rsync succeeds. An existing backup for that hour is preserved, including after a panel restart; ordinary copy failures remove their incomplete staging folder.

Transfers use shared connection and storage budgets. Current limits are 4 connections, 2 uploads, 2 previews, a 40 GiB temporary-storage budget, 10 GiB per transfer, 20,000 ZIP entries, and 100,000 download entries. ZIP uploads are inspected and staged before remote writes; unsafe links, traversal, and unsupported oversized/Zip64 archives are rejected. Temporary download artifacts are bound to their requesting user, server, and root and are reauthorized on delivery. Preview generation needs `ffmpeg` and `pdftoppm` for the corresponding formats.

## API and persistence

- `GET /api/servers`: accessible profiles, runtime summaries, shared slots.
- `/api/servers/:id/{status,start,stop,restart,backup,updates/*,chat/*,admin/chat/*,server-info}`: server-scoped existing features.
- `/api/servers/:id/{players,player-links,access-grants}`: server-specific Player Center.
- `/api/servers/:id/{sftp/list,upload,download,downloads/:requestId,download-preview}`: scoped files.
- `/admin/servers` and `/admin/servers/:id/access`: administrator profile/access management.
- `/admin/updates?serverId=<id>`: selected server's update history.
- `/ws?serverId=<id>`: authenticated server-specific events. Maintenance remains panel-wide.

Legacy control and file URLs remain explicitly tied to `default` and enforce its access restrictions. They never follow a mutable globally selected server. Authenticated image requests for Creative's historical gallery also require access to `default`.

Per-server drafts, scroll positions, and file directories live in tab-scoped session storage, partitioned by user and server. Logout or revocation clears the relevant state. Navigation aborts obsolete reads, while submitted mutations remain tied to their original server.

## Verification and rollback

Manual Player Center death corrections can be stored in `data/servers/<id>/player-death-corrections.json`, using `{ "version": 1, "players": { "<uuid>": { "name": "Player", "statsDeaths": 7, "displayDeaths": 2, "correctedAt": "2026-09-28T23:37:59.000Z", "reason": "Matched server leaderboard" } } }`. The panel applies the difference to that UUID's current death statistic, so subsequent deaths continue counting. Saved Minecraft files, recorded statistics, and retained log events remain intact. If the raw statistic falls below the recorded baseline, the correction is ignored as a possible reset. Remove a player's entry to undo their display correction. This local file is ignored by Git and belongs in panel backups.

Run `npm test`. Tests cover concurrent slot admission, independent stores, profile persistence/collisions/access, scoped realtime delivery and revocation, file containment and disabled connections, and browser context isolation.

Before deployment, preserve the repository including ignored databases/configuration and the server folders. Use consistent SQLite snapshots when the panel is running. Restore the matching repository/configuration/database checkpoint together after stopping the panel; retain separately created worlds/backups rather than deleting them during rollback. Local operator-specific checkpoint and disposable-test receipts are recorded in `plans.md` and the Downloads test directories.

### Per-server update pipeline

In **Admin → Server Profiles → Edit profile**, uncheck **Enable update pipeline** for modpacks or installations pinned to specific versions. Stop the server before saving profile changes. The setting defaults to enabled, persists across panel restarts, and only affects that profile. Disabling it stops background update discovery and blocks preflight checks, upgrades, downgrades, and update snapshot restores. Installed-version information and historical update records remain available. Re-enable the setting to use the pipeline again.
