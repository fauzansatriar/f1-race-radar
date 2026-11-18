"use strict";

const portraits = /*__PORTRAITS__*/ {};
const teamCars = /*__TEAM_CARS__*/ {};
let race = /*__RACE_CACHE__*/ {};
let catalog = /*__CATALOG__*/ [];
let seasonStandings = race.official.standings;
const recordings = new Map([[race.official.round, race]]);
const mediaCache = new WeakMap();
const $ = (id) => document.getElementById(id);
const missing = "—";
const speedButtons = [...$("replay-speed").querySelectorAll(".speed-option")];
const clamp = (value, min, max) => Math.max(min, Math.min(value, max));
const signed = (value, decimals = 0) => Number.isFinite(value)
  ? `${value >= 0 ? "+" : "−"}${Math.abs(value).toFixed(decimals)}`
  : missing;
const text = (id, value) => {
  const node = $(id);
  const next = String(value ?? missing);
  if (node.textContent !== next) node.textContent = next;
};
const fixed = (value, decimals, suffix = "") => Number.isFinite(value) ? value.toFixed(decimals) + suffix : missing;
const elapsed = (time) => new Date(time).toISOString().slice(11, 19);
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
const mobileLayout = matchMedia("(max-width: 670px), (max-width: 960px) and (max-height: 500px) and (pointer: coarse)");
const CONTINUOUS_CAR = [1, 2];
const LOCATION = [1, 2];
const INTERVAL = [1];
const overlayChannels = [
  { label: "SPEED", y: 7, height: 43, offset: 1, max: 350 },
  { label: "THROTTLE", y: 50, height: 47, offset: 2, max: 100 },
  { label: "BRAKE", y: 97, height: 39, offset: 3, max: 100 },
];
const state = {
  time: 0, replayRate: Number(speedButtons.find((button) => button.getAttribute("aria-pressed") === "true").dataset.speed), selected: null, timer: null, listKey: "", pairKey: "", classification: "results",
  battle: null, listSelection: null, power: [], traces: [],
  lastFrame: null, lastRender: 0, lastMedia: 0, lastTrace: 0, historyKey: "",
  laps: [], changedRace: false, raceRequest: null, mediaRequest: null, mediaTimer: null, shapeRequest: null,
};
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[char]);

function recentSample(series, time, freshness = 8000) {
  const sample = at(series, time);
  return sample && time - sample[0] <= freshness ? sample : null;
}

function mediaState(recording) {
  if (!mediaCache.has(recording)) mediaCache.set(recording, new Map());
  return mediaCache.get(recording);
}

function blockIndex(recording, time) {
  return Math.floor(Math.max(0, Math.min(time, recording.end - 1) - recording.start) / BLOCK_MS);
}

function mediaSamples(driver, channel) {
  if (race.live) return driver[channel];
  const index = blockIndex(race, state.time);
  const blocks = mediaState(race);
  const active = blocks.get(index)?.[channel]?.[driver.number];
  if (active?.length) return active;
  const prior = blocks.get(index - 1)?.[channel]?.[driver.number];
  if (prior?.length && prior.at(-1)[0] >= state.time - 3500) return prior;
  return driver[channel];
}

function fieldAt(time) {
  return Object.values(race.participants)
    .filter((driver) => driver.activeThrough === null || time <= driver.activeThrough)
    .map((driver) => ({ driver, position: at(driver.positions, time)?.[1] }))
    .filter(({ position }) => Number.isFinite(position))
    .sort((a, b) => a.position - b.position);
}

function battlesAt(field) {
  return field.slice(1).flatMap((entry, i) => {
    const ahead = field[i];
    if (entry.position !== ahead.position + 1) return [];
    return [{ a: ahead.driver, b: entry.driver, position: entry.position }];
  });
}

function battleGap({ a, b, position }, time) {
  const samePair = (past, next) => [past[0], next[0]].every((stamp) =>
    at(a.positions, stamp)?.[1] === position - 1 && at(b.positions, stamp)?.[1] === position);
  return interpolateSample(b.intervals, time, INTERVAL, 10000, 16000, samePair)?.[1];
}

function setDriverCard(key, driver) {
  const number = $(`${key}-number`);
  const photo = $(`${key}-photo`);
  const name = $(`${key}-name`);
  const portrait = portraits[driver.code] ?? driver.headshot;
  name.textContent = `#${driver.number} ${driver.code}`;
  name.title = driver.name;
  name.setAttribute("aria-label", `Number ${driver.number}, ${driver.name}`);
  number.textContent = driver.number;
  if (portrait) {
    photo.src = portrait;
    photo.hidden = false;
    number.hidden = true;
  } else {
    photo.hidden = true;
    number.hidden = false;
    photo.removeAttribute("src");
  }
}

