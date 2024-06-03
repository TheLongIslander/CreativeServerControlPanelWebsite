Minecraft Control Panel with SFTP File Management

Introduction

This project is a web-based control panel for managing a Minecraft server. It includes features for starting, stopping, and restarting the server, as well as backing it up. Additionally, it has a built-in SFTP file browser for uploading, downloading, and managing files on the server.

Features

- Server Control: Start, stop, and restart the Minecraft server.
- Backup Management: Perform backups of the Minecraft server with progress feedback.
- Authentication: Secure login and token-based authentication.
- SFTP File Browser: Upload, download, and manage files on the server.
- WebSocket Integration: Real-time feedback for server actions and backup progress.
- Activity Logging: Log server actions and SFTP activity to SQLite databases.

Technologies Used

- Node.js & Express: Backend server.
- WebSocket: Real-time communication.
- SQLite: Database for token blacklisting and logging.
- bcrypt: Secure password hashing.
- jsonwebtoken: Token-based authentication.
- SSH2: SFTP operations.
- JSZip: ZIP file handling.
- unzipper: Unzipping files.
- Frontend: HTML, CSS, JavaScript.

Setup and Installation

Prerequisites

- Node.js and npm installed.
- A Minecraft server setup.
- SFTP server details.

Installation Steps

1. Clone the repository:
    git clone https://github.com/TheLongIslander/CreativeServerControlPanelWebsite.git
    cd CreativeServerControlPanelWebsite

2. Install dependencies:
    npm install

3. Environment Variables:
    Create a .env file in the root directory and add the following environment variables:
    ADMIN_PASSWORD_HASH=your_hashed_password
    JWT_SECRET=your_jwt_secret
    SFTP_HOST=your_sftp_host
    SFTP_PORT=your_sftp_port
    SFTP_USERNAME=your_sftp_username
    SFTP_PASSWORD=your_sftp_password
    BACKUP_PATH=/path/to/backup
    MINECRAFT_SERVER_PATH=/path/to/minecraft/server
    START_COMMAND_PATH=/path/to/start/command
    TMP_UPLOAD_SERVER_PATH=/path/to/temp/upload

4. Database Setup:
    - SQLite databases for token blacklist and logging will be created automatically when the server starts.

Running the Server

Start the server with the following command:
node app.js
The server will be available at http://localhost:8087.

Usage

Authentication

1. Login:
    - Navigate to the login page (/).
    - Enter the admin username and password to obtain a JWT token.

2. Control Panel:
    - Once logged in, the control panel (/index.html) will be accessible.
    - The JWT token is stored in localStorage and used for authentication in subsequent requests.

Server Control

- Start Server: Click the "Start Server" button to start the Minecraft server.
- Stop Server: Click the "Stop Server" button to stop the Minecraft server.
- Restart Server: Click the "Restart Server" button to restart the Minecraft server.

Backup

- Perform Backup: Click the "Backup Server" button to start a backup. Progress is shown in real-time.

SFTP File Browser

- List Files: The file browser shows files in the current directory.
- Change Directory: Enter a path or click on directories to navigate.
- Upload Files: Select files or directories to upload.
- Download Files: Click the "Download" button next to a file to download it.

Logging Out

- Click the "Logout" button to end the session and invalidate the JWT token.

Additional Notes

- The utils.js file contains utility functions for logging and time handling.
- WebSocket connections provide real-time updates for server actions and backups.
- The SFTP file browser supports recursive directory uploads and zip file extraction.

