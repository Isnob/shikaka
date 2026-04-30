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
const SESSION_SECRET = process.env.SESSION_SECRET || "dev-session-secret-change-me";
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "";
const PUBLIC_DIR = fileURLToPath(new URL("./public", import.meta.url));
const STATE_KEY = "solo";
const TUNING_MAX = 30;
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

const PRESETS = [
  { size: 6, meanArea: 5, areaSpread: 6 },
  { size: 8, meanArea: 5, areaSpread: 15 },
  { size: 10, meanArea: 6, areaSpread: 10 },
  { size: 15, meanArea: 7, areaSpread: 14 },
  { size: 20, meanArea: 8, areaSpread: 17 },
  { size: 26, meanArea: 8, areaSpread: 19 }
];

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
      await handleLogout(req, res);
      return;
    }

    if (req.url === "/api/me" && req.method === "GET") {
      const auth = await getAuth(req);
      sendJson(res, 200, {
        authenticated: Boolean(auth),
        googleConfigured: isGoogleConfigured(),
        user: auth?.user || null
      });
      return;
    }

    if (req.url?.startsWith("/api/user-stats") && req.method === "GET") {
      await handleGetUserStats(req, res);
      return;
    }

    if (req.url?.startsWith("/api/leaderboard") && req.method === "GET") {
      await handleGetLeaderboard(req, res);
      return;
    }

    if (req.url === "/api/level" && req.method === "POST") {
      await handleCreateLevel(req, res);
      return;
    }

    if (req.url === "/api/solution" && req.method === "POST") {
      await handleGetSolution(req, res);
      return;
    }

    const auth = await getAuth(req);
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
  await pool.query(`
    create table if not exists shikaka_levels (
      id bigserial primary key,
      size integer not null,
      seed text not null,
      mean_area integer not null,
      area_spread integer not null,
      payload jsonb not null,
      created_at timestamptz not null default now(),
      unique (size, seed, mean_area, area_spread)
    )
  `);
  await pool.query(`
    create table if not exists shikaka_reveals (
      user_key text not null,
      size integer not null,
      seed text not null,
      mean_area integer not null,
      area_spread integer not null,
      revealed_at timestamptz not null default now(),
      primary key (user_key, size, seed, mean_area, area_spread)
    )
  `);
  await pool.query(`
    create table if not exists shikaka_events (
      id bigserial primary key,
      user_key text not null,
      event_type text not null, -- 'start', 'solve', 'reveal'
      size integer not null,
      seed text not null,
      mean_area integer not null,
      area_spread integer not null,
      elapsed_ms integer,
      created_at timestamptz not null default now()
    )
  `);
  await pool.query(`
    create table if not exists shikaka_sessions (
      session_hash text primary key,
      payload jsonb not null,
      expires_at timestamptz not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `);
  await pool.query("delete from shikaka_sessions where expires_at <= now()");
}

async function handleLogin(req, res) {
  const body = await readJson(req);
  const password = String(body.password || "");

  if (!sameString(password, PASSWORD)) {
    sendJson(res, 403, { error: "bad_password" });
    return;
  }

  const sessionId = randomBytes(32).toString("hex");
  await storeSession(sessionId, {
    stateKey: STATE_KEY,
    user: { provider: "password", name: "Password user" }
  });
  res.setHeader("Set-Cookie", cookieHeader("sid", signSession(sessionId)));
  sendJson(res, 200, { ok: true });
}

async function handlePostScore(req, res, auth) {
  const body = await readJson(req, 512_000);
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

  const level = await findLevel(size, seed, meanArea, areaSpread);
  if (!level) {
    sendJson(res, 400, { error: "unknown_level" });
    return;
  }

  if (body.usedSolution || (await hasReveal(auth.stateKey, size, seed, meanArea, areaSpread))) {
    sendJson(res, 400, { error: "solution_revealed" });
    return;
  }

  if (!isSolvedSubmission(size, level.clues, body.regions)) {
    sendJson(res, 400, { error: "invalid_solution" });
    return;
  }

  const isPreset = PRESETS.some(
    (p) => p.size === size && p.meanArea === meanArea && p.areaSpread === areaSpread
  );

  if (isPreset) {
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
  }

  await pool.query(
    `insert into shikaka_events (user_key, event_type, size, seed, mean_area, area_spread, elapsed_ms, created_at)
     values ($1, 'solve', $2, $3, $4, $5, $6, now())`,
    [auth.stateKey, size, seed, meanArea, areaSpread, elapsedMs]
  );
  sendJson(res, 200, { ok: true });
}