function setPair({ a, b, position }) {
  text("battle-position", `P${position}`);
  text("battle-rank", `P${position}`);
  const key = a.number + ":" + b.number;
  if (key === state.pairKey) return;
  state.pairKey = key;
  for (const [letter, driver] of [["a", a], ["b", b]]) {
    document.body.style.setProperty(`--team-${letter}`, driver.color);
    setDriverCard(letter, driver);
  }
  $("radar-cars").setAttribute("aria-label", `Relative position of ${a.name} and ${b.name}`);
  $("radar-cars").innerHTML = car("a", a) + car("b", b);
  $("circuit-markers").innerHTML = marker("a", `#${a.number} ${escapeHtml(a.code)}`) + marker("b", `#${b.number} ${escapeHtml(b.code)}`);
  $("power-row").innerHTML = power(a) + power(b);
  state.power = [...$("power-row").children].map((node) => ({
    gauges: [...node.querySelectorAll(".gauge")].map(gaugeParts),
    cells: [...node.querySelectorAll(".power-cells i")],
  }));
  createOverlay(a, b);
  state.historyKey = "";
}

function updateBattleList(battles, selected) {
  const key = battles.map(({ a, b, position }) => [a.number, b.number, position].join(":")).join(",");
  const listChanged = key !== state.listKey;
  if (!listChanged && state.listSelection === selected.b.number) return;
  state.listSelection = selected.b.number;
  if (listChanged) {
    state.listKey = key;
    const list = $("battle-list");
    const scroll = list.scrollTop;
    const focused = document.activeElement?.dataset?.battle;
    list.innerHTML = battles.map(({ a, b, position }) => `
      <button class="battle" type="button" data-battle="${b.number}" aria-pressed="false"
        aria-label="P${position}, ${escapeHtml(a.name)} versus ${escapeHtml(b.name)}"
        style="--battle-a:${a.color};--battle-b:${b.color}">
        <span class="battle-position">P${position}</span><span class="battle-pair">
          <b class="name-a">${escapeHtml(a.code)}</b><small>VS</small><b class="name-b">${escapeHtml(b.code)}</b>
        </span>
      </button>`).join("");
    list.scrollTop = scroll;
    if (focused) [...list.children].find((row) => row.dataset.battle === focused)?.focus({ preventScroll: true });
  }
  const { a, b, position } = selected;
  const trigger = $("battle-select");
  trigger.value = b.number;
  trigger.disabled = false;
  text("battle-select-value", `P${position} · #${a.number} ${a.code} vs #${b.number} ${b.code}`);
  trigger.setAttribute("aria-label", `Choose a race battle. P${position}, ${a.name} versus ${b.name}`);
  [...$("battle-list").children].forEach((button, i) => {
    const { a, b } = battles[i];
    const active = b.number === selected.b.number;
    button.setAttribute("aria-pressed", String(active));
    const label = (driver) => active
      ? `<span class="race-number">#${driver.number}</span>${escapeHtml(driver.code)}`
      : escapeHtml(driver.code);
    button.querySelector(".name-a").innerHTML = label(a);
    button.querySelector(".name-b").innerHTML = label(b);
  });
}

function completedLaps(driver, time) {
  return driver.laps.filter((lap) => lap[2] > 0 && lap[0] + lap[2] * 1000 <= time);
}

function sameLaps(a, b, time) {
  const aLaps = completedLaps(a, time);
  const bLaps = new Map(completedLaps(b, time).map((lap) => [lap[1], lap]));
  return aLaps.flatMap((lap) => bLaps.has(lap[1]) ? [[lap, bLaps.get(lap[1])]] : []).slice(-5);
}

function pairGap(a, b, time) {
  const front = recentSample(a.intervals, time, 16000)?.[2];
  const back = recentSample(b.intervals, time, 16000)?.[2];
  return Number.isFinite(front) && Number.isFinite(back) && back >= front ? back - front : null;
}

function setBadges(a, b) {
  text("drs", a ? `GEAR ${a[4] ?? missing}` : "GEAR —");
  text("override", b ? `GEAR ${b[4] ?? missing}` : "GEAR —");
  $("drs").title = "Gear for the driver ahead";
  $("override").title = "Gear for the pursuing driver";
}

function updateMap(a, b, time) {
  for (const [key, driver] of [["a", a], ["b", b]]) {
    const pin = $(`marker-${key}`);
    const point = interpolateSample(mediaSamples(driver, "locations"), time, LOCATION, 3500, 8000);
    pin.style.display = point && race.shape ? "" : "none";
    if (!point || !race.shape) continue;
    const [x, y] = mapPoint(point, race.shape.transform);
    pin.style.transform = `translate(${x}px,${y}px)`;
    const offset = key === "a" && x > 79 || x > 338 ? -71 : 7;
    const vertical = y < 31 ? 6 : key === "a" ? -13 : -27;
    pin.querySelector("rect").setAttribute("x", offset);
    pin.querySelector("rect").setAttribute("y", vertical);
    pin.querySelector("text").setAttribute("x", offset + 5);
    pin.querySelector("text").setAttribute("y", vertical + 12);
  }
}

