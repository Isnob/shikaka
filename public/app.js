const login = document.querySelector("#login");
const game = document.querySelector("#game");
const loginForm = document.querySelector("#loginForm");
const loginError = document.querySelector("#loginError");
const board = document.querySelector("#board");
const statusLine = document.querySelector("#status");
const sizeSelect = document.querySelector("#size");
const difficultySlider = document.querySelector("#difficulty");
const difficultyLabel = document.querySelector("#difficultyLabel");
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
let lastTap = null;

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
  startNewGame(Number(sizeSelect.value), Number(difficultySlider.value));
});

difficultySlider.addEventListener("input", () => {
  updateDifficultyLabel(Number(difficultySlider.value));
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
    state = makeGame(8, 50);
    await saveState();
  }
  sizeSelect.value = String(state.size);
  difficultySlider.value = String(state.difficulty);
  updateDifficultyLabel(state.difficulty);
  render();
}

function startNewGame(size, difficulty) {
  state = makeGame(size, difficulty);
  render();
  scheduleSave();
}

function makeGame(size, difficulty) {
  const candidate = pickGeneratedLevel(size, difficulty);
  const seed = candidate.seed;
  const rng = mulberry32(seed);
  const solution = candidate.solution;
  const clues = solution.map((rect) => ({
    x: rect.x + Math.floor(rng() * rect.w),
    y: rect.y + Math.floor(rng() * rect.h),
    value: rect.w * rect.h
  }));
  return { size, difficulty, seed, clues, regions: [], history: [] };
}

function pickGeneratedLevel(size, difficulty) {
  const bias = Math.abs(difficulty - 50) / 50;
  const attempts = Math.max(10, Math.round(10 + bias * 18));
  let best = null;

  for (let index = 0; index < attempts; index += 1) {
    const seed = Math.floor(Math.random() * 2 ** 31);
    const solution = splitRect({ x: 0, y: 0, w: size, h: size }, mulberry32(seed), size, difficulty);
    const score = scoreSolution(solution, difficulty);
    if (!best || score < best.score) best = { seed, solution, score };
  }

  return best;
}

function scoreSolution(solution, difficulty) {
  const leftBias = Math.max(0, 50 - difficulty) / 50;
  const rightBias = Math.max(0, difficulty - 50) / 50;
  const size = Math.sqrt(solution.reduce((sum, rect) => sum + rect.w * rect.h, 0));
  const profile = generatorProfile(size, difficulty);
  const averageArea = solution.reduce((sum, rect) => sum + rect.w * rect.h, 0) / solution.length;
  const targetScore = Math.abs(averageArea - profile.targetArea) * 12;
  const smallScore = solution.reduce((score, rect) => {
    const area = rect.w * rect.h;
    if (area === 2) return score + 120;
    if (area === 3) return score + 42;
    if (area === 4) return score + 14;
    return score;
  }, 0);

  if (leftBias > 0) return -averageArea + smallScore * 0.08;
  if (rightBias > 0) return averageArea + smallScore * 0.22;
  return targetScore + smallScore;
}

function splitRect(rect, rng, size, difficulty) {
  const profile = generatorProfile(size, difficulty);
  const area = rect.w * rect.h;
  const verticalCuts = possibleCuts(rect.w, rect.h, size, profile.minArea);
  const horizontalCuts = possibleCuts(rect.h, rect.w, size, profile.minArea);
  const canVertical = verticalCuts.length > 0;
  const canHorizontal = horizontalCuts.length > 0;
  const stopChance = stopProbability(area, profile);

  if (area <= profile.maxArea && area >= profile.minArea && rng() < stopChance) return [rect];
  if (!canVertical && !canHorizontal) return [rect];

  const splitVertical = canVertical && (!canHorizontal || rng() < rect.w / (rect.w + rect.h));
  if (splitVertical) {
    const cut = pickCut(verticalCuts, rect.w, rect.h, profile, rng);
    return [
      ...splitRect({ x: rect.x, y: rect.y, w: cut, h: rect.h }, rng, size, difficulty),
      ...splitRect({ x: rect.x + cut, y: rect.y, w: rect.w - cut, h: rect.h }, rng, size, difficulty)
    ];
  }

  const cut = pickCut(horizontalCuts, rect.h, rect.w, profile, rng);
  return [
    ...splitRect({ x: rect.x, y: rect.y, w: rect.w, h: cut }, rng, size, difficulty),
    ...splitRect({ x: rect.x, y: rect.y + cut, w: rect.w, h: rect.h - cut }, rng, size, difficulty)
  ];
}