async function handleCreateLevel(req, res) {
  const auth = await getAuth(req);
  const body = await readJson(req, 16_384);
  const size = Number(body.size);
  const tuning = {
    meanArea: Number(body.meanArea),
    areaSpread: Number(body.areaSpread)
  };

  if (
    !PRESETS.some((preset) => preset.size === size) ||
    !Number.isInteger(tuning.meanArea) ||
    !Number.isInteger(tuning.areaSpread) ||
    tuning.meanArea < 0 ||
    tuning.meanArea > TUNING_MAX ||
    tuning.areaSpread < 0 ||
    tuning.areaSpread > TUNING_MAX
  ) {
    sendJson(res, 400, { error: "bad_level_request" });
    return;
  }

  const level = makeGame(size, tuning);
  await pool.query(
    `insert into shikaka_levels (size, seed, mean_area, area_spread, payload, created_at)
     values ($1, $2, $3, $4, $5, now())
     on conflict (size, seed, mean_area, area_spread) do nothing`,
    [size, String(level.seed), tuning.meanArea, tuning.areaSpread, level]
  );

  if (auth) {
    await pool.query(
      `insert into shikaka_events (user_key, event_type, size, seed, mean_area, area_spread, created_at)
       values ($1, 'start', $2, $3, $4, $5, now())`,
      [auth.stateKey, size, String(level.seed), tuning.meanArea, tuning.areaSpread]
    );
  }

  sendJson(res, 200, { level: publicLevel(level) });
}

async function handleGetSolution(req, res) {
  const auth = await getAuth(req);
  if (!auth) {
    sendJson(res, 401, { error: "unauthorized" });
    return;
  }

  const body = await readJson(req, 16_384);
  const size = Number(body.size);
  const meanArea = Number(body.meanArea);
  const areaSpread = Number(body.areaSpread);
  const seed = String(body.seed || "");
  const level = await findLevel(size, seed, meanArea, areaSpread);

  if (!level) {
    sendJson(res, 404, { error: "unknown_level" });
    return;
  }

  await pool.query(
    `insert into shikaka_reveals (user_key, size, seed, mean_area, area_spread, revealed_at)
     values ($1, $2, $3, $4, $5, now())
     on conflict (user_key, size, seed, mean_area, area_spread)
     do update set revealed_at = excluded.revealed_at`,
    [auth.stateKey, size, seed, meanArea, areaSpread]
  );

  await pool.query(
    `insert into shikaka_events (user_key, event_type, size, seed, mean_area, area_spread, created_at)
     values ($1, 'reveal', $2, $3, $4, $5, now())`,
    [auth.stateKey, size, seed, meanArea, areaSpread]
  );

  sendJson(res, 200, { solution: level.solution });
}

async function findLevel(size, seed, meanArea, areaSpread) {
  const exact = await pool.query(
    `select payload
     from shikaka_levels
     where size = $1 and seed = $2 and mean_area = $3 and area_spread = $4
     limit 1`,
    [size, seed, meanArea, areaSpread]
  );
  if (exact.rows[0]?.payload) return exact.rows[0].payload;

  const bySeed = await pool.query(
    `select payload
     from shikaka_levels
     where size = $1 and seed = $2
     order by created_at desc
     limit 1`,
    [size, seed]
  );
  return bySeed.rows[0]?.payload || null;
}

async function hasReveal(userKey, size, seed, meanArea, areaSpread) {
  const result = await pool.query(
    `select 1
     from shikaka_reveals
     where user_key = $1 and size = $2 and seed = $3 and mean_area = $4 and area_spread = $5
     limit 1`,
    [userKey, size, seed, meanArea, areaSpread]
  );
  return result.rowCount > 0;
}

