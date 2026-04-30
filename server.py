import hashlib
import hmac
import json
import math
import mimetypes
import os
import secrets
import time
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb


def load_dotenv(path):
  if not path.is_file():
    return
  for line in path.read_text(encoding="utf-8").splitlines():
    line = line.strip()
    if not line or line.startswith("#") or "=" not in line:
      continue
    key, value = line.split("=", 1)
    key = key.strip()
    value = value.strip().strip('"').strip("'")
    os.environ.setdefault(key, value)


load_dotenv(Path(__file__).with_name(".env"))

PORT = int(os.environ.get("PORT", "3000"))
HOST = os.environ.get("HOST", "0.0.0.0")
PASSWORD = os.environ.get("SHIKAKU_PASSWORD", "change-me")
DATABASE_URL = os.environ.get("DATABASE_URL", "postgres://localhost:5432/shikaka")
SESSION_SECRET = os.environ.get("SESSION_SECRET", "dev-session-secret-change-me")
GOOGLE_CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID", "")
GOOGLE_CLIENT_SECRET = os.environ.get("GOOGLE_CLIENT_SECRET", "")
PUBLIC_BASE_URL = os.environ.get("PUBLIC_BASE_URL", "")
PUBLIC_DIR = Path(__file__).with_name("public").resolve()
STATE_KEY = "solo"
TUNING_MAX = 30
SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30
PRESETS = [
  {"size": 6, "meanArea": 5, "areaSpread": 6},
  {"size": 8, "meanArea": 5, "areaSpread": 15},
  {"size": 10, "meanArea": 6, "areaSpread": 10},
  {"size": 15, "meanArea": 7, "areaSpread": 14},
  {"size": 20, "meanArea": 8, "areaSpread": 17},
  {"size": 26, "meanArea": 8, "areaSpread": 19},
]
BOARD_SIZES = [preset["size"] for preset in PRESETS]


def connect():
  return psycopg.connect(DATABASE_URL, row_factory=dict_row)


def query(sql, params=(), fetch=False, one=False):
  with connect() as conn:
    with conn.cursor() as cur:
      cur.execute(sql, params)
      if one:
        return cur.fetchone()
      if fetch:
        return cur.fetchall()
  return None


def init_database():
  statements = [
    """
    create table if not exists shikaka_state (
      state_key text primary key,
      payload jsonb not null,
      updated_at timestamptz not null default now()
    )
    """,
    """
    create table if not exists shikaka_users (
      google_sub text primary key,
      email text,
      name text,
      picture text,
      updated_at timestamptz not null default now()
    )
    """,
    """
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
    """,
    """
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
    """,
    """
    create table if not exists shikaka_reveals (
      user_key text not null,
      size integer not null,
      seed text not null,
      mean_area integer not null,
      area_spread integer not null,
      revealed_at timestamptz not null default now(),
      primary key (user_key, size, seed, mean_area, area_spread)
    )
    """,
    """
    create table if not exists shikaka_sessions (
      session_hash text primary key,
      payload jsonb not null,
      expires_at timestamptz not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
    """,
    "delete from shikaka_sessions where expires_at <= now()",
  ]
  with connect() as conn:
    with conn.cursor() as cur:
      for statement in statements:
        cur.execute(statement)