function syncClock() {
  const time = state.time;
  const lap = at(state.laps, time)?.[1] ?? 1;
  if (race.live) {
    text("lap", race.started ? lap : "—");
    text("lap-total", race.official.total ? "/" + race.official.total : "");
    $("replay-clock").dateTime = new Date(time).toISOString();
    text("replay-clock", race.started ? elapsed(time) + " UTC" : "");
    return;
  }
  const finished = time >= race.end;
  $("scrubber").value = finished ? $("scrubber").max : Math.floor((time - race.start) / 1000);
  $("scrubber").setAttribute("aria-valuetext", (finished ? "Finish" : "Lap " + lap) + " · " + elapsed(time) + " UTC");
  const lapTrigger = $("lap-select");
  const label = finished ? "Finish" : `Lap ${lap}`;
  lapTrigger.value = finished ? "finish" : String(lap);
  if ($("lap-select-value").textContent !== label) {
    text("lap-select-value", label);
    lapTrigger.setAttribute("aria-label", `Jump to a lap. Currently ${label}`);
  }
  $("replay-clock").dateTime = new Date(time).toISOString();
  text("replay-clock", finished ? "FINISH · " + elapsed(time) + " UTC" : elapsed(time) + " UTC");
  text("lap", lap);
}

function render() {
  const waiting = race.live && !race.started;
  document.querySelector(".dashboard").hidden = waiting;
  $("race-waiting").hidden = !waiting;
  syncClock();
  if (waiting) return;
  const time = state.time;
  const battles = battlesAt(fieldAt(time));
  const lap = at(state.laps, time)?.[1] ?? 1;
  const battle = battles.find(({ b }) => b.number === state.selected) ?? battles.find(({ position }) => position === 4) ?? battles[0];
  const hadBattle = state.battle;
  state.battle = battle ?? null;
  if (!battle) {
    if (!hadBattle && state.listKey === "empty") return;
    $("battle-list").innerHTML = '<p class="chart-empty">No adjacent drivers in this sample.</p>';
    $("battle-select").value = "";
    $("battle-select").disabled = true;
    text("battle-select-value", "No adjacent drivers");
    state.listKey = "empty";
    for (const id of ["gap", "distance", "closing", "traction", "a-speed", "b-speed", "speed-delta"]) text(id, missing);
    for (const id of ["overlay-plot", "history-plot", "probability-plot", "matrix-grid", "sector-deltas"]) $(id).innerHTML = '<p class="chart-empty">Timing unavailable</p>';
    for (const id of ["radar-cars", "circuit-markers", "power-row"]) $(id).replaceChildren();
    text("pace-winner", "Timing unavailable");
    state.pairKey = "";
    text("battle-position", missing);
    text("battle-rank", missing);
    setBadges(null, null);
    return;
  }
  if (state.selected === null) state.selected = battle.b.number;
  updateBattleList(battles, battle);
  setPair(battle);
  renderMotion(true);

  const { a, b } = battle;
  const gap = battleGap(battle, time);
  const history = state.laps.filter(([start, number]) => number < lap && start <= time).slice(-4)
    .map(([, number], i, previous) => [
      number, pairGap(a, b, (previous[i + 1]?.[0] ?? at(state.laps, time)[0]) - 1),
    ]);
  history.push([lap, Number.isFinite(gap) ? gap : null]);
  const valid = history.filter((point) => Number.isFinite(point[1]));
  const firstGap = valid[0], lastGap = valid.at(-1);
  const closing = valid.length > 1 ? (lastGap[1] - firstGap[1]) / (lastGap[0] - firstGap[0]) : null;
  text("closing", closing === null ? missing : signed(closing, 2) + "s / lap");
  if (!mobileLayout.matches) {
    $("history-plot").innerHTML = trendChart([history], [b.color], 197, 91, "Race gap in seconds");
    updatePowerHistory(a, b, time);
  }

  const same = sameLaps(a, b, time);
  const last = same.at(-1);
  const historyKey = `${last?.[0][1] ?? "no-lap"}:${mobileLayout.matches}`;
  if (historyKey === state.historyKey) return;
  state.historyKey = historyKey;
  const lapDelta = last ? last[1][2] - last[0][2] : null;
  text("traction", lapDelta === null ? missing : signed(lapDelta, 3) + "s");
  if (mobileLayout.matches) return;
  const paceSeries = [0, 1].map((i) => same.map((laps) => [laps[i][1], laps[i][2]]));
  text("pace-label", last ? `LAP ${last[0][1]} · LAP TIME` : "LAST COMPLETED LAP");
  text("pace-winner", !last ? "Lap times unavailable" : Math.abs(lapDelta) < .001 ? "Level on lap pace" :
    `${lapDelta <= 0 ? b.code : a.code} FASTER BY ${Math.abs(lapDelta).toFixed(3)}s`);
  $("probability-plot").innerHTML = trendChart(paceSeries, [a.color, b.color], 380, 130, "Lap time in seconds");
  $("matrix-grid").innerHTML = miniSectors(a, b, last);
  $("sector-deltas").innerHTML = sectorDeltas(last);
}