function publicLevel(level) {
  return {
    size: level.size,
    tuning: level.tuning,
    seed: level.seed,
    clues: level.clues
  };
}

function isSolvedSubmission(size, clues, regions) {
  if (!Array.isArray(clues) || !Array.isArray(regions)) return false;
  if (clues.length === 0 || regions.length === 0) return false;

  const occupied = new Set();
  for (const region of regions) {
    const rect = normalizeRectPayload(region);
    if (!rect) return false;

    const area = rect.w * rect.h;
    const matchingClues = clues.filter((clue) => containsPoint(rect, Number(clue.x), Number(clue.y)));
    if (matchingClues.length !== 1 || Number(matchingClues[0].value) !== area) return false;

    for (let y = rect.y; y < rect.y + rect.h; y += 1) {
      for (let x = rect.x; x < rect.x + rect.w; x += 1) {
        if (x < 0 || y < 0 || x >= size || y >= size) return false;
        const cellKey = `${x}:${y}`;
        if (occupied.has(cellKey)) return false;
        occupied.add(cellKey);
      }
    }
  }

  return occupied.size === size * size;
}

function normalizeRectPayload(rect) {
  const x = Number(rect?.x);
  const y = Number(rect?.y);
  const w = Number(rect?.w);
  const h = Number(rect?.h);
  if (![x, y, w, h].every(Number.isInteger) || w <= 0 || h <= 0) return null;
  return { x, y, w, h };
}

function containsPoint(rect, x, y) {
  return x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h;
}

function makeGame(size, tuning) {
  const candidate = pickGeneratedLevel(size, tuning);
  const seed = candidate.seed;
  const rng = mulberry32(seed);
  const solution = candidate.solution;
  const clues = solution.map((rect) => ({
    x: rect.x + Math.floor(rng() * rect.w),
    y: rect.y + Math.floor(rng() * rect.h),
    value: rect.w * rect.h
  }));
  return { size, tuning, seed, clues, solution };
}

function pickGeneratedLevel(size, tuning) {
  const attempts = size >= 20 ? 80 : 56;
  let best = null;

  for (let index = 0; index < attempts; index += 1) {
    const seed = Math.floor(Math.random() * 2 ** 31);
    const rng = mulberry32(seed);
    const solution = growTiling(size, rng, tuning);
    const score = scoreSolution(solution, tuning);
    if (!best || score < best.score) best = { seed, solution, score };
  }

  return best;
}

function growTiling(size, rng, tuning) {
  const profile = generatorProfile(size, tuning);
  const filled = Array.from({ length: size }, () => Array(size).fill(false));
  const rects = [];

  while (true) {
    const origin = firstEmptyCell(filled, size);
    if (!origin) return repairTinyRects(rects);

    const candidates = rectCandidatesFrom(origin.x, origin.y, filled, size, profile);
    if (candidates.length === 0) {
      rects.push({ x: origin.x, y: origin.y, w: 1, h: 1 });
      filled[origin.y][origin.x] = true;
      continue;
    }

    const rect = weightedPick(candidates, rng);
    rects.push(rect);
    for (let y = rect.y; y < rect.y + rect.h; y += 1) {
      for (let x = rect.x; x < rect.x + rect.w; x += 1) filled[y][x] = true;
    }
  }
}

function repairTinyRects(rects) {
  let changed = true;
  while (changed) {
    changed = false;
    const tinyIndex = rects.findIndex((rect) => rect.w * rect.h < 3);
    if (tinyIndex === -1) break;

    const tiny = rects[tinyIndex];
    const neighborIndex = rects.findIndex((rect, index) => index !== tinyIndex && rectangularUnion(tiny, rect));
    if (neighborIndex === -1) break;

    const merged = rectangularUnion(tiny, rects[neighborIndex]);
    rects.splice(Math.max(tinyIndex, neighborIndex), 1);
    rects.splice(Math.min(tinyIndex, neighborIndex), 1);
    rects.push(merged);
    changed = true;
  }
  return rects;
}

