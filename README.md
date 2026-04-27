# Shikaka

Single-user Shikaku web game with password login and PostgreSQL-backed progress.

## Run locally

```bash
npm install
createdb shikaka
SHIKAKU_PASSWORD=your-password DATABASE_URL=postgres://localhost:5432/shikaka npm start
```

Open `http://localhost:3000`.

If `SHIKAKU_PASSWORD` is not set, the development password is `change-me`.

## Server deploy notes

The app does not require DNS. It can run on the server directly:

```bash
PORT=3000 \
SHIKAKU_PASSWORD='replace-this' \
SESSION_SECRET='replace-with-a-long-random-string' \
DATABASE_URL='postgres://user:password@localhost:5432/shikaka' \
npm start
```

Use SSH port forwarding if you do not want to expose HTTP:

```bash
ssh -L 3000:localhost:3000 -l bogdan 111.88.150.78
```

Then open `http://localhost:3000` on your machine.
