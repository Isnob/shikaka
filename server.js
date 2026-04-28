import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Pool } = pg;

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const PASSWORD = process.env.SHIKAKU_PASSWORD || "change-me";
const DATABASE_URL = process.env.DATABASE_URL || "postgres://localhost:5432/shikaka";
const SESSION_SECRET = process.env.SESSION_SECRET || randomBytes(32).toString("hex");
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "";
const PUBLIC_DIR = fileURLToPath(new URL("./public", import.meta.url));
const STATE_KEY = "solo";

const sessions = new Map();
const pool = new Pool({ connectionString: DATABASE_URL });

const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".ico", "image/x-icon"]
]);

await initDatabase();

createServer(async (req, res) => {
  try {
    if (req.url === "/auth/google/start" && req.method === "GET") {
      handleGoogleStart(req, res);
      return;
    }

    if (req.url?.startsWith("/auth/google/callback") && req.method === "GET") {
      await handleGoogleCallback(req, res);
      return;
    }

    if (req.url === "/api/login" && req.method === "POST") {
      await handleLogin(req, res);
      return;
    }

    if (req.url === "/api/logout" && req.method === "POST") {
      handleLogout(req, res);
      return;
    }

    if (req.url === "/api/me" && req.method === "GET") {
      const auth = getAuth(req);
      sendJson(res, 200, {
        authenticated: Boolean(auth),
        googleConfigured: isGoogleConfigured(),
        user: auth?.user || null
      });
      return;
    }

    if (req.url === "/api/leaderboard" && req.method === "GET") {
      await handleGetLeaderboard(res);
      return;
    }

    const auth = getAuth(req);
    if (!auth) {
      if (req.url?.startsWith("/api/")) {
        sendJson(res, 401, { error: "unauthorized" });
        return;
      }
    }

    if (req.url === "/api/state" && req.method === "GET") {
      await handleGetState(res, auth);
      return;
    }

    if (req.url === "/api/state" && req.method === "PUT") {
      await handlePutState(req, res, auth);
      return;
    }

    if (req.url === "/api/score" && req.method === "POST") {
      await handlePostScore(req, res, auth);
      return;
    }

    if (req.method === "GET" || req.method === "HEAD") {
      await serveStatic(req, res);
      return;
    }

    sendJson(res, 405, { error: "method_not_allowed" });
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { error: "internal_error" });
  }
}).listen(PORT, HOST, () => {
  console.log(`Shikaka listening on http://${HOST}:${PORT}`);
});

async function initDatabase() {
  await pool.query(`
    create table if not exists shikaka_state (
      state_key text primary key,
      payload jsonb not null,
      updated_at timestamptz not null default now()
    )
  `);
  await pool.query(`
    create table if not exists shikaka_users (
      google_sub text primary key,
      email text,
      name text,
      picture text,
      updated_at timestamptz not null default now()
    )
  `);
  await pool.query(`
    create table if not exists shikaka_scores (
      id bigserial primary key,
      user_key text not null,
      display_name text not null,
      size integer not null,
      seed text not null,
      mean_area integer not null,
      area_spread integer not null,
      elapsed_ms integer not null,
      created_at timestamptz not null default now(),
      unique (user_key, size, seed)
    )
  `);
}

async function handleLogin(req, res) {
  const body = await readJson(req);
  const password = String(body.password || "");

  if (!sameString(password, PASSWORD)) {
    sendJson(res, 403, { error: "bad_password" });
    return;
  }

  const sessionId = randomBytes(32).toString("hex");
  sessions.set(sessionId, {
    stateKey: STATE_KEY,
    user: { provider: "password", name: "Password user" }
  });
  res.setHeader("Set-Cookie", cookieHeader("sid", signSession(sessionId)));
  sendJson(res, 200, { ok: true });
}

async function handlePostScore(req, res, auth) {
  const body = await readJson(req, 32_768);
  const size = Number(body.size);
  const meanArea = Number(body.meanArea);
  const areaSpread = Number(body.areaSpread);
  const elapsedMs = Number(body.elapsedMs);
  const seed = String(body.seed || "");

  if (
    !Number.isInteger(size) ||
    !Number.isInteger(meanArea) ||
    !Number.isInteger(areaSpread) ||
    !Number.isInteger(elapsedMs) ||
    size <= 0 ||
    elapsedMs <= 0 ||
    !seed
  ) {
    sendJson(res, 400, { error: "bad_score" });
    return;
  }

  const displayName = auth.user?.name || auth.user?.email || "Player";
  await pool.query(
    `insert into shikaka_scores (user_key, display_name, size, seed, mean_area, area_spread, elapsed_ms, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, now())
     on conflict (user_key, size, seed) do update
     set elapsed_ms = least(shikaka_scores.elapsed_ms, excluded.elapsed_ms),
         display_name = excluded.display_name,
         mean_area = excluded.mean_area,
         area_spread = excluded.area_spread`,
    [auth.stateKey, displayName, size, seed, meanArea, areaSpread, elapsedMs]
  );
  sendJson(res, 200, { ok: true });
}

async function handleGetLeaderboard(res) {
  const result = await pool.query(`
    select display_name, size, seed, mean_area, area_spread, elapsed_ms, created_at
    from shikaka_scores
    order by elapsed_ms asc, created_at asc
    limit 20
  `);
  sendJson(res, 200, { scores: result.rows });
}

