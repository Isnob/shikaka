const login = document.querySelector("#login");
const game = document.querySelector("#game");
const loginForm = document.querySelector("#loginForm");
const loginError = document.querySelector("#loginError");
const board = document.querySelector("#board");
const statusLine = document.querySelector("#status");
const sizeSelect = document.querySelector("#size");
const newGameButton = document.querySelector("#newGame");
const undoButton = document.querySelector("#undo");
const clearButton = document.querySelector("#clear");
const logoutButton = document.querySelector("#logout");
const metaSize = document.querySelector("#metaSize");
const metaSeed = document.querySelector("#metaSeed");
const metaCovered = document.querySelector("#metaCovered");

const palette = ["#f7c6bd", "#f2d377", "#9fd8cb", "#a8c8f2", "#d7b6e8", "#b8d98b", "#f4b06a", "#b7c4d8"];

let state = null;
let dragStart = null;
let dragEnd = null;
let saveTimer = null;

boot();

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  loginError.textContent = "";
  const password = document.querySelector("#password").value;
  const response = await api("/api/login", { method: "POST", body: { password } });
  if (!response.ok) {
    loginError.textContent = "Пароль не подошел";
    return;
  }
  await loadGame();
});

newGameButton.addEventListener("click", () => {
  startNewGame(Number(sizeSelect.value));
});

clearButton.addEventListener("click", () => {
  pushHistory();
  state.regions = [];
  render();
  scheduleSave();
});

undoButton.addEventListener("click", () => {
  const previous = state.history.pop();
  if (!previous) return;
  state.regions = previous;
  render();
  scheduleSave();
});

logoutButton.addEventListener("click", async () => {
  await api("/api/logout", { method: "POST" });
  game.classList.add("hidden");
  login.classList.remove("hidden");
});

async function boot() {
  const me = await api("/api/me");
  if (me.authenticated) {
    await loadGame();
  } else {
    login.classList.remove("hidden");
  }
}

async function loadGame() {
  login.classList.add("hidden");
  game.classList.remove("hidden");
  const saved = await api("/api/state");
  if (saved.state) {
    state = normalizeState(saved.state);
  } else {
    state = makeGame(8);
    await saveState();
  }
  sizeSelect.value = String(state.size);
  render();
}

function startNewGame(size) {
  state = makeGame(size);
  render();
  scheduleSave();
}

function makeGame(size) {
  const seed = Math.floor(Math.random() * 2 ** 31);
  const rng = mulberry32(seed);
  const solution = splitRect({ x: 0, y: 0, w: size, h: size }, rng, size);
  const clues = solution.map((rect) => ({
    x: rect.x + Math.floor(rng() * rect.w),
    y: rect.y + Math.floor(rng() * rect.h),
    value: rect.w * rect.h
  }));
  return { size, seed, clues, regions: [], history: [] };
}

function splitRect(rect, rng, size) {
  const maxArea = size <= 6 ? 8 : size <= 8 ? 12 : size <= 10 ? 16 : size <= 20 ? 28 : 36;
  const area = rect.w * rect.h;
  const verticalCuts = possibleCuts(rect.w, rect.h);
  const horizontalCuts = possibleCuts(rect.h, rect.w);
  const canVertical = verticalCuts.length > 0;
  const canHorizontal = horizontalCuts.length > 0;

  if (area <= maxArea && (area <= 3 || rng() < 0.34)) return [rect];
  if (!canVertical && !canHorizontal) return [rect];

  const splitVertical = canVertical && (!canHorizontal || rng() < rect.w / (rect.w + rect.h));
  if (splitVertical) {
    const cut = pick(verticalCuts, rng);
    return [
      ...splitRect({ x: rect.x, y: rect.y, w: cut, h: rect.h }, rng, size),
      ...splitRect({ x: rect.x + cut, y: rect.y, w: rect.w - cut, h: rect.h }, rng, size)
    ];
  }

  const cut = pick(horizontalCuts, rng);
  return [
    ...splitRect({ x: rect.x, y: rect.y, w: rect.w, h: cut }, rng, size),
    ...splitRect({ x: rect.x, y: rect.y + cut, w: rect.w, h: rect.h - cut }, rng, size)
  ];
}

