# Shikaka

![Interface](media/screenshots/interface.png)

A brutally minimal, single-user implementation of the Shikaku puzzle game. Built with an emphasis on zero-bloat architecture, skipping heavy frameworks and build steps in favor of native platform capabilities.

## Architecture

Shikaka is designed around a lean tech stack, utilizing vanilla APIs wherever possible.

```mermaid
graph LR
    Client[Vanilla JS Client] -- JSON API --> Server[Node.js Native HTTP]
    Server -- pg module --> DB[(PostgreSQL)]
    
    subgraph Frontend [Browser]
    Client --> Logic[State Management]
    Logic --> DOM[DOM Render Loop]
    end
    
    subgraph Backend [Node.js]
    Server --> Router[Native Router]
    Router --> Auth[HMAC Session Auth]
    Router --> Storage[JSON Persistence]
    end
```

### The Frontend (`public/`)
- **Zero-Dependency Vanilla JS:** No React, Vue, or build pipeline (Webpack/Vite). The code in `public/app.js` is exactly what the browser executes.
- **State Synchronization:** The game logic runs locally in the browser, pushing a serialized JSON state to the backend to persist progress.
- **Custom Render Loop:** UI updates are handled through direct, efficient DOM manipulation.

### The Backend (`server.js`)
- **Native `node:http`:** No Express or Fastify. Routing and static file serving are implemented natively to minimize the footprint.
- **Lean Dependencies:** The only external package is `pg` for database communication.
- **Security:** Session management uses cookie-based tokens signed with HMAC SHA-256 (via `node:crypto`) to prevent tampering.
- **Data Persistence:** Relies on PostgreSQL's `ON CONFLICT` feature for atomic upserts, storing the entire game state as a single JSON payload.

## Local Setup

### Requirements
- Node.js >= 18
- PostgreSQL

### Running the App

1. Install the database driver:
   ```bash
   npm install
   ```

2. Create the local database:
   ```bash
   createdb shikaka
   ```

3. Configure environment variables:
   ```bash
   cp .env.example .env
   ```

4. Start the server:
   ```bash
   npm start
   ```

Open `http://localhost:3000`. If `SHIKAKU_PASSWORD` is not configured, the default development password is `change-me`.

## Deployment

Shikaka runs perfectly on a standard VPS without needing complex orchestrators or containers. Set the environment variables and run it directly:

```bash
PORT=3000 \
SHIKAKU_PASSWORD='your-strong-password' \
SESSION_SECRET='long-random-string' \
DATABASE_URL='postgres://user:password@localhost:5432/shikaka' \
npm start
```