class ShikakaHandler(BaseHTTPRequestHandler):
  server_version = "ShikakaPython/0.1"

  def do_GET(self):
    self.route()

  def do_HEAD(self):
    self.route()

  def do_POST(self):
    self.route()

  def do_PUT(self):
    self.route()

  def log_message(self, fmt, *args):
    print(f"{self.address_string()} - {fmt % args}")

  def route(self):
    try:
      parsed = urllib.parse.urlparse(self.path)
      path = parsed.path
      method = self.command

      if path == "/auth/google/start" and method == "GET":
        self.handle_google_start()
        return
      if path == "/auth/google/callback" and method == "GET":
        self.handle_google_callback()
        return
      if path == "/api/login" and method == "POST":
        self.handle_login()
        return
      if path == "/api/logout" and method == "POST":
        self.handle_logout()
        return
      if path == "/api/me" and method == "GET":
        auth = self.get_auth()
        self.send_json(200, {
          "authenticated": bool(auth),
          "googleConfigured": is_google_configured(),
          "user": auth.get("user") if auth else None,
        })
        return
      if path == "/api/leaderboard" and method == "GET":
        self.handle_get_leaderboard(parsed)
        return
      if path == "/api/user-stats" and method == "GET":
        self.handle_get_user_stats(parsed)
        return
      if path == "/api/level" and method == "POST":
        self.handle_create_level()
        return
      if path == "/api/solution" and method == "POST":
        self.handle_get_solution()
        return

      auth = self.get_auth()
      if not auth and path.startswith("/api/"):
        self.send_json(401, {"error": "unauthorized"})
        return

      if path == "/api/state" and method == "GET":
        self.handle_get_state(auth)
        return
      if path == "/api/state" and method == "PUT":
        self.handle_put_state(auth)
        return
      if path == "/api/score" and method == "POST":
        self.handle_post_score(auth)
        return
      if method in ("GET", "HEAD"):
        self.serve_static(parsed)
        return

      self.send_json(405, {"error": "method_not_allowed"})
    except Exception as error:
      print(error)
      self.send_json(500, {"error": "internal_error"})

  def handle_login(self):
    body = self.read_json()
    password = str(body.get("password") or "")
    if not hmac.compare_digest(password.encode(), PASSWORD.encode()):
      self.send_json(403, {"error": "bad_password"})
      return

    session_id = secrets.token_hex(32)
    store_session(session_id, {
      "stateKey": STATE_KEY,
      "user": {"provider": "password", "name": "Password user"},
    })
    self.send_header_cookie(cookie_header("sid", sign_session(session_id)))
    self.send_json(200, {"ok": True})

  def handle_logout(self):
    session_id = self.read_signed_session()
    if session_id:
      delete_session(session_id)
    self.send_header_cookie("sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0")
    self.send_json(200, {"ok": True})

  def handle_get_state(self, auth):
    row = query("select payload from shikaka_state where state_key = %s", (auth["stateKey"],), one=True)
    self.send_json(200, {"state": row["payload"] if row else None})

  def handle_put_state(self, auth):
    body = self.read_json(512_000)
    query(
      """
      insert into shikaka_state (state_key, payload, updated_at)
      values (%s, %s, now())
      on conflict (state_key) do update set payload = excluded.payload, updated_at = now()
      """,
      (auth["stateKey"], Jsonb(body.get("state"))),
    )
    self.send_json(200, {"ok": True})

  def handle_create_level(self):
    body = self.read_json()
    size = to_int(body.get("size"))
    tuning = {
      "meanArea": to_int(body.get("meanArea")),
      "areaSpread": to_int(body.get("areaSpread")),
    }
    if (
      size not in BOARD_SIZES or
      not isinstance(tuning["meanArea"], int) or
      not isinstance(tuning["areaSpread"], int) or
      tuning["meanArea"] < 0 or tuning["meanArea"] > TUNING_MAX or
      tuning["areaSpread"] < 0 or tuning["areaSpread"] > TUNING_MAX
    ):
      self.send_json(400, {"error": "bad_level_request"})
      return

    level = make_game(size, tuning)
    query(
      """
      insert into shikaka_levels (size, seed, mean_area, area_spread, payload, created_at)
      values (%s, %s, %s, %s, %s, now())
      on conflict (size, seed, mean_area, area_spread) do nothing
      """,
      (size, str(level["seed"]), tuning["meanArea"], tuning["areaSpread"], Jsonb(level)),
    )
    self.send_json(200, {"level": public_level(level)})

  def handle_get_solution(self):
    auth = self.get_auth()
    if not auth:
      self.send_json(401, {"error": "unauthorized"})
      return
    body = self.read_json()
    size = to_int(body.get("size"))
    mean_area = to_int(body.get("meanArea"))
    area_spread = to_int(body.get("areaSpread"))
    seed = str(body.get("seed") or "")
    level = find_level(size, seed, mean_area, area_spread)
    if not level:
      self.send_json(404, {"error": "unknown_level"})
      return
    query(
      """
      insert into shikaka_reveals (user_key, size, seed, mean_area, area_spread, revealed_at)
      values (%s, %s, %s, %s, %s, now())
      on conflict (user_key, size, seed, mean_area, area_spread)
      do update set revealed_at = excluded.revealed_at
      """,
      (auth["stateKey"], size, seed, mean_area, area_spread),
    )
    self.send_json(200, {"solution": level["solution"]})

  def handle_post_score(self, auth):
    body = self.read_json(512_000)
    size = to_int(body.get("size"))
    mean_area = to_int(body.get("meanArea"))
    area_spread = to_int(body.get("areaSpread"))
    elapsed_ms = to_int(body.get("elapsedMs"))
    seed = str(body.get("seed") or "")
    if not all(isinstance(value, int) for value in [size, mean_area, area_spread, elapsed_ms]) or size <= 0 or elapsed_ms <= 0 or not seed:
      self.send_json(400, {"error": "bad_score"})
      return
    if not is_preset(size, mean_area, area_spread):
      self.send_json(400, {"error": "bad_score"})
      return
    level = find_level(size, seed, mean_area, area_spread)
    if not level:
      self.send_json(400, {"error": "unknown_level"})
      return
    if body.get("usedSolution") or has_reveal(auth["stateKey"], size, seed, mean_area, area_spread):
      self.send_json(400, {"error": "solution_revealed"})
      return
    if not is_solved_submission(size, level["clues"], body.get("regions")):
      self.send_json(400, {"error": "invalid_solution"})
      return
    user = auth.get("user") or {}
    display_name = user.get("name") or user.get("email") or "Player"
    query(
      """
      insert into shikaka_scores (user_key, display_name, size, seed, mean_area, area_spread, elapsed_ms, created_at)
      values (%s, %s, %s, %s, %s, %s, %s, now())
      on conflict (user_key, size, seed) do update
      set elapsed_ms = least(shikaka_scores.elapsed_ms, excluded.elapsed_ms),
          display_name = excluded.display_name,
          mean_area = excluded.mean_area,
          area_spread = excluded.area_spread
      """,
      (auth["stateKey"], display_name, size, seed, mean_area, area_spread, elapsed_ms),
    )
    self.send_json(200, {"ok": True})

  def handle_get_leaderboard(self, parsed):
    params = urllib.parse.parse_qs(parsed.query)
    size_param = params.get("size", [None])[0]
    sizes = [to_int(size_param)] if size_param else BOARD_SIZES
    sizes = [size for size in sizes if isinstance(size, int)]
    preset_tuples = [(preset["size"], preset["meanArea"], preset["areaSpread"]) for preset in PRESETS if preset["size"] in sizes]
    if not preset_tuples:
      self.send_json(200, {"sizes": sizes, "groups": {str(size): [] for size in sizes}})
      return
    preset_sql = ", ".join(["(%s, %s, %s)"] * len(preset_tuples))
    preset_params = [value for preset in preset_tuples for value in preset]
    rows = query(
      f"""
      select user_key, display_name, size, seed, mean_area, area_spread, elapsed_ms, created_at
      from (
        select best_per_user.*,
               row_number() over (partition by size order by elapsed_ms asc, created_at asc) as rank
        from (
          select distinct on (size, user_key)
                 user_key, display_name, size, seed, mean_area, area_spread, elapsed_ms, created_at
          from shikaka_scores
          where (size, mean_area, area_spread) in ({preset_sql})
          order by size, user_key, elapsed_ms asc, created_at asc
        ) best_per_user
      ) ranked
      where rank <= 20
      order by size asc, elapsed_ms asc, created_at asc
      """,
      tuple(preset_params),
      fetch=True,
    )
    groups = {str(size): [] for size in sizes}
    for row in rows:
      groups[str(row["size"])].append(row)
    self.send_json(200, {"sizes": sizes, "groups": groups})

  def handle_get_user_stats(self, parsed):
    params = urllib.parse.parse_qs(parsed.query)
    user_key = params.get("userKey", [None])[0]
    if not user_key:
      self.send_json(400, {"error": "missing_user_key"})
      return

    user = None
    if user_key.startswith("google:"):
      user = query(
        "select name, email from shikaka_users where google_sub = %s",
        (user_key.removeprefix("google:"),),
        one=True,
      )
    score_name = query(
      """
      select display_name
      from shikaka_scores
      where user_key = %s
      order by created_at desc
      limit 1
      """,
      (user_key,),
      one=True,
    )
    name = (user or {}).get("name") or (user or {}).get("email") or (score_name or {}).get("display_name") or "Player"

    rows = query(
      """
      select size, mean_area, area_spread, elapsed_ms
      from shikaka_scores
      where user_key = %s
      """,
      (user_key,),
      fetch=True,
    )

    grouped = {}
    for row in rows:
      key_tuple = (row["size"], row["mean_area"], row["area_spread"])
      grouped.setdefault(key_tuple, []).append(row["elapsed_ms"])

    presets = []
    for preset in PRESETS:
      key_tuple = (preset["size"], preset["meanArea"], preset["areaSpread"])
      times = grouped.get(key_tuple, [])
      presets.append({
        "label": f"{preset['size']}x{preset['size']}",
        "best": min(times) if times else None,
        "average": round(sum(times) / len(times)) if times else None,
      })

    self.send_json(200, {
      "name": name,
      "totalSuccess": len(rows),
      "totalUnsuccessful": 0,
      "presets": presets,
    })

  def handle_google_start(self):
    if not is_google_configured():
      self.send_text(501, "Google login is not configured.")
      return
    state = secrets.token_hex(24)
    params = urllib.parse.urlencode({
      "client_id": GOOGLE_CLIENT_ID,
      "redirect_uri": google_redirect_uri(self),
      "response_type": "code",
      "scope": "openid email profile",
      "state": state,
      "prompt": "select_account",
    })
    self.send_response(302)
    self.send_header("Set-Cookie", cookie_header("oauth_state", sign_session(state), 600))
    self.send_header("Location", f"https://accounts.google.com/o/oauth2/v2/auth?{params}")
    self.end_headers()

  def handle_google_callback(self):
    if not is_google_configured():
      self.send_text(501, "Google login is not configured.")
      return
    parsed = urllib.parse.urlparse(self.path)
    params = urllib.parse.parse_qs(parsed.query)
    code = params.get("code", [None])[0]
    state = params.get("state", [None])[0]
    signed_state = parse_cookies(self.headers.get("Cookie", "")).get("oauth_state")
    if not code or not state or not signed_state or signed_state != sign_session(state):
      self.send_text(403, "Invalid OAuth state.")
      return

    token = post_form("https://oauth2.googleapis.com/token", {
      "code": code,
      "client_id": GOOGLE_CLIENT_ID,
      "client_secret": GOOGLE_CLIENT_SECRET,
      "redirect_uri": google_redirect_uri(self),
      "grant_type": "authorization_code",
    })
    profile = get_json("https://www.googleapis.com/oauth2/v3/userinfo", {
      "Authorization": f"Bearer {token.get('access_token', '')}",
    })
    google_sub = str(profile.get("sub") or "")
    if not google_sub:
      self.send_text(502, "Google profile did not include subject.")
      return
    query(
      """
      insert into shikaka_users (google_sub, email, name, picture, updated_at)
      values (%s, %s, %s, %s, now())
      on conflict (google_sub) do update
      set email = excluded.email,
          name = excluded.name,
          picture = excluded.picture,
          updated_at = now()
      """,
      (google_sub, profile.get("email"), profile.get("name"), profile.get("picture")),
    )
    session_id = secrets.token_hex(32)
    store_session(session_id, {
      "stateKey": f"google:{google_sub}",
      "user": {
        "provider": "google",
        "email": profile.get("email"),
        "name": profile.get("name") or profile.get("email") or "Google user",
        "picture": profile.get("picture"),
      },
    })
    self.send_response(302)
    self.send_header("Set-Cookie", cookie_header("sid", sign_session(session_id)))
    self.send_header("Set-Cookie", "oauth_state=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0")
    self.send_header("Location", "/")
    self.end_headers()

  def serve_static(self, parsed):
    pathname = urllib.parse.unquote(parsed.path)
    if pathname == "/":
      pathname = "/index.html"
    target = (PUBLIC_DIR / pathname.lstrip("/")).resolve()
    if not str(target).startswith(str(PUBLIC_DIR)):
      self.send_text(403, "Forbidden")
      return
    if not target.is_file():
      target = PUBLIC_DIR / "index.html"
    content_type = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
    if target.suffix == ".js":
      content_type = "text/javascript"
    self.send_response(200)
    self.send_header("Content-Type", content_type + ("; charset=utf-8" if content_type.startswith("text/") else ""))
    self.send_header("Cache-Control", "no-cache")
    self.end_headers()
    if self.command != "HEAD":
      self.wfile.write(target.read_bytes())

  def get_auth(self):
    session_id = self.read_signed_session()
    if not session_id:
      return None
    row = query(
      "select payload from shikaka_sessions where session_hash = %s and expires_at > now() limit 1",
      (hash_session_id(session_id),),
      one=True,
    )
    return row["payload"] if row else None

  def read_signed_session(self):
    raw = parse_cookies(self.headers.get("Cookie", "")).get("sid")
    if not raw or "." not in raw:
      return None
    session_id, signature = raw.split(".", 1)
    expected = hmac_sha(session_id)
    if not hmac.compare_digest(signature, expected):
      return None
    return session_id

  def read_json(self, max_bytes=16_384):
    length = int(self.headers.get("Content-Length", "0") or "0")
    if length > max_bytes:
      raise ValueError("body too large")
    text = self.rfile.read(length).decode("utf-8") if length else "{}"
    return json.loads(text or "{}")

  def send_header_cookie(self, cookie):
    self._pending_cookie = cookie

  def send_json(self, status, payload):
    body = json.dumps(payload, ensure_ascii=False, default=json_default).encode("utf-8")
    self.send_response(status)
    if hasattr(self, "_pending_cookie"):
      self.send_header("Set-Cookie", self._pending_cookie)
      delattr(self, "_pending_cookie")
    self.send_header("Content-Type", "application/json; charset=utf-8")
    self.send_header("Content-Length", str(len(body)))
    self.end_headers()
    self.wfile.write(body)

  def send_text(self, status, text):
    body = text.encode("utf-8")
    self.send_response(status)
    self.send_header("Content-Type", "text/plain; charset=utf-8")
    self.send_header("Content-Length", str(len(body)))
    self.end_headers()
    self.wfile.write(body)