function rectangularUnion(a, b) {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const right = Math.max(a.x + a.w, b.x + b.w);
  const bottom = Math.max(a.y + a.h, b.y + b.h);
  const area = (right - x) * (bottom - y);
  if (area !== a.w * a.h + b.w * b.h) return null;
  return { x, y, w: right - x, h: bottom - y };
}

function firstEmptyCell(filled, size) {
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (!filled[y][x]) return { x, y };
    }
  }
  return null;
}

function rectCandidatesFrom(x, y, filled, size, profile) {
  const candidates = [];
  let maxWidth = 0;
  while (x + maxWidth < size && !filled[y][x + maxWidth]) maxWidth += 1;

  for (let w = 1; w <= maxWidth; w += 1) {
    let h = 0;
    outer: while (y + h < size) {
      for (let dx = 0; dx < w; dx += 1) {
        if (filled[y + h][x + dx]) break outer;
      }
      h += 1;
    }

    for (let height = 1; height <= h; height += 1) {
      const area = w * height;
      if (area < profile.minArea && area !== remainingIslandArea(x, y, filled, size)) continue;
      if (area > profile.maxArea) continue;
      const aspect = Math.max(w / height, height / w);
      const weight = areaDistributionWeight(area, profile) * aspectWeight(aspect);
      if (weight > 0) candidates.push({ x, y, w, h: height, weight });
    }
  }

  return candidates;
}

function remainingIslandArea(x, y, filled, size) {
  let area = 0;
  for (let yy = y; yy < size; yy += 1) {
    for (let xx = x; xx < size; xx += 1) {
      if (!filled[yy][xx]) area += 1;
    }
  }
  return area;
}

function areaDistributionWeight(area, profile) {
  const sigma = Math.max(0.75, profile.targetIqr / 1.349);
  const distance = (area - profile.targetMedian) / sigma;
  return Math.exp(-0.5 * distance * distance) * areaShapeWeight(area);
}

function weightedPick(items, rng) {
  const total = items.reduce((sum, item) => sum + item.weight, 0);
  let roll = rng() * total;
  for (const item of items) {
    roll -= item.weight;
    if (roll <= 0) {
      const { weight, ...rect } = item;
      return rect;
    }
  }
  const { weight, ...rect } = items.at(-1);
  return rect;
}

function scoreSolution(solution, tuning) {
  const size = Math.sqrt(solution.reduce((sum, rect) => sum + rect.w * rect.h, 0));
  const profile = generatorProfile(size, tuning);
  const stats = areaStats(solution);
  const medianError = Math.abs(stats.median - profile.targetMedian) / profile.targetMedian;
  const iqrError = Math.abs(stats.iqr - profile.targetIqr) / Math.max(1, profile.targetIqr);
  const duplicatePenalty = histogramConcentration(stats.counts, solution.length);
  const duplicateWeight = profile.spreadRatio < 0.2 ? 80 * (profile.spreadRatio / 0.2) : 80;
  const histogramError = distributionError(stats.counts, stats.areas.length, profile);
  const tinyPenalty = (stats.counts.get(2) || 0) / solution.length;
  const invalidTinyPenalty = ((stats.counts.get(1) || 0) + (stats.counts.get(2) || 0)) / solution.length;
  const belowTargetShare = stats.areas.filter((area) => area < profile.targetMedian).length / stats.areas.length;
  const aboveTargetShare = stats.areas.filter((area) => area > profile.targetMedian).length / stats.areas.length;
  const skewPenalty = Math.abs(belowTargetShare - aboveTargetShare);
  const lowAreaLimit = Math.max(3, Math.floor(profile.targetMedian * 0.75));
  const lowAreaShare = stats.areas.filter((area) => area < lowAreaLimit).length / stats.areas.length;
  const lowAreaPenalty = profile.targetMedian >= 6 ? lowAreaShare : 0;
  const spreadWeight = 80 + (1 - profile.spreadRatio) * 220;

  return (
    medianError * 190 +
    iqrError * spreadWeight +
    histogramError * 260 +
    skewPenalty * 120 +
    lowAreaPenalty * 180 +
    duplicatePenalty * duplicateWeight +
    tinyPenalty * 24 +
    invalidTinyPenalty * 10000
  );
}

