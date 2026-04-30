const login = document.querySelector("#login");
const game = document.querySelector("#game");
const loginForm = document.querySelector("#loginForm");
const loginError = document.querySelector("#loginError");
const googleLogin = document.querySelector("#googleLogin");
const guestLogin = document.querySelector("#guestLogin");
const board = document.querySelector("#board");
const boardWrap = document.querySelector(".boardWrap");
const statusLine = document.querySelector("#status");
const sizeSelect = document.querySelector("#size");
const meanAreaSlider = document.querySelector("#meanArea");
const meanAreaLabel = document.querySelector("#meanAreaLabel");
const areaSpreadSlider = document.querySelector("#areaSpread");
const areaSpreadLabel = document.querySelector("#areaSpreadLabel");
const newGameButton = document.querySelector("#newGame");
const presetsContainer = document.querySelector("#presets");
const toggleAdvancedButton = document.querySelector("#toggleAdvanced");
const advancedPanel = document.querySelector("#advancedPanel");
const advancedSizes = document.querySelector("#advancedSizes");
const advancedCreateButton = document.querySelector("#advancedCreate");
const statsDialog = document.querySelector("#statsDialog");
const statsName = document.querySelector("#statsName");
const statsSuccess = document.querySelector("#statsSuccess");
const statsUnsuccessful = document.querySelector("#statsUnsuccessful");
const statsGrid = document.querySelector("#statsGrid");
const closeStatsButton = document.querySelector("#closeStats");
const solveButton = document.querySelector("#solve");
const undoButton = document.querySelector("#undo");
const clearButton = document.querySelector("#clear");
const logoutButton = document.querySelector("#logout");
const metaSize = document.querySelector("#metaSize");
const metaSeed = document.querySelector("#metaSeed");
const metaCovered = document.querySelector("#metaCovered");
const metaTime = document.querySelector("#metaTime");
const metaMode = document.querySelector("#metaMode");
const leaderboardTitle = document.querySelector("#leaderboardTitle");
const leaderboardList = document.querySelector("#leaderboard");

const palette = [
  "#cfeda1",
  "#dde7c7",
  "#bcece6",
  "#f4e7b1",
  "#ffd9bd",
  "#d7e3ff",
  "#e9ddff",
  "#c8f1ce",
  "#b8dfc1",
  "#e5e9d2",
  "#d0e8a6",
  "#c0e5d8",
  "#ffe0a6",
  "#f1d0bd",
  "#d9e7b8",
  "#ccead4"
];
const guestStorageKey = "shikaka:guest-state";
const tuningMax = 30;
const defaultTuning = { meanArea: 15, areaSpread: 15 };

let state = null;
let currentUser = null;
let isGuest = false;
let dragStart = null;
let dragEnd = null;
let saveTimer = null;
let lastTap = null;
let clockTimer = null;
let boardZoom = 1;
let boardGesture = null;
let advancedSelectedSize = 10;
const boardPointers = new Map();

boot();

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  loginError.textContent = "";
  const password = getControlValue(document.querySelector("#password"));
  const response = await api("/api/login", { method: "POST", body: { password } });
  if (!response.ok) {
    loginError.textContent = "Пароль не подошел";
    return;
  }
  await loadGame();
});

guestLogin.addEventListener("click", async () => {
  await loadGame({ guest: true });
});

newGameButton.addEventListener("click", async () => {
  await startNewGame(state.size, state.tuning);
});

presetsContainer.addEventListener("click", async (event) => {
  const button = event.target.closest("md-filled-tonal-button");
  if (!button || button.hasAttribute("selected")) return;

  const size = Number(button.dataset.size);
  const tuning = {
    meanArea: Number(button.dataset.mean),
    areaSpread: Number(button.dataset.spread)
  };

  updatePresetSelection(size, tuning);
  await startNewGame(size, tuning);
});

advancedSizes.addEventListener("click", (event) => {
  const button = event.target.closest("md-filled-tonal-button");
  if (!button) return;
  advancedSelectedSize = Number(button.dataset.size);
  updateAdvancedSizeSelection();
});