function renderMotion(drawChart = false) {
  const battle = state.battle;
  if (!battle) return;
  const { a, b } = battle;
  const time = state.time;
  const view = document.body.dataset.view;
  if (mobileLayout.matches && view !== "radar") {
    if (view === "circuit") updateMap(a, b, time);
    return;
  }
  const data = [mediaSamples(a, "telemetry"), mediaSamples(b, "telemetry")];
  const [aCar, bCar] = data.map((rows) => interpolateSample(rows, time, CONTINUOUS_CAR, 2500, 8000));
  const gap = battleGap(battle, time);
  const validGap = Number.isFinite(gap) && gap >= 0;
  const nowSpeed = bCar?.[1];
  text("gap", typeof gap === "string" ? gap : fixed(gap, 3, "s"));
  text("distance", validGap && Number.isFinite(nowSpeed) ? `≈ ${(gap * nowSpeed / 3.6).toFixed(1)} m` : missing);
  const separation = validGap ? 22 * gap / (gap + 2) : 11;
  const track = $("car-a").closest(".radar-track");
  track.style.setProperty("--car-a-x", (67 + separation * .62).toFixed(4));
  track.style.setProperty("--car-b-x", (35 - separation * .77).toFixed(4));

  setBadges(aCar, bCar);
  const aSpeed = Number.isFinite(aCar?.[1]) ? Math.round(aCar[1]) : null;
  const bSpeed = Number.isFinite(bCar?.[1]) ? Math.round(bCar[1]) : null;
  text("a-speed", aSpeed);
  text("b-speed", bSpeed);
  const speedDelta = aSpeed !== null && bSpeed !== null ? bSpeed - aSpeed : null;
  text("speed-delta", signed(speedDelta));
  const delta = $("speed-delta");
  delta.classList.toggle("bad", speedDelta < 0);
  delta.classList.toggle("good", speedDelta !== null && speedDelta >= 0);
  [aCar, bCar].forEach((frame, i) => {
    updateGauge(state.power[i].gauges[0], frame?.[2]);
    updateGauge(state.power[i].gauges[1], frame?.[3], true);
  });

  if (!mobileLayout.matches) {
    updateMap(a, b, time);
    if (drawChart && view === "radar") updateOverlay(data, time);
  }
}

function power(driver) {
  return `<div class="power" style="--power:${driver.color}">
    <div class="power-stripe"></div><div class="gauges">${gauge(driver.color, "THROTTLE")}${gauge("#ee6b81", "BRAKE")}</div>
    <div class="power-cells" aria-hidden="true">${"<i></i>".repeat(18)}</div>
  </div>`;
}

function updatePowerHistory(a, b, time) {
  [a, b].forEach((driver, index) => {
    const data = mediaSamples(driver, "telemetry");
    state.power[index].cells.forEach((node, i) => {
      const throttle = i < 9;
      const value = recentSample(data, time - (8 - i % 9) * 1500)?.[throttle ? 2 : 3];
      const tint = throttle ? driver.color : "#ee6b81";
      const paint = value > 0 ? `color-mix(in srgb, ${tint} ${Math.round(value)}%, #33343d)` : "#33343d";
      if (node.style.getPropertyValue("--cell") !== paint) node.style.setProperty("--cell", paint);
    });
  });
}

function createOverlay(a, b) {
  const left = 24, width = 373;
  const grid = Array.from({ length: 9 }, (_, i) => line(left + i * width / 8, 7, left + i * width / 8, 136)).join("");
  const rows = overlayChannels.map(({ label, y, height }) => {
    const middle = y + height / 2;
    return `${line(left, y, left + width, y)}${line(left, middle, left + width, middle)}
      <text class="plot-label" x="14" y="${middle}" text-anchor="middle" transform="rotate(-90 14 ${middle})" style="font-size:7px">${label}</text>
      ${[a.color, b.color].map((color) => `<path class="plot-line telemetry-trace" stroke="${color}" stroke-width="1.3"/>`).join("")}`;
  }).join("");
  $("overlay-plot").innerHTML = svg(401, 138, "OpenF1 speed, throttle and brake over the last 24 seconds", grid + rows + line(left, 136, left + width, 136));
  state.traces = [...$("overlay-plot").querySelectorAll(".telemetry-trace")];
}

function updateOverlay(data, time) {
  const cutoff = time - 24000;
  const startIndices = data.map((rows) => sampleIndex(rows, cutoff));
  overlayChannels.forEach(({ y, height, offset, max }, channel) => {
    const brake = offset === 3;
    const ys = (value) => (y + height * (1 - clamp(value / max, 0, 1))).toFixed(2);
    data.forEach((rows, driver) => {
      let path = "", previous = -Infinity, previousValue = null;
      const add = (stamp, value) => {
        if (!Number.isFinite(value) || previous === stamp) return;
        const x = (24 + (stamp - cutoff) * 373 / 24000).toFixed(2);
        const connect = stamp - previous <= 2400;
        if (brake && connect && value !== previousValue) path += `L${x},${ys(previousValue)}`;
        path += `${connect ? "L" : "M"}${x},${ys(value)}`;
        previous = stamp;
        previousValue = value;
      };
      const columns = brake ? [] : [offset];
      add(cutoff, interpolateSample(rows, cutoff, columns, 2500, 2100)?.[offset]);
      for (let i = startIndices[driver]; i < rows.length && rows[i][0] <= time; i++) {
        add(rows[i][0], rows[i][offset]);
      }
      add(time, interpolateSample(rows, time, columns, 2500, 2100)?.[offset]);
      state.traces[channel * 2 + driver].setAttribute("d", path);
    });
  });
}