function splitRect(rect, rng, size, tuning) {
  const profile = generatorProfile(size, tuning);
  const area = rect.w * rect.h;
  const verticalCuts = possibleCuts(rect.w, rect.h, profile.minArea);
  const horizontalCuts = possibleCuts(rect.h, rect.w, profile.minArea);
  const canVertical = verticalCuts.length > 0;
  const canHorizontal = horizontalCuts.length > 0;
  const stopChance = stopProbability(area, profile, rect);

  if (area <= profile.maxArea && area >= profile.minArea && rng() < stopChance) return [rect];
  if (!canVertical && !canHorizontal) return [rect];

  const splitVertical = canVertical && (!canHorizontal || rng() < rect.w / (rect.w + rect.h));
  if (splitVertical) {
    const cut = pickCut(verticalCuts, rect.w, rect.h, profile, rng);
    return [
      ...splitRect({ x: rect.x, y: rect.y, w: cut, h: rect.h }, rng, size, tuning),
      ...splitRect({ x: rect.x + cut, y: rect.y, w: rect.w - cut, h: rect.h }, rng, size, tuning)
    ];
  }

  const cut = pickCut(horizontalCuts, rect.h, rect.w, profile, rng);
  return [
    ...splitRect({ x: rect.x, y: rect.y, w: rect.w, h: cut }, rng, size, tuning),
    ...splitRect({ x: rect.x, y: rect.y + cut, w: rect.w, h: rect.h - cut }, rng, size, tuning)
  ];
}

function generatorProfile(size, tuning) {
  const targetMedian = Math.max(3, tuning.meanArea);
  const spreadRatio = tuning.areaSpread / TUNING_MAX;
  const targetIqr = spreadRatio === 0 ? 0 : Math.max(1, targetMedian * spreadRatio * 1.25);
  const meanRatio = targetMedian / TUNING_MAX;

  return {
    maxArea: Math.max(4, Math.round(targetMedian + targetIqr * 2.8)),
    minArea: targetMedian < 5 ? 2 : 3,
    targetMedian,
    targetIqr,
    spreadRatio,
    stopBase: Math.max(0.08, Math.min(0.82, 0.18 + meanRatio * 0.48)),
    stopSlope: Math.max(0.12, 0.62 - meanRatio * 0.24),
    edgeBias: 0.85 + (1 - spreadRatio) * 1.35
  };
}

function stopProbability(area, profile, rect) {
  const ratio = Math.min(1, Math.max(0, area / profile.maxArea));
  const aspect = Math.max(rect.w / rect.h, rect.h / rect.w);
  const aspectPenalty = aspect > 4 ? 0.08 : aspect > 3 ? 0.35 : 1.0;
  const undersizedPenalty =
    area < profile.targetMedian
      ? Math.max(0.06, (area / profile.targetMedian) ** 3)
      : 1;
  return Math.max(0.02, Math.min(0.94, (profile.stopBase + profile.stopSlope * ratio) * aspectPenalty * undersizedPenalty));
}

function possibleCuts(length, otherSide, minArea) {
  const cuts = [];
  for (let cut = 1; cut < length; cut += 1) {
    if (cut * otherSide >= minArea && (length - cut) * otherSide >= minArea) {
      cuts.push(cut);
    }
  }
  return cuts;
}

function pickCut(cuts, length, otherSide, profile, rng) {
  const weighted = cuts.map((cut) => {
    const leftArea = cut * otherSide;
    const rightArea = (length - cut) * otherSide;
    const smallerArea = Math.min(leftArea, rightArea);
    const targetDistance = Math.abs(smallerArea - profile.targetMedian) / Math.max(1, profile.targetIqr);
    const tinyPenalty = tinyAreaPenalty(leftArea) * tinyAreaPenalty(rightArea);
    const balance = Math.max(0.2, smallerArea / Math.max(leftArea, rightArea));
    const leftAspect = Math.max(cut / otherSide, otherSide / cut);
    const rightAspect = Math.max((length - cut) / otherSide, otherSide / (length - cut));
    const shapeBonus = aspectWeight(leftAspect) * aspectWeight(rightAspect);

    return { cut, weight: tinyPenalty * balance * shapeBonus * Math.exp(-targetDistance * profile.edgeBias) };
  });
  const total = weighted.reduce((sum, item) => sum + item.weight, 0);
  let roll = rng() * total;
  for (const item of weighted) {
    roll -= item.weight;
    if (roll <= 0) return item.cut;
  }
  return weighted.at(-1).cut;
}