function render() {
  board.innerHTML = "";
  board.dataset.size = String(state.size);
  board.style.gridTemplateColumns = `repeat(${state.size}, var(--board-cell))`;
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
      cell.addEventListener("dblclick", onCellDoubleClick);
      board.append(cell);
    }
  }

  updateStatus();
}

function onPointerDown(event) {
  const point = pointFromCell(event.currentTarget);
  if (isDoubleTap(point)) {
    removeRegionAt(point);
    lastTap = null;
    return;
  }
  lastTap = { ...point, time: Date.now() };
  dragStart = point;
  dragEnd = point;
  board.setPointerCapture(event.pointerId);
  board.addEventListener("pointermove", onPointerMove);
  board.addEventListener("pointerup", onPointerUp, { once: true });
  render();
}

function onCellDoubleClick(event) {
  removeRegionAt(pointFromCell(event.currentTarget));
}

function isDoubleTap(point) {
  const now = Date.now();
  return Boolean(lastTap && lastTap.x === point.x && lastTap.y === point.y && now - lastTap.time < 320);
}

function removeRegionAt(point) {
  const index = state.regions.findIndex((region) => contains(region, point.x, point.y));
  if (index === -1) return;
  pushHistory();
  state.regions.splice(index, 1);
  dragStart = null;
  dragEnd = null;
  render();
  scheduleSave();
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
    difficulty: saved.difficulty ?? 50,
    seed: saved.seed,
    clues: saved.clues || [],
    regions: saved.regions || [],
    history: saved.history || []
  };
}

function pushHistory() {
  state.history.push(state.regions.map((region) => ({ ...region })));
}

function updateDifficultyLabel(value) {
  difficultyLabel.value = `${value}/100`;
}

function generatorProfile(size, difficulty) {
  const baseMaxArea = size <= 6 ? 8 : size <= 8 ? 12 : size <= 10 ? 16 : size <= 20 ? 28 : 36;
  const leftBias = Math.max(0, 50 - difficulty) / 50;
  const rightBias = Math.max(0, difficulty - 50) / 50;
  const targetArea = Math.max(3.5, baseMaxArea * (0.55 + leftBias * 1.9 - rightBias * 0.42));

  return {
    maxArea: Math.max(3, Math.round(baseMaxArea * (1 + leftBias * 4 - rightBias * 0.55))),
    minArea: 3 - rightBias,
    targetArea,
    stopBase: Math.max(0.08, Math.min(0.9, 0.24 + leftBias * 0.5 - rightBias * 0.12)),
    stopSlope: 0.42 + leftBias * 0.32 - rightBias * 0.22,
    edgeBias: 1 + rightBias * 1.7
  };
}

function stopProbability(area, profile) {
  const ratio = Math.min(1, Math.max(0, area / profile.maxArea));
  return Math.max(0.04, Math.min(0.94, profile.stopBase + profile.stopSlope * ratio));
}

function possibleCuts(length, otherSide, size, minArea) {
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
    const targetDistance = Math.abs(smallerArea - profile.targetArea) / profile.targetArea;
    const tinyPenalty = tinyAreaPenalty(leftArea) * tinyAreaPenalty(rightArea);
    const balance = Math.max(0.2, smallerArea / Math.max(leftArea, rightArea));
    return { cut, weight: tinyPenalty * balance * Math.exp(-targetDistance * profile.edgeBias) };
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