toggleAdvancedButton.addEventListener("click", () => {
  advancedPanel.classList.toggle("hidden");
  toggleAdvancedButton.classList.toggle("active");
  const isOpen = !advancedPanel.classList.contains("hidden");
  toggleAdvancedButton.setAttribute("aria-expanded", String(isOpen));
});

advancedCreateButton.addEventListener("click", async () => {
  const tuning = readTuning();
  const size = advancedSelectedSize;
  updatePresetSelection(null);
  advancedPanel.classList.add("hidden");
  toggleAdvancedButton.classList.remove("active");
  toggleAdvancedButton.setAttribute("aria-expanded", "false");
  await startNewGame(size, tuning);
});

closeStatsButton.addEventListener("click", () => {
  if (typeof statsDialog.close === "function") statsDialog.close();
  else statsDialog.removeAttribute("open");
});

meanAreaSlider.addEventListener("input", () => {
  updateTuningLabels();
});

areaSpreadSlider.addEventListener("input", () => {
  updateTuningLabels();
});

for (const slider of [meanAreaSlider, areaSpreadSlider]) {
  slider.addEventListener("pointerdown", (event) => {
    event.stopPropagation();
  });
}

board.addEventListener("pointermove", onBoardPointerMove);
board.addEventListener("pointerup", onBoardPointerEnd);
board.addEventListener("pointercancel", onBoardPointerEnd);

clearButton.addEventListener("click", () => {
  pushHistory();
  state.regions = [];
  render();
  scheduleSave();
});

solveButton.addEventListener("click", async () => {
  if (!state.solution) {
    const data = await api("/api/solution", {
      method: "POST",
      body: {
        size: state.size,
        seed: String(state.seed),
        meanArea: state.tuning.meanArea,
        areaSpread: state.tuning.areaSpread
      }
    });
    state.solution = data.solution || null;
    if (data.error === "unauthorized") {
      alert("Решение доступно после входа.");
      return;
    }
  }

  if (!state.solution) {
    alert("Для этого уровня решение не сохранено (старая версия игры). Попробуй новый уровень.");
    return;
  }
  pushHistory();
  state.regions = state.solution.map((rect) => ({ ...rect }));
  state.usedSolution = true;
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
  if (!isGuest) await api("/api/logout", { method: "POST" });
  stopClock();
  currentUser = null;
  isGuest = false;
  game.classList.add("hidden");
  login.classList.remove("hidden");
});

async function boot() {
  const me = await api("/api/me");
  googleLogin.classList.toggle("hidden", !me.googleConfigured);
  if (me.authenticated) {
    currentUser = me.user;
    await loadGame({ guest: false });
  } else {
    login.classList.remove("hidden");
  }
  await loadLeaderboard();
}

async function loadGame({ guest = false } = {}) {
  isGuest = guest;
  login.classList.add("hidden");
  game.classList.remove("hidden");

  if (isGuest) {
    const saved = loadGuestState();
    state = saved ? normalizeState(saved) : await makeGame(8, defaultTuning);
  } else {
    const saved = await api("/api/state");
    if (saved.state) {
      state = normalizeState(saved.state);
    } else {
      state = await makeGame(8, defaultTuning);
      await saveState();
    }
  }

  updatePresetSelection(state.size, state.tuning);
  setControlValue(meanAreaSlider, state.tuning.meanArea);
  setControlValue(areaSpreadSlider, state.tuning.areaSpread);
  advancedSelectedSize = state.size;
  updateAdvancedSizeSelection();
  updateTuningLabels();
  startClock();
  render();
  await loadLeaderboard();
}

function updatePresetSelection(size, tuning) {
  const buttons = presetsContainer.querySelectorAll("md-filled-tonal-button");
  buttons.forEach((btn) => {
    const isMatch = size && tuning &&
      Number(btn.dataset.size) === size &&
      Number(btn.dataset.mean) === tuning.meanArea &&
      Number(btn.dataset.spread) === tuning.areaSpread;
    if (isMatch) btn.setAttribute("selected", "");
    else btn.removeAttribute("selected");
  });
}

function updateAdvancedSizeSelection() {
  const buttons = advancedSizes.querySelectorAll("md-filled-tonal-button");
  buttons.forEach((btn) => {
    if (Number(btn.dataset.size) === advancedSelectedSize) btn.setAttribute("selected", "");
    else btn.removeAttribute("selected");
  });
}