function render() {
  board.innerHTML = "";
  board.style.gridTemplateColumns = `repeat(${state.size}, var(--cell))`;
  board.dataset.size = String(state.size);
  const assignments = buildAssignments();
  const preview = dragStart && dragEnd ? normalizeRect(dragStart, dragEnd) : null;
  const previewValid = preview ? validateRegion(preview).valid : true;

  for (let y = 0; y < state.size; y += 1) {
    for (let x = 0; x < state.size; x += 1) {
      const cell = document.createElement("div");
      cell.className = "cell";
      cell.dataset.x = String(x);
      cell.dataset.y = String(y);

      const clue = state.clues.find((item) => item.x === x && item.y === y);
      if (clue) {
        cell.classList.add("clue");
        cell.textContent = clue.value;
      }

      const regionIndex = assignments.get(key(x, y));
      if (regionIndex !== undefined) {
        const mark = document.createElement("span");
        mark.className = "mark";
        mark.style.background = palette[regionIndex % palette.length];
        cell.style.background = palette[regionIndex % palette.length];
        cell.append(mark);
      }

      if (preview && contains(preview, x, y)) {
        cell.classList.add("preview");
        if (!previewValid) cell.classList.add("invalid");
      }

      cell.addEventListener("pointerdown", onPointerDown);
      board.append(cell);
    }
  }

  updateStatus();
}

function onPointerDown(event) {
  const point = pointFromCell(event.currentTarget);
  dragStart = point;
  dragEnd = point;
  board.setPointerCapture(event.pointerId);
  board.addEventListener("pointermove", onPointerMove);
  board.addEventListener("pointerup", onPointerUp, { once: true });
  render();
}

function onPointerMove(event) {
  if (!dragStart) return;
  const cell = document.elementFromPoint(event.clientX, event.clientY)?.closest(".cell");
  if (!cell || !board.contains(cell)) return;
  dragEnd = pointFromCell(cell);
  render();
}

function onPointerUp() {
  board.removeEventListener("pointermove", onPointerMove);
  if (!dragStart || !dragEnd) return;
  const rect = normalizeRect(dragStart, dragEnd);
  const result = validateRegion(rect);
  if (result.valid) {
    pushHistory();
    state.regions = state.regions.filter((region) => !rectsOverlap(region, rect));
    state.regions.push(rect);
    scheduleSave();
  }
  dragStart = null;
  dragEnd = null;
  render();
}

function validateRegion(rect) {
  const area = rect.w * rect.h;
  const clues = state.clues.filter((clue) => contains(rect, clue.x, clue.y));
  if (clues.length !== 1) return { valid: false };
  if (clues[0].value !== area) return { valid: false };
  return { valid: true };
}

function updateStatus() {
  const assignments = buildAssignments();
  const total = state.size * state.size;
  const covered = assignments.size;
  const percent = Math.round((covered / total) * 100);
  const solved = covered === total && state.regions.every((region) => validateRegion(region).valid);

  metaSize.textContent = `${state.size} x ${state.size}`;
  metaSeed.textContent = state.seed;
  metaCovered.textContent = `${percent}%`;
  statusLine.textContent = solved ? "Готово: уровень решен" : "Выдели все прямоугольники";
  statusLine.style.color = solved ? "var(--good)" : "var(--muted)";
  undoButton.disabled = state.history.length === 0;
}

function normalizeState(saved) {
  return {
    size: saved.size,
    seed: saved.seed,
    clues: saved.clues || [],
    regions: saved.regions || [],
    history: saved.history || []
  };
}

function pushHistory() {
  state.history.push(state.regions.map((region) => ({ ...region })));
}

function possibleCuts(length, otherSide) {
  const cuts = [];
  for (let cut = 1; cut < length; cut += 1) {
    if (cut * otherSide > 1 && (length - cut) * otherSide > 1) {
      cuts.push(cut);
    }
  }
  return cuts;
}

function pick(items, rng) {
  return items[Math.floor(rng() * items.length)];
}

function buildAssignments() {
  const assignments = new Map();
  state.regions.forEach((region, index) => {
    for (let y = region.y; y < region.y + region.h; y += 1) {
      for (let x = region.x; x < region.x + region.w; x += 1) {
        assignments.set(key(x, y), index);
      }
    }
  });
  return assignments;
}

function normalizeRect(a, b) {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    w: Math.abs(a.x - b.x) + 1,
    h: Math.abs(a.y - b.y) + 1
  };
}

function rectsOverlap(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function contains(rect, x, y) {
  return x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h;
}

function pointFromCell(cell) {
  return { x: Number(cell.dataset.x), y: Number(cell.dataset.y) };
}

function key(x, y) {
  return `${x}:${y}`;
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveState, 250);
}

async function saveState() {
  await api("/api/state", { method: "PUT", body: { state } });
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    method: options.method || "GET",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) data.ok = false;
  return data;
}

function mulberry32(seed) {
  return function next() {
    let value = (seed += 0x6d2b79f5);
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