function trendChart(series, colors, width, height, label) {
  const points = series.flat().filter((point) => Number.isFinite(point[1]));
  if (!points.length) return '<p class="chart-empty">No comparable timing in this window</p>';
  const values = points.map((point) => point[1]);
  const laps = [...new Set(series.flat().map((point) => point[0]))].sort((a, b) => a - b);
  const floor = Math.min(...values);
  const ceiling = Math.max(...values);
  const min = floor === ceiling ? floor - .1 : floor - (ceiling - floor) * .12;
  const max = floor === ceiling ? ceiling + .1 : ceiling + (ceiling - floor) * .12;
  const left = width > 200 ? 39 : 31, right = width - 15, top = 10, bottom = height - 17;
  const x = (lap) => left + (right - left) * (laps.length < 2 ? .5 : laps.indexOf(lap) / (laps.length - 1));
  const y = (value) => top + (bottom - top) * (max - value) / (max - min);
  const grid = Array.from({ length: 4 }, (_, i) => {
    const dy = top + (bottom - top) * i / 3;
    return `${line(left, dy, right, dy)}<text class="plot-label" style="font-size:8px" x="${left - 4}" y="${dy + 3}" text-anchor="end">${(max - (max - min) * i / 3).toFixed(2)}</text>`;
  }).join("");
  const xAxis = laps.map((lap) => `${line(x(lap), top, x(lap), bottom)}<text class="plot-label" style="font-size:8px" x="${x(lap)}" y="${height - 5}" text-anchor="middle">${lap}</text>`).join("");
  const graphs = series.map((sequence, i) => {
    const chunks = [[]];
    const markers = [];
    for (const [lap, value] of sequence) {
      if (!Number.isFinite(value)) {
        if (chunks.at(-1).length) chunks.push([]);
        continue;
      }
      chunks.at(-1).push([x(lap), y(value)]);
      markers.push(`<circle cx="${x(lap)}" cy="${y(value)}" r="3.1" fill="${colors[i]}"><title>Lap ${lap}: ${value.toFixed(3)} s</title></circle>`);
    }
    return chunks.filter((chunk) => chunk.length > 1).map((chunk) => polyline(chunk, colors[i], 1, 2)).join("") + markers.join("");
  }).join("");
  return svg(width, height, label, grid + xAxis + graphs);
}