def find_level(size, seed, mean_area, area_spread):
  row = query(
    """
    select payload from shikaka_levels
    where size = %s and seed = %s and mean_area = %s and area_spread = %s
    limit 1
    """,
    (size, seed, mean_area, area_spread),
    one=True,
  )
  if row:
    return row["payload"]
  row = query(
    """
    select payload from shikaka_levels
    where size = %s and seed = %s
    order by created_at desc
    limit 1
    """,
    (size, seed),
    one=True,
  )
  return row["payload"] if row else None


def has_reveal(user_key, size, seed, mean_area, area_spread):
  row = query(
    """
    select 1 from shikaka_reveals
    where user_key = %s and size = %s and seed = %s and mean_area = %s and area_spread = %s
    limit 1
    """,
    (user_key, size, seed, mean_area, area_spread),
    one=True,
  )
  return bool(row)


def public_level(level):
  return {
    "size": level["size"],
    "tuning": level["tuning"],
    "seed": level["seed"],
    "clues": level["clues"],
  }


def is_solved_submission(size, clues, regions):
  if not isinstance(clues, list) or not isinstance(regions, list) or not clues or not regions:
    return False
  occupied = set()
  for region in regions:
    rect = normalize_rect_payload(region)
    if not rect:
      return False
    area = rect["w"] * rect["h"]
    matching = [clue for clue in clues if contains_point(rect, int(clue["x"]), int(clue["y"]))]
    if len(matching) != 1 or int(matching[0]["value"]) != area:
      return False
    for y in range(rect["y"], rect["y"] + rect["h"]):
      for x in range(rect["x"], rect["x"] + rect["w"]):
        if x < 0 or y < 0 or x >= size or y >= size or (x, y) in occupied:
          return False
        occupied.add((x, y))
  return len(occupied) == size * size