function tinyAreaPenalty(area) {
  if (area === 2) return 0.03;
  if (area === 3) return 0.18;
  if (area === 4) return 0.45;
  return 1;
}

function aspectWeight(aspect) {
  if (aspect <= 3) return 1;
  if (aspect <= 4) return 0.28;
  return 0.035;
}

function areaStats(solution) {
  const areas = solution.map((rect) => rect.w * rect.h);
  areas.sort((a, b) => a - b);
  const mean = areas.reduce((sum, area) => sum + area, 0) / areas.length;
  const variance = areas.reduce((sum, area) => sum + (area - mean) ** 2, 0) / areas.length;
  const counts = new Map();
  for (const area of areas) counts.set(area, (counts.get(area) || 0) + 1);
  const q1 = quantile(areas, 0.25);
  const median = quantile(areas, 0.5);
  const q3 = quantile(areas, 0.75);
  return { areas, mean, stdev: Math.sqrt(variance), q1, median, q3, iqr: q3 - q1, counts };
}

function distributionError(counts, total, profile) {
  const expected = expectedDistribution(profile);
  let error = 0;
  for (const [area, expectedShare] of expected) {
    const actualShare = (counts.get(area) || 0) / total;
    error += Math.abs(actualShare - expectedShare);
  }

  for (const [area, count] of counts) {
    if (!expected.has(area)) error += count / total;
  }

  return error;
}

function expectedDistribution(profile) {
  const sigma = Math.max(0.75, profile.targetIqr / 1.349);
  const weights = new Map();
  let total = 0;
  for (let area = profile.minArea; area <= profile.maxArea; area += 1) {
    const distance = (area - profile.targetMedian) / sigma;
    const weight = Math.exp(-0.5 * distance * distance) * areaShapeWeight(area);
    weights.set(area, weight);
    total += weight;
  }
  for (const [area, weight] of weights) weights.set(area, weight / total);
  return weights;
}

function areaShapeWeight(area) {
  let bestAspect = area;
  for (let width = 1; width * width <= area; width += 1) {
    if (area % width !== 0) continue;
    const height = area / width;
    bestAspect = Math.min(bestAspect, Math.max(width / height, height / width));
  }
  if (bestAspect <= 3) return 1;
  if (bestAspect <= 4) return 0.45;
  return 0.12;
}

