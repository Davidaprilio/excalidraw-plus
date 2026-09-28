# Excalidraw Self-Hosted

Self-hosted Excalidraw with server-side persistence, user authentication, and team collaboration.

## Repository layout

This repo (`excalidraw-plus`) holds the backend, the deployment files and the
frontend as a git submodule:

| Path | What |
|------|------|
| `api/` | Node + Express + PostgreSQL backend (migrations in `api/migrations`) |
| `excalidraw/` | **Submodule**: fork of Excalidraw with the self-hosted app ([Davidaprilio/excalidraw](https://github.com/Davidaprilio/excalidraw)) |
| `nginx/`, `Dockerfile.frontend`, `docker-compose.yml` | Deployment |
| `.env.example` | Copy to `.env` and fill in |

Clone with the submodule:

```bash
git clone --recurse-submodules git@github.com:Davidaprilio/excalidraw-plus.git
# already cloned without it:
git submodule update --init
```

Frontend changes are committed (and pushed) inside `excalidraw/` first, then the
new submodule pointer is committed here: `git add excalidraw && git commit`.

## Local development

```bash
cp .env.example .env          # then set DATABASE_URL, JWT_SECRET, ...
podman run -d --name excalidraw-room -p 3002:80 docker.io/excalidraw/excalidraw-room:latest
(cd api && yarn install && yarn dev)          # API on :4001, runs migrations
(cd excalidraw && yarn install && yarn start) # app on http://localhost:4000
```

Vite proxies `/api` to the API and `/socket.io` to the collaboration room server.

## Features

- **Server-side persistence** - Drawings saved to your PostgreSQL database
- **User authentication** - JWT-based auth with register/login
- **Auto-save** - Changes automatically saved to server (debounced 2s)
- **Scenes management** - Create, list, load, delete drawings
- **Version history** - Track changes, restore previous versions
- **Shareable links** - Generate public links for drawings
- **Team collaboration** - Create teams, share drawings
- **Image storage** - Files stored on local filesystem
- **Real-time collaboration** - WebSocket server for live collaboration
- **Docker deployment** - Single `docker-compose up` command

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                      Docker Compose                      │
│                                                          │
│  ┌────────────┐  ┌─────────────────┐  ┌──────────────┐ │
│  │   nginx    │  │ excalidraw-api  │  │   collab     │ │
│  │  (SPA+proxy│  │ (Node+Express)  │  │  (Socket.IO) │ │
│  │  :80)      │  │  :3001          │  │  :3002       │ │
│  └─────┬──────┘  └───────┬─────────┘  └──────┬───────┘ │
│        │                 │                    │         │
│        └─────────────────┼────────────────────┘         │
│                          │                               │
│                   ┌──────┴───────┐                       │
│                   │  PostgreSQL  │                       │
│                   │  :5432       │                       │
│                   └──────────────┘                       │
└─────────────────────────────────────────────────────────┘
```

## Quick Start

1. Clone this repository:
```bash
git clone <your-repo-url>
cd excalidraw-selfhost
```

2. Edit `.env` file with your settings:
```bash
# Change these in production!
POSTGRES_PASSWORD=your-secure-password
JWT_SECRET=your-random-secret-key
```

3. Start all services:
```bash
docker-compose up -d
```

4. Access Excalidraw at http://localhost

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `POSTGRES_DB` | `excalidraw` | Database name |
| `POSTGRES_USER` | `excalidraw` | Database user |
| `POSTGRES_PASSWORD` | `change-me-in-production` | Database password |
| `DATABASE_URL` | (auto-generated) | PostgreSQL connection string |
| `JWT_SECRET` | `change-this-to-a-random-secret-in-production` | JWT signing secret |
| `UPLOAD_DIR` | `/uploads` | File upload directory |

### Ports

| Service | Port | Description |
|---------|------|-------------|
| nginx | 80 | Main web interface |
| api | 3001 | Backend API (internal) |
| collab | 3002 | WebSocket server (internal) |
| postgres | 5432 | Database (internal) |

## API Endpoints

### Auth
- `POST /api/auth/register` - Register new user
- `POST /api/auth/login` - Login
- `GET /api/auth/me` - Get current user

### Scenes
- `GET /api/scenes` - List user's scenes
- `POST /api/scenes` - Create new scene
- `GET /api/scenes/:id` - Get scene
- `PUT /api/scenes/:id` - Update scene (auto-save)
- `DELETE /api/scenes/:id` - Delete scene
- `GET /api/scenes/:id/versions` - Get version history
- `POST /api/scenes/:id/restore/:version` - Restore version
- `POST /api/scenes/:id/share` - Enable read-only link sharing (reuses the existing token)
- `DELETE /api/scenes/:id/share` - Stop sharing (the old link stops working)
- `GET /api/scenes/shared/:token` - Get shared scene (public, opened in the app at `/share/:token`)

### Files
- `POST /api/files` - Upload file
- `GET /api/files/:id` - Get file
- `DELETE /api/files/:id` - Delete file

### Libraries
- `GET /api/libraries` - List libraries
- `POST /api/libraries` - Create library
- `PUT /api/libraries/:id` - Update library
- `DELETE /api/libraries/:id` - Delete library

### Teams
- `GET /api/teams` - List teams
- `POST /api/teams` - Create team
- `GET /api/teams/:id` - Get team with members
- `POST /api/teams/:id/members` - Add member
- `DELETE /api/teams/:id/members/:userId` - Remove member

### Collaboration
- `GET /api/collab/scenes/:roomId` - Get collab scene
- `PUT /api/collab/scenes/:roomId` - Save collab scene
- `POST /api/collab/files` - Upload collab file
- `GET /api/collab/files/:id` - Get collab file

## Development

### Backend API
```bash
cd api
yarn install
yarn dev  # Starts on port 3001 with hot reload
```

### Frontend
The frontend is the standard Excalidraw app with self-hosted modifications. The key files added:
- `excalidraw-app/data/api.ts` - HTTP client for backend API
- `excalidraw-app/components/SharedSceneViewer.tsx` - Public read-only viewer for share links
- `excalidraw-app/data/ServerData.ts` - Server persistence layer
- `excalidraw-app/auth/` - Authentication UI components
- `excalidraw-app/SelfHostedApp.tsx` - Main wrapper with auth gate
- `excalidraw-app/components/ScenesList.tsx` - Scenes management UI

### Database Schema
The API applies pending migrations from `api/migrations/*.sql` on startup, in filename order, and records them in the `schema_migrations` table. To change the schema, add a new numbered file (e.g. `003_add_sessions.sql`); never edit a migration that has already been applied.

## Data Storage

### What's stored on server (PostgreSQL):
- User accounts (email, hashed password)
- Scenes (drawings) - elements, app state, version history
- Files/images metadata
- Libraries (shape libraries)
- Teams and memberships
- Collaboration room persistence

### What's stored on client (browser):
- Authentication token (JWT in localStorage)
- Current scene ID
- Encryption keys (for E2E encrypted scenes)
- Offline fallback data (localStorage + IndexedDB)

## Security Notes

- Change `JWT_SECRET` and `POSTGRES_PASSWORD` in production
- Use HTTPS in production (add nginx SSL config)
- File uploads are limited to 50MB
- JWT tokens expire after 30 days
- Passwords are hashed with bcrypt (10 rounds)

## Backup

### Database
```bash
docker-compose exec postgres pg_dump -U excalidraw excalidraw > backup.sql
```

### Files
```bash
docker-compose exec api tar czf - /uploads > uploads-backup.tar.gz
```

### Restore
```bash
docker-compose exec -T postgres psql -U excalidraw excalidraw < backup.sql
docker-compose exec api tar xzf - -C / < uploads-backup.tar.gz
```
