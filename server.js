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
    if (req.url === "/api/login" && req.method === "POST") {
      await handleLogin(req, res);
      return;
    }

    if (req.url === "/api/logout" && req.method === "POST") {
      handleLogout(req, res);
      return;
    }

    if (req.url === "/api/me" && req.method === "GET") {
      sendJson(res, 200, { authenticated: isAuthenticated(req) });
      return;
    }

    if (!isAuthenticated(req)) {
      if (req.url?.startsWith("/api/")) {
        sendJson(res, 401, { error: "unauthorized" });
        return;
      }
    }

    if (req.url === "/api/state" && req.method === "GET") {
      await handleGetState(res);
      return;
    }

    if (req.url === "/api/state" && req.method === "PUT") {
      await handlePutState(req, res);
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
}

async function handleLogin(req, res) {
  const body = await readJson(req);
  const password = String(body.password || "");

  if (!sameString(password, PASSWORD)) {
    sendJson(res, 403, { error: "bad_password" });
    return;
  }

  const sessionId = randomBytes(32).toString("hex");
  sessions.set(sessionId, Date.now());
  res.setHeader("Set-Cookie", cookieHeader("sid", signSession(sessionId)));
  sendJson(res, 200, { ok: true });
}

function handleLogout(req, res) {
  const sessionId = readSignedSession(req);
  if (sessionId) sessions.delete(sessionId);
  res.setHeader("Set-Cookie", "sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
  sendJson(res, 200, { ok: true });
}

async function handleGetState(res) {
  const result = await pool.query("select payload from shikaka_state where state_key = $1", [STATE_KEY]);
  sendJson(res, 200, { state: result.rows[0]?.payload || null });
}

async function handlePutState(req, res) {
  const body = await readJson(req, 512_000);
  await pool.query(
    `insert into shikaka_state (state_key, payload, updated_at)
     values ($1, $2, now())
     on conflict (state_key) do update set payload = excluded.payload, updated_at = now()`,
    [STATE_KEY, body.state || null]
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
  const sessionId = readSignedSession(req);
  return Boolean(sessionId && sessions.has(sessionId));
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

function cookieHeader(name, value) {
  const maxAge = 60 * 60 * 24 * 30;
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
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