async function startNewGame(size, tuning) {
  setControlDisabled(newGameButton, true);
  try {
    state = await makeGame(size, tuning);
  } finally {
    setControlDisabled(newGameButton, false);
  }
  render();
  scheduleSave();
  await loadLeaderboard();
}

async function makeGame(size, tuning) {
  const data = await api("/api/level", {
    method: "POST",
    body: { size, meanArea: tuning.meanArea, areaSpread: tuning.areaSpread }
  });
  if (!data.level) throw new Error("Level generation failed");
  const level = data.level;
  return {
    size: level.size,
    tuning: level.tuning,
    levelTuning: level.tuning,
    seed: level.seed,
    clues: level.clues,
    solution: null,
    regions: [],
    history: [],
    startedAt: Date.now(),
    solvedAt: null,
    usedSolution: false,
    scoreSubmitted: false
  };
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
  const verticalCuts = possibleCuts(rect.w, rect.h, size, profile.minArea);
  const horizontalCuts = possibleCuts(rect.h, rect.w, size, profile.minArea);
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

function render() {
  board.innerHTML = "";
  board.dataset.size = String(state.size);
  board.style.gridTemplateColumns = `repeat(${state.size}, var(--board-cell))`;
  applyBoardZoom();
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
        cell.classList.add("filled");
        cell.style.background = palette[regionIndex % palette.length];
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
  board.setPointerCapture(event.pointerId);
  boardPointers.set(event.pointerId, pointerPoint(event));
  if (boardPointers.size >= 2) {
    startBoardGesture();
    return;
  }
  if (boardGesture) return;
  const point = pointFromCell(event.currentTarget);
  if (isDoubleTap(point)) {
    removeRegionAt(point);
    lastTap = null;
    return;
  }
  lastTap = { ...point, time: Date.now() };
  dragStart = point;
  dragEnd = point;
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
  if (boardGesture) return;
  if (!dragStart) return;
  const cell = document.elementFromPoint(event.clientX, event.clientY)?.closest(".cell");
  if (!cell || !board.contains(cell)) return;
  dragEnd = pointFromCell(cell);
  render();
}

function onPointerUp() {
  board.removeEventListener("pointermove", onPointerMove);
  if (boardGesture) return;
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

function onBoardPointerMove(event) {
  if (!boardPointers.has(event.pointerId)) return;
  boardPointers.set(event.pointerId, pointerPoint(event));
  if (!boardGesture && boardPointers.size >= 2) startBoardGesture();
  if (!boardGesture) return;

  const pointers = activeBoardPointers();
  if (pointers.length < 2) return;
  event.preventDefault();
  const distance = pointerDistance(pointers);
  const midpoint = pointerMidpoint(pointers);
  const nextZoom = clamp(boardGesture.zoom * (distance / boardGesture.distance), 0.55, 2.2);
  const zoomRatio = nextZoom / boardZoom;
  boardZoom = nextZoom;
  applyBoardZoom();
  boardWrap.scrollLeft = boardGesture.scrollLeft * zoomRatio - (midpoint.x - boardGesture.midpoint.x);
  boardWrap.scrollTop = boardGesture.scrollTop * zoomRatio - (midpoint.y - boardGesture.midpoint.y);
}

function onBoardPointerEnd(event) {
  boardPointers.delete(event.pointerId);
  if (boardPointers.size < 2) boardGesture = null;
}

function applyBoardZoom() {
  board.style.zoom = String(boardZoom);
}

function startBoardGesture() {
  const pointers = activeBoardPointers();
  if (pointers.length < 2) return;
  dragStart = null;
  dragEnd = null;
  board.removeEventListener("pointermove", onPointerMove);
  render();
  boardGesture = {
    distance: pointerDistance(pointers),
    midpoint: pointerMidpoint(pointers),
    zoom: boardZoom,
    scrollLeft: boardWrap.scrollLeft,
    scrollTop: boardWrap.scrollTop
  };
}

function activeBoardPointers() {
  return [...boardPointers.values()];
}

function pointerPoint(event) {
  return { x: event.clientX, y: event.clientY };
}

function pointerDistance(pointers) {
  const [first, second] = pointers;
  return Math.hypot(first.x - second.x, first.y - second.y);
}

function pointerMidpoint(pointers) {
  const [first, second] = pointers;
  return {
    x: (first.x + second.x) / 2,
    y: (first.y + second.y) / 2
  };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
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
  if (solved && !state.solvedAt) {
    state.solvedAt = Date.now();
    scheduleSave();
  }
  if (solved) {
    submitScoreIfEligible();
  }

  metaSize.textContent = `${state.size} x ${state.size}`;
  metaSeed.textContent = state.seed;
  metaCovered.textContent = `${percent}%`;
  metaTime.textContent = formatElapsed(elapsedMs());
  metaMode.textContent = isGuest ? "Гость" : currentUser?.name || "Аккаунт";
  logoutButton.textContent = isGuest ? "Войти" : "Выйти";
  statusLine.textContent = solved ? solvedStatusText() : "Выдели все прямоугольники";
  statusLine.style.color = solved ? "var(--good)" : "var(--muted)";
  setControlDisabled(undoButton, state.history.length === 0);
}

function normalizeState(saved) {
  const sourceTuning = saved.tuning || {
    meanArea: saved.difficulty ?? defaultTuning.meanArea,
    areaSpread: defaultTuning.areaSpread
  };
  const tuning = normalizeTuning(sourceTuning);

  return {
    size: saved.size,
    tuning,
    levelTuning: normalizeLevelTuning(saved.levelTuning || sourceTuning, tuning),
    seed: saved.seed,
    clues: saved.clues || [],
    solution: saved.solution || null,
    regions: saved.regions || [],
    history: saved.history || [],
    startedAt: saved.startedAt || Date.now(),
    solvedAt: saved.solvedAt || null,
    usedSolution: Boolean(saved.usedSolution),
    scoreSubmitted: Boolean(saved.scoreSubmitted),
    scoreError: saved.scoreError || null,
    scoreSubmitting: false
  };
}

function pushHistory() {
  state.history.push(state.regions.map((region) => ({ ...region })));
}

function readTuning() {
  return {
    meanArea: Number(getControlValue(meanAreaSlider)),
    areaSpread: Number(getControlValue(areaSpreadSlider))
  };
}

function updateTuningLabels() {
  meanAreaLabel.value = getControlValue(meanAreaSlider);
  areaSpreadLabel.value = getControlValue(areaSpreadSlider);
}

function getControlValue(control) {
  return control?.value ?? "";
}

function setControlValue(control, value) {
  if (!control) return;
  control.value = String(value);
}

function setControlDisabled(control, disabled) {
  if (!control) return;
  control.disabled = disabled;
}

function generatorProfile(size, tuning) {
  const targetMedian = Math.max(3, tuning.meanArea);
  const spreadRatio = tuning.areaSpread / tuningMax;
  const targetIqr = spreadRatio === 0 ? 0 : Math.max(1, targetMedian * spreadRatio * 1.25);
  const meanRatio = targetMedian / tuningMax;

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

function normalizeTuning(tuning) {
  return {
    meanArea: normalizeTuningValue(tuning.meanArea, defaultTuning.meanArea),
    areaSpread: normalizeTuningValue(tuning.areaSpread, defaultTuning.areaSpread)
  };
}

function normalizeLevelTuning(levelTuning, displayTuning) {
  const meanArea = Number(levelTuning.meanArea);
  const areaSpread = Number(levelTuning.areaSpread);
  if (Number.isInteger(meanArea) && Number.isInteger(areaSpread)) {
    return { meanArea, areaSpread };
  }
  return displayTuning;
}

function normalizeTuningValue(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  const migrated = number > tuningMax ? Math.round((number / 100) * tuningMax) : number;
  return Math.max(0, Math.min(tuningMax, Math.round(migrated)));
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
  if (isGuest) {
    localStorage.setItem(guestStorageKey, JSON.stringify(state));
    return;
  }
  await api("/api/state", { method: "PUT", body: { state } });
}

function loadGuestState() {
  try {
    const raw = localStorage.getItem(guestStorageKey);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function startClock() {
  stopClock();
  clockTimer = setInterval(() => {
    if (!state) return;
    metaTime.textContent = formatElapsed(elapsedMs());
  }, 1000);
}

function stopClock() {
  if (clockTimer) clearInterval(clockTimer);
  clockTimer = null;
}

function elapsedMs() {
  if (!state) return 0;
  return Math.max(0, (state.solvedAt || Date.now()) - state.startedAt);
}

function formatElapsed(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function solvedStatusText() {
  if (state.usedSolution) return "Решение показано: результат не засчитан";
  if (isGuest) return "Готово: войди через Google, чтобы попасть в таблицу";
  if (state.scoreError) return scoreErrorText(state.scoreError);
  return state.scoreSubmitted ? "Готово: результат засчитан" : "Готово: отправляю результат";
}

async function submitScoreIfEligible() {
  if (isGuest || state.usedSolution || state.scoreSubmitted || state.scoreSubmitting || state.scoreError) return;
  state.scoreSubmitting = true;
  const scoreTuning = state.levelTuning || state.tuning;
  const response = await api("/api/score", {
    method: "POST",
    body: {
      size: state.size,
      seed: String(state.seed),
      meanArea: scoreTuning.meanArea,
      areaSpread: scoreTuning.areaSpread,
      elapsedMs: elapsedMs(),
      usedSolution: state.usedSolution,
      clues: state.clues,
      regions: state.regions
    }
  });
  state.scoreSubmitting = false;
  if (response.ok) {
    state.scoreSubmitted = true;
    state.scoreError = null;
    await saveState();
    await loadLeaderboard();
    render();
    return;
  }
  state.scoreError = response.error || "score_failed";
  await saveState();
  render();
}

function scoreErrorText(error) {
  if (error === "unknown_level") return "Готово: старый уровень не засчитывается, начни новый";
  if (error === "solution_revealed") return "Решение было открыто: результат не засчитан";
  if (error === "invalid_solution") return "Готово: сервер не принял решение";
  if (error === "unauthorized") return "Готово: войди через Google, чтобы попасть в таблицу";
  return "Готово: результат не отправился";
}

async function loadLeaderboard() {
  leaderboardTitle.textContent = "Турнирные таблицы";
  const data = await api("/api/leaderboard");
  const sizes = data.sizes || [6, 8, 10, 15, 20, 26];
  const groups = data.groups || {};
  leaderboardList.innerHTML = "";

  for (const size of sizes) {
    const section = document.createElement("section");
    section.className = "leaderboardGroup";
    const title = document.createElement("h4");
    title.textContent = `${size}x${size}`;
    const list = document.createElement("ol");
    const scores = groups[size] || [];

    if (scores.length === 0) {
      const item = document.createElement("li");
      item.className = "empty";
      item.textContent = "Пока пусто";
      list.append(item);
    } else {
      for (const score of scores) {
        const item = document.createElement("li");
        const name = document.createElement("span");
        name.textContent = score.display_name || "Player";
        const meta = document.createElement("small");
        meta.textContent = formatElapsed(score.elapsed_ms);
        item.append(name, meta);
        item.addEventListener("click", () => showUserStats(score.user_key));
        list.append(item);
      }
    }

    section.append(title, list);
    leaderboardList.append(section);
  }
}

async function showUserStats(userKey) {
  const data = await api(`/api/user-stats?userKey=${encodeURIComponent(userKey)}`);
  if (!data.name) return;

  statsName.textContent = `Статистика: ${data.name}`;
  statsSuccess.textContent = data.totalSuccess;
  statsUnsuccessful.textContent = data.totalUnsuccessful;

  statsGrid.innerHTML = `
    <div class="stats-row header">
      <span>Поле</span>
      <span>Лучшее</span>
      <span>Среднее</span>
    </div>
  `;

  for (const p of data.presets) {
    const row = document.createElement("div");
    row.className = "stats-row";
    row.innerHTML = `
      <span>${p.label}</span>
      <span>${p.best ? formatElapsed(p.best) : "—"}</span>
      <span>${p.average ? formatElapsed(p.average) : "—"}</span>
    `;
    statsGrid.append(row);
  }

  if (typeof statsDialog.show === "function") statsDialog.show();
  else statsDialog.setAttribute("open", "");
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
