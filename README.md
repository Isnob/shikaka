# Shikaka

![Interface](media/screenshots/interface.png)

A brutally minimal, single-user implementation of the Shikaku puzzle game. Built with an emphasis on zero-bloat architecture, skipping heavy frameworks and build steps in favor of native platform capabilities.

## Architecture

Shikaka is designed around a lean tech stack, utilizing vanilla APIs wherever possible.

```mermaid
graph LR
    Client[Vanilla JS Client] -- JSON API --> Server[Python Native HTTP]
    Server -- psycopg --> DB[(PostgreSQL)]
    
    subgraph Frontend [Browser]
    Client --> Logic[State Management]
    Logic --> DOM[DOM Render Loop]
    end
    
    subgraph Backend [Python]
    Server --> Router[Native Router]
    Router --> Auth[HMAC Session Auth]
    Router --> Storage[JSON Persistence]
    end
```

### The Frontend (`public/`)
- **Zero-Dependency Vanilla JS:** No React, Vue, or build pipeline (Webpack/Vite). The code in `public/app.js` is exactly what the browser executes.
- **State Synchronization:** The game logic runs locally in the browser, pushing a serialized JSON state to the backend to persist progress.
- **Custom Render Loop:** UI updates are handled through direct, efficient DOM manipulation.

### The Backend (`server.py`)
- **Native `http.server`:** No Django/FastAPI yet. Routing and static file serving are implemented directly to keep the migration from Node small and predictable.
- **Lean Dependencies:** The only Python package is `psycopg[binary]` for PostgreSQL.
- **Security:** Session management uses cookie-based tokens signed with HMAC SHA-256 to prevent tampering.
- **Data Persistence:** Relies on PostgreSQL's `ON CONFLICT` feature for atomic upserts, storing the entire game state as a single JSON payload.
- **Legacy Node Server:** `server.js` is kept temporarily as a reference/fallback and can be run with `npm run start:node`.

## Local Setup

### Requirements
- Node.js >= 18
- Python >= 3.11
- PostgreSQL

### Running the App

1. Install Python dependencies:
   ```bash
   python3 -m pip install -r requirements.txt
   ```

2. Install Node dependencies for frontend syntax checks / legacy fallback:
   ```bash
   npm install
   ```

3. Create the local database:
   ```bash
   createdb shikaka
   ```

4. Configure environment variables:
   ```bash
   cp .env.example .env
   ```

5. Start the server:
   ```bash
   npm start
   ```

Open `http://localhost:3000`. You can play as a guest or sign in with Google when OAuth is configured.

### Google Login

Google OAuth is enabled when these variables are present:

```bash
PUBLIC_BASE_URL='http://localhost:3000'
GOOGLE_CLIENT_ID='...apps.googleusercontent.com'
GOOGLE_CLIENT_SECRET='...'
```

Configure the OAuth client in Google Cloud Console with this redirect URI:

```text
http://localhost:3000/auth/google/callback
```

For production, set `PUBLIC_BASE_URL` to the public origin and use the matching callback:

```text
https://your-domain.example/auth/google/callback
```

Each Google account gets its own saved progress. Guest mode stores progress locally in the browser.

### Cloudflare Turnstile

Turnstile protects the Google sign-in entrypoint when both variables are present:

```bash
TURNSTILE_SITE_KEY='0x...'
TURNSTILE_SECRET_KEY='...'
```

The site key is public and is sent to the browser. The secret key must stay only in `.env` on the server.

## Deployment

Shikaka runs perfectly on a standard VPS without needing complex orchestrators or containers. Set the environment variables and run it directly:

```bash
PORT=3000 \
SESSION_SECRET='long-random-string' \
DATABASE_URL='postgres://user:password@localhost:5432/shikaka' \
PUBLIC_BASE_URL='https://your-domain.example' \
GOOGLE_CLIENT_ID='...apps.googleusercontent.com' \
GOOGLE_CLIENT_SECRET='...' \
TURNSTILE_SITE_KEY='0x...' \
TURNSTILE_SECRET_KEY='...' \
npm start
```

`npm start` runs `python3 server.py`. The existing systemd unit can keep using `npm start` while the backend implementation is Python.