def normalize_rect_payload(rect):
  if not isinstance(rect, dict):
    return None
  x, y, w, h = (to_int(rect.get(key)) for key in ["x", "y", "w", "h"])
  if not all(isinstance(value, int) for value in [x, y, w, h]) or w <= 0 or h <= 0:
    return None
  return {"x": x, "y": y, "w": w, "h": h}


def contains_point(rect, x, y):
  return rect["x"] <= x < rect["x"] + rect["w"] and rect["y"] <= y < rect["y"] + rect["h"]


def make_game(size, tuning):
  candidate = pick_generated_level(size, tuning)
  seed = candidate["seed"]
  rng = mulberry32(seed)
  solution = candidate["solution"]
  clues = [{
    "x": rect["x"] + math.floor(rng() * rect["w"]),
    "y": rect["y"] + math.floor(rng() * rect["h"]),
    "value": rect["w"] * rect["h"],
  } for rect in solution]
  return {"size": size, "tuning": tuning, "seed": seed, "clues": clues, "solution": solution}


def pick_generated_level(size, tuning):
  attempts = 80 if size >= 20 else 56
  best = None
  for _ in range(attempts):
    seed = secrets.randbelow(2 ** 31)
    rng = mulberry32(seed)
    solution = grow_tiling(size, rng, tuning)
    score = score_solution(solution, tuning)
    if not best or score < best["score"]:
      best = {"seed": seed, "solution": solution, "score": score}
  return best