function quantile(sorted, q) {
  if (sorted.length === 0) return 0;
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function histogramConcentration(counts, total) {
  let sum = 0;
  for (const count of counts.values()) {
    const share = count / total;
    sum += share * share;
  }
  return sum;
}

function mulberry32(seed) {
  return function next() {
    let value = (seed += 0x6d2b79f5);
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

async function handleGetLeaderboard(req, res) {
  const url = new URL(req.url || "/", "http://localhost");
  const sizes = PRESETS.map(p => p.size);

  const result = await pool.query(`
    select user_key, display_name, size, seed, mean_area, area_spread, elapsed_ms, created_at
    from (
      select best_per_user.*,
             row_number() over (partition by size order by elapsed_ms asc, created_at asc) as rank
      from (
        select distinct on (size, user_key)
               user_key, display_name, size, seed, mean_area, area_spread, elapsed_ms, created_at
        from shikaka_scores
        where (size, mean_area, area_spread) in (
          (6, 5, 6), (8, 5, 15), (10, 6, 10), (15, 7, 14), (20, 8, 17), (26, 8, 19)
        )
        order by size, user_key, elapsed_ms asc, created_at asc
      ) best_per_user
    ) ranked
    where rank <= 20
    order by size asc, elapsed_ms asc, created_at asc
  `);

  const groups = Object.fromEntries(sizes.map((size) => [size, []]));
  for (const row of result.rows) groups[row.size].push(row);
  sendJson(res, 200, { sizes, groups });
}

async function handleGetUserStats(req, res) {
  const url = new URL(req.url || "/", "http://localhost");
  const userKey = url.searchParams.get("userKey");
  if (!userKey) {
    sendJson(res, 400, { error: "missing_user_key" });
    return;
  }

  const user = await pool.query("select name, picture from shikaka_users where google_sub = $1", [userKey.replace("google:", "")]);
  const userName = user.rows[0]?.name || "Player";

  const stats = await pool.query(`
    select event_type, size, mean_area, area_spread, elapsed_ms
    from shikaka_events
    where user_key = $1
  `, [userKey]);

  const bestTimes = {};
  const allTimes = {};
  let totalSuccess = 0;
  let totalStarts = 0;

  for (const row of stats.rows) {
    if (row.event_type === "start") totalStarts++;
    if (row.event_type === "solve") {
      totalSuccess++;
      const key = `${row.size}-${row.mean_area}-${row.area_spread}`;
      if (!bestTimes[key] || row.elapsed_ms < bestTimes[key]) bestTimes[key] = row.elapsed_ms;
      if (!allTimes[key]) allTimes[key] = [];
      allTimes[key].push(row.elapsed_ms);
    }
  }

  const processedStats = PRESETS.map(p => {
    const key = `${p.size}-${p.meanArea}-${p.areaSpread}`;
    const times = allTimes[key] || [];
    const avg = calculateIqrAverage(times);
    return {
      label: `${p.size}x${p.size}`,
      best: bestTimes[key] || null,
      average: avg
    };
  });

  sendJson(res, 200, {
    name: userName,
    totalSuccess,
    totalUnsuccessful: Math.max(0, totalStarts - totalSuccess),
    presets: processedStats
  });
}

function calculateIqrAverage(times) {
  if (times.length === 0) return null;
  if (times.length < 4) return times.reduce((a, b) => a + b, 0) / times.length;

  const sorted = [...times].sort((a, b) => a - b);
  const q1 = quantile(sorted, 0.25);
  const q3 = quantile(sorted, 0.75);
  const iqr = q3 - q1;
  const lb = q1 - 1.5 * iqr;
  const ub = q3 + 1.5 * iqr;

  const filtered = sorted.filter(t => t >= lb && t <= ub);
  if (filtered.length === 0) return sorted[Math.floor(sorted.length / 2)];
  return filtered.reduce((a, b) => a + b, 0) / filtered.length;
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
  await storeSession(sessionId, {
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

async function handleLogout(req, res) {
  const sessionId = readSignedSession(req);
  if (sessionId) await deleteSession(sessionId);
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

async function getAuth(req) {
  const sessionId = readSignedSession(req);
  if (!sessionId) return null;
  const sessionHash = hashSessionId(sessionId);
  const result = await pool.query(
    `select payload
     from shikaka_sessions
     where session_hash = $1 and expires_at > now()
     limit 1`,
    [sessionHash]
  );
  return result.rows[0]?.payload || null;
}

async function storeSession(sessionId, payload) {
  const sessionHash = hashSessionId(sessionId);
  await pool.query(
    `insert into shikaka_sessions (session_hash, payload, expires_at, created_at, updated_at)
     values ($1, $2, now() + ($3::text || ' seconds')::interval, now(), now())
     on conflict (session_hash) do update
     set payload = excluded.payload,
         expires_at = excluded.expires_at,
         updated_at = now()`,
    [sessionHash, payload, SESSION_MAX_AGE_SECONDS]
  );
}

async function deleteSession(sessionId) {
  await pool.query("delete from shikaka_sessions where session_hash = $1", [hashSessionId(sessionId)]);
}

function hashSessionId(sessionId) {
  return createHash("sha256").update(`${SESSION_SECRET}:session:${sessionId}`).digest("hex");
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

function cookieHeader(name, value, maxAge = SESSION_MAX_AGE_SECONDS) {
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
