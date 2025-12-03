# Cloud Bot Manager

A professional Node.js panel for deploying and managing Telegram bots on Google Cloud Run.

## Overview
This is a VS Code-inspired web panel that provides:
- **File Explorer**: Create, edit, delete files and folders for your bot projects
- **Code Editor**: Monaco editor with syntax highlighting for JavaScript, JSON, Dockerfile, etc.
- **Real-time Console**: Live deployment logs with Socket.io streaming
- **Settings Panel**: Configure startup commands, dependencies, and Dockerfiles
- **Deployment Management**: Deploy, stop, restart bots with visual status tracking

## Project Structure
```
/
├── server.js          # Express + Socket.io server
├── public/
│   └── index.html     # Modern frontend with Monaco editor
├── bots/              # Bot projects directory
└── uploads/           # Temporary file uploads
```

## Features
1. **Create Bots**: Click "New Bot" to create a new Telegram bot project with boilerplate code
2. **Upload Bots**: Upload existing .js files to create bot projects
3. **File Management**: Full file/folder CRUD with context menu (right-click)
4. **Code Editing**: Monaco editor with JS/JSON/Dockerfile syntax highlighting, Ctrl+S to save
5. **Deployment**: One-click deploy to Google Cloud Run with real-time progress
6. **Console Logs**: Live streaming of deployment status and cloud logs
7. **Bot Control**: Start, stop, restart deployed bots
8. **Settings**: Customize startup command, npm dependencies, and Dockerfile

## Configuration
Set these environment variables:
- `GCLOUD_PROJECT_ID`: Your Google Cloud project ID (default: elitehost-480108)
- `GCLOUD_REGION`: Cloud Run region (default: us-central1)

## Recent Changes
- 2024-12-03: Major UI overhaul with VS Code-inspired design
- 2024-12-03: Added Monaco code editor with syntax highlighting
- 2024-12-03: Implemented Socket.io for real-time deployment logs
- 2024-12-03: Added file explorer with create/edit/delete functionality
- 2024-12-03: Added settings panel for bot configuration
- 2024-12-03: Added deployment status tracking with progress bar

## Tech Stack
- Express.js (backend API)
- Socket.io (real-time communication)
- Monaco Editor (code editing)
- Tailwind CSS (styling)
- Google Cloud SDK (deployment)