def grow_tiling(size, rng, tuning):
  profile = generator_profile(size, tuning)
  filled = [[False for _ in range(size)] for _ in range(size)]
  rects = []
  while True:
    origin = first_empty_cell(filled, size)
    if not origin:
      return repair_tiny_rects(rects)
    candidates = rect_candidates_from(origin["x"], origin["y"], filled, size, profile)
    if not candidates:
      rects.append({"x": origin["x"], "y": origin["y"], "w": 1, "h": 1})
      filled[origin["y"]][origin["x"]] = True
      continue
    rect = weighted_pick(candidates, rng)
    rects.append(rect)
    for y in range(rect["y"], rect["y"] + rect["h"]):
      for x in range(rect["x"], rect["x"] + rect["w"]):
        filled[y][x] = True


def repair_tiny_rects(rects):
  changed = True
  while changed:
    changed = False
    tiny_index = next((index for index, rect in enumerate(rects) if rect["w"] * rect["h"] < 3), -1)
    if tiny_index == -1:
      break
    tiny = rects[tiny_index]
    neighbor_index = next((index for index, rect in enumerate(rects) if index != tiny_index and rectangular_union(tiny, rect)), -1)
    if neighbor_index == -1:
      break
    merged = rectangular_union(tiny, rects[neighbor_index])
    for index in sorted([tiny_index, neighbor_index], reverse=True):
      rects.pop(index)
    rects.append(merged)
    changed = True
  return rects