function miniSectors(a, b, last) {
  const colors = { 2048: "#dfc641", 2049: "#53cf75", 2051: "#9d59c8", 2064: "#43abbc" };
  const headers = [a, b].map((driver) => `<span style="color:${driver.color}">${escapeHtml(driver.code)}</span>`).join("");
  const cells = [0, 1].map((index) => {
    const segments = last?.[index][4] ?? [];
    return `<div class="minis">${segments.map((value, n) =>
      `<i title="Segment ${n + 1}${value === null ? " · unavailable" : ""}" style="--sector:${colors[value] ?? "#373843"}"></i>`
    ).join("")}</div>`;
  }).join("");
  return headers + cells;
}

function sectorDeltas(last) {
  return [0, 1, 2].map((index) => {
    const a = last?.[0][3][index], b = last?.[1][3][index];
    const delta = Number.isFinite(a) && Number.isFinite(b) ? b - a : null;
    return `<div class="sector-delta"><small>S${index + 1}</small>
      <strong class="${delta < 0 ? "good" : "bad"}">${delta === null ? missing : signed(delta, 3) + "s"}</strong></div>`;
  }).join("");
}

function renderClassification() {
  const mode = state.classification;
  const standings = mode === "standings";
  text("classification-title", standings ? "2026 driver standings"
    : race.official.name + (race.live ? " race order" : " results"));
  for (const button of document.querySelectorAll("[data-classification]")) {
    button.setAttribute("aria-pressed", String(button.dataset.classification === mode));
  }
  $("class-head").innerHTML = `<tr><th scope="col">Pos</th><th scope="col">Driver</th><th scope="col" class="class-team-col">Team</th>
    <th scope="col">${standings ? "Wins" : race.live ? "Gap to leader" : "Time / status"}</th><th scope="col">Pts</th></tr>`;
  const entries = standings ? seasonStandings : race.official.results;
  $("class-body").innerHTML = entries.map((driver) => {
    const photo = portraits[driver.driver];
    return `<tr>
      <td>P${escapeHtml(driver.position)}</td>
      <td><div class="class-driver">${photo ? `<img src="${photo}" loading="lazy" alt="">` : "<i></i>"}
      <span><b>${escapeHtml(driver.name)}</b><small class="class-team">${escapeHtml(driver.team)}</small></span></div></td>
      <td class="class-team-col">${escapeHtml(driver.team)}</td>
      <td>${escapeHtml(standings ? driver.wins : driver.status)}</td>
      <td>${escapeHtml(driver.points)}</td>
    </tr>`;
  }).join("");
}

function raceLapTimes(recording) {
  if (recording.lapClock?.length) return recording.lapClock;
  const times = new Map([[1, recording.start]]);
  for (const driver of Object.values(recording.participants)) {
    for (const [start, number] of driver.laps) {
      if (number > 1 && number <= (recording.official.total ?? Infinity) && start > recording.start && start < recording.end) {
        times.set(number, Math.min(start, times.get(number) ?? Infinity));
      }
    }
  }
  // A correction in OpenF1's lap feed must not put a later lap before an earlier one.
  let previous = recording.start - 1;
  return [...times].sort(([a], [b]) => a - b).flatMap(([lap, time]) => {
    if (time <= previous) return [];
    previous = time;
    return [[time, lap]];
  });
}

function renderShape() {
  const points = race.shape?.points;
  $("circuit-route").setAttribute("d", points?.length ? "M" + points.map((point) => point.join(",")).join(" L") + " Z" : "");
  const finish = $("finish-marker");
  finish.toggleAttribute("hidden", !points?.length);
  if (points?.length) {
    finish.setAttribute("x", points[0][0] - 4);
    finish.setAttribute("y", points[0][1] - 5);
  }
}

function renderRace() {
  $("race-picker").close();
  state.battle = null;
  setPlayback(false);
  state.time = race.live ? liveEdge(race) : race.start;
  state.selected = null;
  state.listKey = "";
  state.pairKey = "";
  state.historyKey = "";
  state.laps = raceLapTimes(race);
  document.body.dataset.timing = race.live ? "live" : "replay";
  document.body.dataset.liveSource = race.live ? race.source ?? "" : "";
  $("live-indicator").hidden = !race.live;
  $("gp-select").value = race.live ? liveChoice(race) : race.official.round;
  document.title = "F1 Race Radar — " + race.official.shortName + " " + (race.official.year ?? SEASON);
  text("lap-total", race.live ? "" : "/" + race.official.total);
  text("race-waiting-title", race.official.name);
  text("circuit-title", (race.circuit || race.official.circuit) + " · GPS");
  if (!race.live) $("scrubber").max = Math.ceil((race.end - race.start) / 1000);
  if (!race.live) text("live-delay", "");
  renderShape();
  renderClassification();
  render();
  if (race.live) {
    mediaLabel("");
    refreshLiveClassification();
    return;
  }
  queueMedia();
  loadShape();
}

function setTime(time) {
  state.time = clamp(time, race.start, race.end);
  render();
  queueMedia();
}

function animateReplay(now) {
  const elapsed = state.lastFrame === null ? 0 : Math.min(now - state.lastFrame, 50);
  state.lastFrame = now;
  state.time = Math.min(state.time + elapsed * state.replayRate, race.end);
  const reachedEnd = state.time >= race.end;
  if (reachedEnd || now - state.lastRender >= 180) {
    state.lastRender = now;
    state.lastTrace = now;
    render();
  } else if (!reduceMotion.matches) {
    const drawChart = now - state.lastTrace >= 32;
    if (drawChart) state.lastTrace = now;
    renderMotion(drawChart);
  }
  if (now - state.lastMedia >= 240) {
    state.lastMedia = now;
    queueMedia();
  }
  if (reachedEnd) setPlayback(false);
  else state.timer = requestAnimationFrame(animateReplay);
}

function setPlayback(playing) {
  if (playing && race.live) return;
  if (state.timer !== null) cancelAnimationFrame(state.timer);
  state.timer = null;
  state.lastFrame = null;
  if (playing) {
    if (state.time >= race.end) setTime(race.start);
    state.lastRender = state.lastTrace = state.lastMedia = 0;
    state.timer = requestAnimationFrame(animateReplay);
  } else if (state.battle) {
    renderMotion(true);
  }
  $("replay").setAttribute("aria-pressed", String(playing));
  $("replay").setAttribute("aria-label", playing ? "Pause archived telemetry" : "Play archived telemetry");
  text("replay-text", playing ? "PAUSE" : "REPLAY");
  $("play-icon").setAttribute("d", playing ? "M2 2h3v8H2zm5 0h3v8H7z" : "M3 1.5v9L10 6Z");
}

function mediaLabel(message) {
  if ($("telemetry-status").textContent !== message) text("telemetry-status", message);
}

function queueMedia() {
  clearTimeout(state.mediaTimer);
  const index = blockIndex(race, state.time);
  const pendingIndex = state.mediaRequest?.index;
  const next = index + 1;
  const nearBoundary = race.start + next * BLOCK_MS - state.time < 48_000;
  const prefetch = state.timer && nearBoundary && race.start + next * BLOCK_MS < race.end;
  const stillNeeded = pendingIndex === index || prefetch && pendingIndex === next;
  if (state.mediaRequest && (state.mediaRequest.recording !== race || !stillNeeded)) {
    state.mediaRequest.controller.abort();
    state.mediaRequest = null;
  }
  const available = mediaState(race).get(index);
  if (race.embeddedBlocks.includes(index) || available?.telemetry && available?.locations) {
    mediaLabel("");
    if (prefetch && !state.mediaRequest && !race.embeddedBlocks.includes(next) && !mediaState(race).has(next)) {
      state.mediaTimer = setTimeout(() => loadMedia(race, next), 150);
    }
    return;
  }
  if (available) {
    mediaLabel(!available.telemetry && !available.locations ? "Timing only · telemetry unavailable" : "Some telemetry unavailable");
    return;
  }
  mediaLabel("Loading telemetry…");
  if (!state.mediaRequest) {
    state.mediaTimer = setTimeout(() => loadMedia(race, index), 150);
  }
}

async function loadMedia(recording, index) {
  const controller = new AbortController();
  const task = { controller, recording, index };
  state.mediaRequest = task;
  try {
    const block = await fetchBlock(recording, index, controller.signal);
    if (controller.signal.aborted) return;
    const cache = mediaState(recording);
    cache.set(index, block);
    if (cache.size > 12) cache.delete(cache.keys().next().value);
    if (race === recording && index === blockIndex(race, state.time)) render();
  } catch {
    if (!controller.signal.aborted) mediaState(recording).set(index, { telemetry: null, locations: null });
  } finally {
    if (state.mediaRequest === task) {
      state.mediaRequest = null;
      queueMedia();
    }
  }
}

async function loadShape() {
  if (race.shape) return;
  const recording = race;
  const controller = new AbortController();
  state.shapeRequest = controller;
  try {
    recording.shape = await fetchShape(recording, controller.signal);
    if (race === recording && !controller.signal.aborted) {
      renderShape();
      render();
    }
  } catch {
    // The circuit map is optional when OpenF1 has no location samples.
  } finally {
    if (state.shapeRequest === controller) state.shapeRequest = null;
  }
}

function selectBattle(number) {
  if (!Number.isFinite(number)) return;
  state.selected = number;
  render();
}

function renderCatalog() {
  const picker = $("gp-select");
  const selected = picker.value;
  const options = catalog.map((entry) =>
    new Option(`R${entry.round} · ${entry.name.replace(" Grand Prix", " GP")}`, entry.round),
  );
  const upcoming = new Map(scheduledRaces);
  if (liveFeed.recording) upcoming.set(liveFeed.recording.session, liveFeed.recording);
  if (race.live && !upcoming.has(race.session)) upcoming.set(race.session, race);
  const sessions = [...upcoming.values()].sort((a, b) =>
    Number(b === liveFeed.recording) - Number(a === liveFeed.recording) || a.scheduled - b.scheduled);
  options.unshift(...sessions.map((available) => {
    const label = { upcoming: "Upcoming", live: "Live", finished: "Finished" }[livePhase(available)];
    return new Option(`${label} · ${available.official.shortName}`, liveChoice(available));
  }));
  const current = race.live ? liveChoice(race) : race.official.round;
  picker.replaceChildren(...options);
  picker.value = state.raceRequest && options.some((option) => option.value === selected) ? selected : current;
}

async function selectGP(round) {
  if (round.startsWith("session:")) {
    const key = Number(round.slice(8));
    if (liveFeed.recording?.session === key) viewLive(liveFeed.recording);
    else viewLive(scheduledRaces.get(key));
    return;
  }
  const entry = catalog.find((item) => item.round === round);
  if (!entry) return;
  state.raceRequest?.abort();
  if (round === race.official.round) {
    state.raceRequest = null;
    document.querySelector(".dashboard").removeAttribute("aria-busy");
    text("source-status", "");
    return;
  }
  const controller = new AbortController();
  state.raceRequest = controller;
  setPlayback(false);
  $("gp-select").value = round;
  document.querySelector(".dashboard").setAttribute("aria-busy", "true");
  text("source-status", `Loading ${entry.name}…`);
  try {
    let recording = recordings.get(round);
    if (!recording) {
      if (!entry.session) throw new Error("OpenF1 race session unavailable.");
      const results = await requestJSON(JOLPICA + round + "/results/?limit=100", controller.signal);
      const official = readOfficial(results);
      recording = await fetchRace(entry.session, official, controller.signal);
      recordings.set(round, recording);
    }
    controller.signal.throwIfAborted();
    state.shapeRequest?.abort();
    stopLiveClock();
    race = recording;
    renderCatalog();
    renderRace();
    text("source-status", "");
  } catch {
    if (!controller.signal.aborted) {
      $("gp-select").value = race.live ? liveChoice(race) : race.official.round;
      text("source-status", `Couldn't load round ${round}. Select it to retry.`);
    }
  } finally {
    if (state.raceRequest === controller) {
      state.raceRequest = null;
      document.querySelector(".dashboard").removeAttribute("aria-busy");
    }
  }
}

