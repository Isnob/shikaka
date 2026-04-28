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
const solveButton = document.querySelector("#solve");
const undoButton = document.querySelector("#undo");
const clearButton = document.querySelector("#clear");
const logoutButton = document.querySelector("#logout");
const metaSize = document.querySelector("#metaSize");
const metaSeed = document.querySelector("#metaSeed");
const metaCovered = document.querySelector("#metaCovered");
const metaTime = document.querySelector("#metaTime");
const metaMode = document.querySelector("#metaMode");
const leaderboardList = document.querySelector("#leaderboard");

const palette = ["#f7c6bd", "#f2d377", "#9fd8cb", "#a8c8f2", "#d7b6e8", "#b8d98b", "#f4b06a", "#b7c4d8"];
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
const boardPointers = new Map();

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

guestLogin.addEventListener("click", async () => {
  await loadGame({ guest: true });
});

newGameButton.addEventListener("click", async () => {
  await startNewGame(Number(sizeSelect.value), readTuning());
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

  sizeSelect.value = String(state.size);
  meanAreaSlider.value = String(state.tuning.meanArea);
  areaSpreadSlider.value = String(state.tuning.areaSpread);
  updateTuningLabels();
  startClock();
  render();
}

async function startNewGame(size, tuning) {
  newGameButton.disabled = true;
  try {
    state = await makeGame(size, tuning);
  } finally {
    newGameButton.disabled = false;
  }
  render();
  scheduleSave();
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
  const attempts = 36;
  let best = null;

  for (let index = 0; index < attempts; index += 1) {
    const seed = Math.floor(Math.random() * 2 ** 31);
    const solution = splitRect({ x: 0, y: 0, w: size, h: size }, mulberry32(seed), size, tuning);
    const score = scoreSolution(solution, tuning);
    if (!best || score < best.score) best = { seed, solution, score };
  }

  return best;
}

function scoreSolution(solution, tuning) {
  const size = Math.sqrt(solution.reduce((sum, rect) => sum + rect.w * rect.h, 0));
  const profile = generatorProfile(size, tuning);
  const stats = areaStats(solution);
  const meanError = Math.abs(stats.mean - profile.targetMean) / profile.targetMean;
  const spreadError = Math.abs(stats.stdev - profile.targetStdev) / Math.max(1, profile.targetStdev);
  const duplicatePenalty = histogramConcentration(stats.counts, solution.length);
  const tinyPenalty = (stats.counts.get(2) || 0) / solution.length;

  return meanError * 90 + spreadError * 55 + duplicatePenalty * 80 + tinyPenalty * 24;
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
  undoButton.disabled = state.history.length === 0;
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
    meanArea: Number(meanAreaSlider.value),
    areaSpread: Number(areaSpreadSlider.value)
  };
}

function updateTuningLabels() {
  meanAreaLabel.value = meanAreaSlider.value;
  areaSpreadLabel.value = areaSpreadSlider.value;
}

function generatorProfile(size, tuning) {
  const baseMaxArea = size <= 6 ? 8 : size <= 8 ? 12 : size <= 10 ? 16 : size <= 20 ? 28 : 36;
  const meanRatio = tuning.meanArea / tuningMax;
  const spreadRatio = tuning.areaSpread / tuningMax;
  const targetMean = 3 + baseMaxArea * (0.22 + meanRatio * 1.75);
  const targetStdev = 1.2 + targetMean * (0.12 + spreadRatio * 0.95);

  return {
    maxArea: Math.max(4, Math.round(targetMean + targetStdev * 2.3)),
    minArea: targetMean < 5 ? 2 : 3,
    targetMean,
    targetStdev,
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
  const aspectPenalty = aspect > 2.2 ? 0.05 : 1.0;
  return Math.max(0.04, Math.min(0.94, (profile.stopBase + profile.stopSlope * ratio) * aspectPenalty));
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
    const targetDistance = Math.abs(smallerArea - profile.targetMean) / profile.targetStdev;
    const tinyPenalty = tinyAreaPenalty(leftArea) * tinyAreaPenalty(rightArea);
    const balance = Math.max(0.2, smallerArea / Math.max(leftArea, rightArea));

    const leftAspect = Math.max(cut / otherSide, otherSide / cut);
    const rightAspect = Math.max((length - cut) / otherSide, otherSide / (length - cut));
    const shapeBonus = Math.exp(-(leftAspect + rightAspect) * 0.4);

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

function areaStats(solution) {
  const areas = solution.map((rect) => rect.w * rect.h);
  const mean = areas.reduce((sum, area) => sum + area, 0) / areas.length;
  const variance = areas.reduce((sum, area) => sum + (area - mean) ** 2, 0) / areas.length;
  const counts = new Map();
  for (const area of areas) counts.set(area, (counts.get(area) || 0) + 1);
  return { mean, stdev: Math.sqrt(variance), counts };
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
  const data = await api("/api/leaderboard");
  const scores = data.scores || [];
  leaderboardList.innerHTML = "";
  if (scores.length === 0) {
    const item = document.createElement("li");
    item.textContent = "Пока пусто";
    leaderboardList.append(item);
    return;
  }
  for (const score of scores) {
    const item = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = score.display_name || "Player";
    const meta = document.createElement("small");
    meta.textContent = `${score.size}x${score.size}, ${formatElapsed(score.elapsed_ms)}`;
    item.append(name, meta);
    leaderboardList.append(item);
  }
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