def rectangular_union(a, b):
  x = min(a["x"], b["x"])
  y = min(a["y"], b["y"])
  right = max(a["x"] + a["w"], b["x"] + b["w"])
  bottom = max(a["y"] + a["h"], b["y"] + b["h"])
  area = (right - x) * (bottom - y)
  if area != a["w"] * a["h"] + b["w"] * b["h"]:
    return None
  return {"x": x, "y": y, "w": right - x, "h": bottom - y}


def first_empty_cell(filled, size):
  for y in range(size):
    for x in range(size):
      if not filled[y][x]:
        return {"x": x, "y": y}
  return None


def rect_candidates_from(x, y, filled, size, profile):
  candidates = []
  max_width = 0
  while x + max_width < size and not filled[y][x + max_width]:
    max_width += 1
  for w in range(1, max_width + 1):
    h = 0
    while y + h < size and all(not filled[y + h][x + dx] for dx in range(w)):
      h += 1
    for height in range(1, h + 1):
      area = w * height
      if area < profile["minArea"] and area != remaining_island_area(x, y, filled, size):
        continue
      if area > profile["maxArea"]:
        continue
      aspect = max(w / height, height / w)
      weight = area_distribution_weight(area, profile) * aspect_weight(aspect)
      if weight > 0:
        candidates.append({"x": x, "y": y, "w": w, "h": height, "weight": weight})
  return candidates


def remaining_island_area(x, y, filled, size):
  return sum(1 for yy in range(y, size) for xx in range(x, size) if not filled[yy][xx])


def area_distribution_weight(area, profile):
  sigma = max(0.75, profile["targetIqr"] / 1.349)
  distance = (area - profile["targetMedian"]) / sigma
  return math.exp(-0.5 * distance * distance) * area_shape_weight(area)


def weighted_pick(items, rng):
  total = sum(item["weight"] for item in items)
  roll = rng() * total
  for item in items:
    roll -= item["weight"]
    if roll <= 0:
      return {key: value for key, value in item.items() if key != "weight"}
  return {key: value for key, value in items[-1].items() if key != "weight"}