async function syncRace() {
  const button = $("sync-race");
  if (button.disabled || !navigator.onLine) return;
  button.disabled = true;
  if (!race.live) {
    if (!state.raceRequest) text("source-status", "Refreshing race data…");
    const activeIndex = blockIndex(race, state.time);
    const data = mediaState(race).get(activeIndex);
    if (data && (!data.telemetry || !data.locations)) {
      mediaState(race).delete(activeIndex);
      queueMedia();
    }
  }
  try {
    const selected = race;
    const [results, standings, sessions, classification, meetings] = await Promise.allSettled([
      requestJSON(JOLPICA + "results/1/?limit=100"),
      requestJSON(JOLPICA + "driverstandings/?limit=100"),
      fetchOpen("sessions", `year=${SEASON}&session_name=Race`),
      selected.live ? null : requestJSON(JOLPICA + selected.official.round + "/results/?limit=100"),
      fetchOpen("meetings", `year=${SEASON}`),
    ]);
    if (sessions.status === "fulfilled") {
      refreshSchedule(sessions.value, meetings.status === "fulfilled" ? meetings.value : []);
      renderCatalog();
    }
    if (classification.status === "fulfilled" && classification.value) {
      selected.official.results = readOfficial(classification.value).results;
      if (race === selected) renderClassification();
    }
    if (standings.status === "fulfilled") {
      const updatedStandings = readStandings(standings.value);
      if (updatedStandings.length) seasonStandings = updatedStandings;
      renderClassification();
    }
    if (results.status === "fulfilled") {
      const updated = readCatalog(results.value, sessions.status === "fulfilled" ? sessions.value : []);
      // Keep known completed rounds in case an upstream result disappears temporarily.
      const grouped = new Map(catalog.map((entry) => [entry.round, entry]));
      for (const entry of updated) {
        const previous = grouped.get(entry.round);
        grouped.set(entry.round, { ...entry, session: entry.session ?? previous?.session ?? null });
      }
      catalog = [...grouped.values()].sort((a, b) => Number(b.round) - Number(a.round));
      renderCatalog();
      if (!race.live && !state.changedRace && !state.raceRequest && state.timer === null &&
          catalog[0].round !== race.official.round && catalog[0].session) {
        await selectGP(catalog[0].round);
      } else if (!race.live && !state.raceRequest) text("source-status", "");
    } else if (!race.live && !state.raceRequest) {
      text("source-status", "Saved race list · API refresh unavailable");
    }
  } catch {
    if (!race.live && !state.raceRequest) text("source-status", "Saved race list · API refresh unavailable");
  } finally {
    button.disabled = false;
  }
}