function handleGoogleStart(req, res) {
  if (!isGoogleConfigured()) {
    sendText(res, 501, "Google login is not configured.");
    return;
  }

  const state = randomBytes(24).toString("hex");
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", GOOGLE_CLIENT_ID);
  url.searchParams.set("redirect_uri", googleRedirectUri(req));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  url.searchParams.set("prompt", "select_account");

  res.statusCode = 302;
  res.setHeader("Set-Cookie", cookieHeader("oauth_state", signSession(state), 600));
  res.setHeader("Location", url.toString());
  res.end();
}

async function handleGoogleCallback(req, res) {
  if (!isGoogleConfigured()) {
    sendText(res, 501, "Google login is not configured.");
    return;
  }

  const url = new URL(req.url || "/", baseUrl(req));
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const signedState = parseCookies(req.headers.cookie || "").oauth_state;

  if (!code || !state || !signedState || signedState !== signSession(state)) {
    sendText(res, 403, "Invalid OAuth state.");
    return;
  }

  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: googleRedirectUri(req),
      grant_type: "authorization_code"
    })
  });

  if (!tokenResponse.ok) {
    console.error(await tokenResponse.text());
    sendText(res, 502, "Google token exchange failed.");
    return;
  }

  const token = await tokenResponse.json();
  const profileResponse = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { Authorization: `Bearer ${token.access_token}` }
  });

  if (!profileResponse.ok) {
    console.error(await profileResponse.text());
    sendText(res, 502, "Google profile fetch failed.");
    return;
  }

  const profile = await profileResponse.json();
  const googleSub = String(profile.sub || "");
  if (!googleSub) {
    sendText(res, 502, "Google profile did not include subject.");
    return;
  }

  await pool.query(
    `insert into shikaka_users (google_sub, email, name, picture, updated_at)
     values ($1, $2, $3, $4, now())
     on conflict (google_sub) do update
     set email = excluded.email,
         name = excluded.name,
         picture = excluded.picture,
         updated_at = now()`,
    [googleSub, profile.email || null, profile.name || null, profile.picture || null]
  );

  const sessionId = randomBytes(32).toString("hex");
  sessions.set(sessionId, {
    stateKey: `google:${googleSub}`,
    user: {
      provider: "google",
      email: profile.email || null,
      name: profile.name || profile.email || "Google user",
      picture: profile.picture || null
    }
  });

  res.statusCode = 302;
  res.setHeader("Set-Cookie", [
    cookieHeader("sid", signSession(sessionId)),
    "oauth_state=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"
  ]);
  res.setHeader("Location", "/");
  res.end();
}

function handleLogout(req, res) {
  const sessionId = readSignedSession(req);
  if (sessionId) sessions.delete(sessionId);
  res.setHeader("Set-Cookie", "sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
  sendJson(res, 200, { ok: true });
}

async function handleGetState(res, auth) {
  const result = await pool.query("select payload from shikaka_state where state_key = $1", [auth.stateKey]);
  sendJson(res, 200, { state: result.rows[0]?.payload || null });
}

async function handlePutState(req, res, auth) {
  const body = await readJson(req, 512_000);
  await pool.query(
    `insert into shikaka_state (state_key, payload, updated_at)
     values ($1, $2, now())
     on conflict (state_key) do update set payload = excluded.payload, updated_at = now()`,
    [auth.stateKey, body.state || null]
  );
  sendJson(res, 200, { ok: true });
}

async function serveStatic(req, res) {
  const url = new URL(req.url || "/", "http://localhost");
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";

  const filePath = normalize(join(PUBLIC_DIR, pathname));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendText(res, 403, "Forbidden");
    return;
  }

  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error("not a file");
    res.statusCode = 200;
    res.setHeader("Content-Type", mimeTypes.get(extname(filePath)) || "application/octet-stream");
    res.setHeader("Cache-Control", "no-cache");
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    createReadStream(filePath).pipe(res);
  } catch {
    const fallback = join(PUBLIC_DIR, "index.html");
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    createReadStream(fallback).pipe(res);
  }
}

function isAuthenticated(req) {
  return Boolean(getAuth(req));
}

function getAuth(req) {
  const sessionId = readSignedSession(req);
  return sessionId ? sessions.get(sessionId) || null : null;
}

function readSignedSession(req) {
  const raw = parseCookies(req.headers.cookie || "").sid;
  if (!raw) return null;
  const [sessionId, signature] = raw.split(".");
  if (!sessionId || !signature) return null;
  const expected = hmac(sessionId);
  if (!sameString(signature, expected)) return null;
  return sessionId;
}

function signSession(sessionId) {
  return `${sessionId}.${hmac(sessionId)}`;
}

function hmac(value) {
  return createHash("sha256").update(`${SESSION_SECRET}:${value}`).digest("hex");
}

function sameString(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

function parseCookies(header) {
  return Object.fromEntries(
    header
      .split(";")
      .map((part) => part.trim().split("="))
      .filter(([key, value]) => key && value)
      .map(([key, value]) => [key, decodeURIComponent(value)])
  );
}

function cookieHeader(name, value, maxAge = 60 * 60 * 24 * 30) {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}

function isGoogleConfigured() {
  return Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);
}

function googleRedirectUri(req) {
  return `${baseUrl(req)}/auth/google/callback`;
}

function baseUrl(req) {
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL.replace(/\/$/, "");
  const proto = req.headers["x-forwarded-proto"] || "http";
  return `${proto}://${req.headers.host}`;
}

async function readJson(req, maxBytes = 16_384) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("body too large");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8") || "{}";
  return JSON.parse(text);
}

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function sendText(res, status, text) {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end(text);
}
