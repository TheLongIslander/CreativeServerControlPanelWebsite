# Minecraft Server Control Panel + SFTP Browser

A self-hosted Node/Express web app for managing a Minecraft server and browsing backups over SFTP. Includes server start/stop/restart, hourly backup orchestration with progress, file uploads/downloads, media previews, and activity logging.

## What this project does

- Control Minecraft server lifecycle (start/stop/restart) via `screen`.
- Run hourly backups with rsync + real-time progress via WebSocket.
- Browse SFTP directories, upload files (including folders), and download files/folders as ZIPs.
- Generate previews for images, videos, HEIC, and PDFs (with caching).
- Log server actions and SFTP activity to SQLite.
- Graceful shutdown: type `stop` in the server terminal to broadcast maintenance and exit.

## Tech stack

- Backend: Node.js, Express, ws, ssh2, sqlite3
- Auth: bcrypt + JWT (token blacklist)
- Workers: `downloadWorker.js` (zips downloads), `heicWorker.js` (HEIC conversion)
- Frontend: static HTML/CSS/JS in `public/`

## Requirements

### Runtime
- Node.js (current LTS recommended)
- An SFTP server reachable with the credentials in `.env`
- A Minecraft server managed via `screen`

### System binaries (used by the server)
- `screen` (start/stop Minecraft server)
- `rsync` (backup)
- `zip` and `unzip` (downloads/uploads)
- `ffmpeg` (video thumbnails)
- `find` (download ZIP progress)
- `GraphicsMagick` or `ImageMagick` + `Ghostscript` (PDF previews via `pdf-image`)

## Configuration

Create a `.env` file in the project root:

```
ADMIN_PASSWORD_HASH=...             # bcrypt hash for admin user
JWT_SECRET=...                      # secret for JWT signing
SFTP_HOST=...
SFTP_PORT=...
SFTP_USERNAME=...
SFTP_PASSWORD=...
BACKUP_PATH=/path/to/backup/output
MINECRAFT_SERVER_PATH=/path/to/server
START_COMMAND_PATH=/path/to/start-script.sh
TMP_UPLOAD_SERVER_PATH=/path/to/tmp/uploads
VIDEO_CACHE_DIR=/optional/cache/dir # defaults to system tmp
```

Notes:
- The server listens on `http://localhost:8087`.
- The admin user is hard-coded as `admin` (see `app.js`).

## Running

```bash
npm install
node app.js
```

Open:
- Login: `http://localhost:8087/`
- Control panel: `http://localhost:8087/index.html`
- SFTP browser: `http://localhost:8087/sftp.html`

## Usage overview

### Login
- Use username `admin` and the password that matches `ADMIN_PASSWORD_HASH`.
- JWT is stored in `localStorage` for API calls; an `auth_token` cookie is also set for maintenance redirects.

### Control panel
- Start, stop, restart the server.
- Run backups (limited to once per hour).
- WebSocket pushes backup progress.

### SFTP browser
- Navigate directories, create directories.
- Upload files and folders (ZIP files are auto-unzipped into a new directory).
- Download files or entire folders as ZIP.
- Preview images, videos, HEIC, PDFs (cached thumbnails).

### Maintenance / graceful shutdown
- Type `stop` into the server terminal to broadcast maintenance and exit the Node process.
- Connected clients are redirected to `maintenance.html` before shutdown.
- If a user visits `/maintenance.html` when not in maintenance mode:
  - If not logged in: redirected to `/`.
  - If logged in: redirected to `/index.html`.

## Data & logs

- `token_blacklist.db` — blacklisted JWTs
- `server_logs.db` — server start/stop/backup actions
- `sftp_activity_log.db` — SFTP uploads/downloads
- `tmp/` and OS temp dirs — download/upload and preview caches

## Project layout

- `app.js` — main server
- `utils.js` — time helpers + logging
- `public/` — UI and assets
- `downloadWorker.js` — background ZIP creation for downloads
- `heicWorker.js` — HEIC conversion worker

## Troubleshooting

- If a remote directory is deleted while viewing it, the UI will automatically move up to the closest valid path.
- If previews fail, verify `ffmpeg` and `GraphicsMagick/ImageMagick + Ghostscript` are installed.
- If backups fail, confirm `rsync` and the `BACKUP_PATH` permissions.