def score_solution(solution, tuning):
  profile = generator_profile(round(math.sqrt(sum(rect["w"] * rect["h"] for rect in solution))), tuning)
  stats = area_stats(solution)
  median_error = abs(stats["median"] - profile["targetMedian"]) / profile["targetMedian"]
  iqr_error = abs(stats["iqr"] - profile["targetIqr"]) / max(1, profile["targetIqr"])
  duplicate_penalty = histogram_concentration(stats["counts"], len(solution))
  duplicate_weight = 80 * (profile["spreadRatio"] / 0.2) if profile["spreadRatio"] < 0.2 else 80
  histogram_error = distribution_error(stats["counts"], len(stats["areas"]), profile)
  tiny_penalty = stats["counts"].get(2, 0) / len(solution)
  invalid_tiny_penalty = (stats["counts"].get(1, 0) + stats["counts"].get(2, 0)) / len(solution)
  below = len([area for area in stats["areas"] if area < profile["targetMedian"]]) / len(stats["areas"])
  above = len([area for area in stats["areas"] if area > profile["targetMedian"]]) / len(stats["areas"])
  skew_penalty = abs(below - above)
  low_area_limit = max(3, math.floor(profile["targetMedian"] * 0.75))
  low_area_share = len([area for area in stats["areas"] if area < low_area_limit]) / len(stats["areas"])
  low_area_penalty = low_area_share if profile["targetMedian"] >= 6 else 0
  spread_weight = 80 + (1 - profile["spreadRatio"]) * 220
  return (
    median_error * 190 +
    iqr_error * spread_weight +
    histogram_error * 260 +
    skew_penalty * 120 +
    low_area_penalty * 180 +
    duplicate_penalty * duplicate_weight +
    tiny_penalty * 24 +
    invalid_tiny_penalty * 10000
  )


def generator_profile(size, tuning):
  target_median = max(3, tuning["meanArea"])
  spread_ratio = tuning["areaSpread"] / TUNING_MAX
  target_iqr = 0 if spread_ratio == 0 else max(1, target_median * spread_ratio * 1.25)
  mean_ratio = target_median / TUNING_MAX
  return {
    "maxArea": max(4, js_round(target_median + target_iqr * 2.8)),
    "minArea": 2 if target_median < 5 else 3,
    "targetMedian": target_median,
    "targetIqr": target_iqr,
    "spreadRatio": spread_ratio,
    "stopBase": max(0.08, min(0.82, 0.18 + mean_ratio * 0.48)),
    "stopSlope": max(0.12, 0.62 - mean_ratio * 0.24),
    "edgeBias": 0.85 + (1 - spread_ratio) * 1.35,
  }


def aspect_weight(aspect):
  if aspect <= 3:
    return 1
  if aspect <= 4:
    return 0.28
  return 0.035


def area_stats(solution):
  areas = sorted(rect["w"] * rect["h"] for rect in solution)
  counts = {}
  for area in areas:
    counts[area] = counts.get(area, 0) + 1
  q1 = quantile(areas, 0.25)
  median = quantile(areas, 0.5)
  q3 = quantile(areas, 0.75)
  return {"areas": areas, "q1": q1, "median": median, "q3": q3, "iqr": q3 - q1, "counts": counts}


def distribution_error(counts, total, profile):
  expected = expected_distribution(profile)
  error = 0
  for area, expected_share in expected.items():
    actual_share = counts.get(area, 0) / total
    error += abs(actual_share - expected_share)
  for area, count in counts.items():
    if area not in expected:
      error += count / total
  return error


def expected_distribution(profile):
  sigma = max(0.75, profile["targetIqr"] / 1.349)
  weights = {}
  total = 0
  for area in range(profile["minArea"], profile["maxArea"] + 1):
    distance = (area - profile["targetMedian"]) / sigma
    weight = math.exp(-0.5 * distance * distance) * area_shape_weight(area)
    weights[area] = weight
    total += weight
  return {area: weight / total for area, weight in weights.items()}


def area_shape_weight(area):
  best_aspect = area
  width = 1
  while width * width <= area:
    if area % width == 0:
      height = area / width
      best_aspect = min(best_aspect, max(width / height, height / width))
    width += 1
  if best_aspect <= 3:
    return 1
  if best_aspect <= 4:
    return 0.45
  return 0.12