$("battle-list").addEventListener("click", (event) => {
  const row = event.target.closest("[data-battle]");
  if (row) selectBattle(Number(row.dataset.battle));
});
$("battle-select").addEventListener("change", (event) => selectBattle(Number(event.target.value)));
$("replay").addEventListener("click", () => setPlayback(state.timer === null));
$("replay-speed").addEventListener("click", (event) => {
  const selected = event.target.closest(".speed-option");
  if (!selected) return;
  state.replayRate = Number(selected.dataset.speed);
  for (const button of speedButtons) {
    button.setAttribute("aria-pressed", String(button === selected));
  }
});
$("scrubber").addEventListener("input", (event) => {
  setPlayback(false);
  setTime(race.start + Number(event.target.value) * 1000);
});
$("lap-select").addEventListener("change", (event) => {
  const value = event.target.value;
  const target = value === "finish" ? race.end : state.laps.find(([, lap]) => lap === Number(value))?.[0];
  if (!Number.isFinite(target)) return;
  setPlayback(false);
  setTime(target);
});
$("gp-select").addEventListener("change", (event) => {
  state.changedRace = true;
  void selectGP(event.target.value);
});
$("classification").addEventListener("click", (event) => {
  const button = event.target.closest("[data-classification]");
  if (!button) return;
  state.classification = button.dataset.classification;
  if (race.live && state.classification !== "standings") refreshLiveClassification();
  else renderClassification();
});
$("sync-race").addEventListener("click", syncRace);
function layoutReplayControls() {
  const dock = $("mobile-replay");
  const session = $("replay-session");
  const speeds = $("replay-speed");
  const refresh = $("sync-race");
  const focused = document.activeElement;
  if (mobileLayout.matches && session.parentElement !== dock) {
    dock.append(session, speeds);
    $("mobile-menu").append(refresh);
  } else if (!mobileLayout.matches && session.parentElement === dock) {
    const gp = $("gp-select").closest(".gp-picker");
    gp.before(session, speeds);
    dock.parentElement.append(refresh);
    $("mobile-more").open = false;
  }
  if (focused instanceof HTMLElement && focused !== document.body && document.activeElement === document.body) focused.focus({ preventScroll: true });
}

const moreViews = $("mobile-more");
moreViews.addEventListener("click", (event) => {
  if (event.target.closest("a, button")) moreViews.open = false;
});
document.addEventListener("click", (event) => {
  if (moreViews.open && !moreViews.contains(event.target)) moreViews.open = false;
});
moreViews.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || !moreViews.open) return;
  moreViews.open = false;
  moreViews.querySelector("summary").focus();
});
window.addEventListener("hashchange", () => {
  $("race-picker").close();
  updateView();
  renderMotion(true);
  if (document.body.dataset.view === "data") refreshLiveClassification();
  if (mobileLayout.matches) window.scrollTo(0, 0);
});
mobileLayout.addEventListener("change", () => { layoutReplayControls(); render(); });
layoutReplayControls();
initializeRacePickers();
document.addEventListener("visibilitychange", () => {
  state.lastFrame = null;
  if (document.hidden) stopLiveClock();
  else {
    startLiveClock();
    void connectLive();
  }
});
window.addEventListener("online", () => {
  void connectLive();
  void syncRace();
});
setInterval(() => {
  if (document.hidden) return;
  void connectLive();
  void syncRace();
}, 240_000);
$("distance").title = "Estimated from interval × chasing car speed";

$("matrix-grid").classList.add("duel-sectors");
renderCatalog();
renderRace();
updateView();
void syncRace();
void connectLive();