def quantile(sorted_values, q):
  if not sorted_values:
    return 0
  position = (len(sorted_values) - 1) * q
  lower = math.floor(position)
  upper = math.ceil(position)
  if lower == upper:
    return sorted_values[lower]
  return sorted_values[lower] + (sorted_values[upper] - sorted_values[lower]) * (position - lower)


def histogram_concentration(counts, total):
  return sum((count / total) ** 2 for count in counts.values())


def imul(a, b):
  return ((a & 0xFFFFFFFF) * (b & 0xFFFFFFFF)) & 0xFFFFFFFF


def js_round(value):
  return math.floor(value + 0.5)


def mulberry32(seed):
  seed &= 0xFFFFFFFF
  def next_value():
    nonlocal seed
    seed = (seed + 0x6D2B79F5) & 0xFFFFFFFF
    value = imul(seed ^ (seed >> 15), seed | 1)
    value ^= (value + imul(value ^ (value >> 7), value | 61)) & 0xFFFFFFFF
    return ((value ^ (value >> 14)) & 0xFFFFFFFF) / 4294967296
  return next_value


def store_session(session_id, payload):
  expires_at = datetime.now(timezone.utc) + timedelta(seconds=SESSION_MAX_AGE_SECONDS)
  query(
    """
    insert into shikaka_sessions (session_hash, payload, expires_at, created_at, updated_at)
    values (%s, %s, %s, now(), now())
    on conflict (session_hash) do update
    set payload = excluded.payload,
        expires_at = excluded.expires_at,
        updated_at = now()
    """,
    (hash_session_id(session_id), Jsonb(payload), expires_at),
  )


def delete_session(session_id):
  query("delete from shikaka_sessions where session_hash = %s", (hash_session_id(session_id),))


def hash_session_id(session_id):
  return hashlib.sha256(f"{SESSION_SECRET}:session:{session_id}".encode()).hexdigest()


def sign_session(session_id):
  return f"{session_id}.{hmac_sha(session_id)}"


def hmac_sha(value):
  return hashlib.sha256(f"{SESSION_SECRET}:{value}".encode()).hexdigest()


def parse_cookies(header):
  cookies = {}
  for part in header.split(";"):
    if "=" not in part:
      continue
    key, value = part.strip().split("=", 1)
    if key:
      cookies[key] = urllib.parse.unquote(value)
  return cookies


def cookie_header(name, value, max_age=SESSION_MAX_AGE_SECONDS):
  return f"{name}={urllib.parse.quote(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age={max_age}"


def is_google_configured():
  return bool(GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET)


def google_redirect_uri(handler):
  return f"{base_url(handler)}/auth/google/callback"


def base_url(handler):
  if PUBLIC_BASE_URL:
    return PUBLIC_BASE_URL.rstrip("/")
  proto = handler.headers.get("X-Forwarded-Proto", "http")
  return f"{proto}://{handler.headers.get('Host')}"


def post_form(url, data):
  encoded = urllib.parse.urlencode(data).encode()
  request = urllib.request.Request(url, data=encoded, headers={"Content-Type": "application/x-www-form-urlencoded"})
  with urllib.request.urlopen(request, timeout=15) as response:
    return json.loads(response.read().decode())


def get_json(url, headers):
  request = urllib.request.Request(url, headers=headers)
  with urllib.request.urlopen(request, timeout=15) as response:
    return json.loads(response.read().decode())


def to_int(value):
  try:
    if value is None or value == "":
      return None
    number = int(value)
    return number if str(number) == str(value) or isinstance(value, int) else number
  except (TypeError, ValueError):
    return None


def is_preset(size, mean_area, area_spread):
  return any(
    preset["size"] == size and preset["meanArea"] == mean_area and preset["areaSpread"] == area_spread
    for preset in PRESETS
  )


def json_default(value):
  if isinstance(value, datetime):
    return value.isoformat().replace("+00:00", "Z")
  raise TypeError(f"Cannot serialize {type(value)}")


if __name__ == "__main__":
  init_database()
  server = ThreadingHTTPServer((HOST, PORT), ShikakaHandler)
  print(f"Shikaka listening on http://{HOST}:{PORT}")
  try:
    server.serve_forever()
  except KeyboardInterrupt:
    pass
