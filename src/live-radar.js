"use strict";

const LIVE_BUFFER_MS = 2300;
const LIVE_STALE_MS = 12_000;
const scheduledRaces = new Map();
const liveFeed = {
  recording: null, connected: false, source: null, mode: null, frame: null, lastFrame: null,
  lastRender: -Infinity, lastChart: -Infinity, lastStatus: -Infinity,
};

function newLiveRace(session) {
  const circuit = session.circuit_short_name || session.location || "";
  const country = session.country_name || circuit;
  const name = session.meeting_name || (country ? country + " Grand Prix" : "Grand Prix");
  const scheduled = Date.parse(session.date_start);
  return {
    live: true, session: session.session_key, circuit, scheduled, start: scheduled, end: Infinity,
    started: false, firstLap: Infinity, green: null, finished: null, latest: null, receivedAt: 0,
    shape: null, nextShapeCheck: 0, participants: {}, embeddedBlocks: [], lapClock: [],
    official: { round: "live", year: session.year, name, shortName: name.replace(" Grand Prix", " GP"),
      total: null, circuit, results: [] },
  };
}

function liveDriver(recording, number) {
  return recording.participants[number] ??= {
    number, activeThrough: null, ...driverIdentity({ driver_number: number }),
    laps: [], positions: [], intervals: [], telemetry: [], locations: [],
  };
}

function addLiveSample(samples, point) {
  const index = sampleIndex(samples, point[0]);
  if (samples[index - 1]?.[0] === point[0]) samples[index - 1] = point;
  else samples.splice(index, 0, point);
}

function mergeLiveRows(recording, rows) {
  for (const row of rows.drivers ?? []) {
    if (!Number.isFinite(row.driver_number)) continue;
    const driver = liveDriver(recording, row.driver_number);
    Object.assign(driver, driverIdentity(row));
  }
  for (const row of rows.laps ?? []) {
    if (!Number.isFinite(row.driver_number) || !Number.isFinite(row.lap_number)) continue;
    const laps = liveDriver(recording, row.driver_number).laps;
    const index = laps.findIndex((lap) => lap[1] === row.lap_number);
    const start = row.date_start ? Date.parse(row.date_start) : laps[index]?.[0];
    if (!Number.isFinite(start)) continue;
    if (index >= 0) laps.splice(index, 1);
    addLiveSample(laps, lapSample(row, start));
    if (row.lap_number === 1 && start >= recording.scheduled - 60_000) {
      recording.firstLap = Math.min(recording.firstLap, start);
    }
  }
  for (const event of rows.race_control ?? []) {
    const time = Date.parse(event.date);
    if (!Number.isFinite(time) || time < recording.scheduled - 60_000) continue;
    if (/^RACE START$/i.test(event.message ?? "")) recording.green ??= time;
    if (event.flag === "CHEQUERED") recording.finished = Math.min(recording.finished ?? Infinity, time);
  }
  const channels = [
    ["position", "positions", (row) => [row.position]],
    ["intervals", "intervals", (row) => [row.interval, row.gap_to_leader]],
    ["car_data", "telemetry", telemetryFields],
    ["location", "locations", locationFields],
  ];
  let latest = recording.latest ?? -Infinity;
  const now = Date.now();
  for (const [topic, field, fields] of channels) {
    for (const row of rows[topic] ?? []) {
      const time = Date.parse(row.date);
      if (!Number.isFinite(row.driver_number) || !Number.isFinite(time) || time > now + 5000) continue;
      const sample = fields(row);
      if (topic === "position" && !Number.isFinite(sample[0])) continue;
      addLiveSample(liveDriver(recording, row.driver_number)[field], [time, ...sample]);
      // Use transponder and vehicle timestamps to advance the shared clock.
      if (topic !== "position") latest = Math.max(latest, time);
    }
  }
  if (Number.isFinite(latest)) {
    if (latest > (recording.latest ?? -Infinity)) recording.receivedAt = now;
    recording.latest = latest;
    for (const driver of Object.values(recording.participants)) {
      for (const [field, age] of [["telemetry", 250_000], ["locations", 250_000], ["intervals", 900_000]]) {
        const series = driver[field];
        series.splice(0, sampleIndex(series, latest - age));
      }
    }
  }
  const start = recording.green ?? recording.firstLap;
  if (Number.isFinite(start) && (recording.latest ?? -Infinity) >= start) {
    recording.start = start;
    recording.started = true;
  }
  if (!recording.shape && latest >= recording.nextShapeCheck) {
    recording.nextShapeCheck = latest + 10_000;
    for (const driver of Object.values(recording.participants)) {
      const lap = driver.laps.findLast(([time, number, duration, , , pitOut]) =>
        number >= 2 && time >= latest - 250_000 && duration >= 30 && duration <= 200 &&
        !pitOut && time + duration * 1000 <= latest);
      recording.shape = lap ? circuitShape(driver.locations, lap[0], lap[2]) : null;
      if (recording.shape) break;
    }
  }
}

function livePhase(recording) {
  if (!recording) return "";
  if (recording.finished !== null) return "finished";
  return recording.started ? "live" : "upcoming";
}

function liveChoice(recording) {
  return `session:${recording.session}`;
}

function refreshSchedule(sessions, meetings) {
  const names = new Map(meetings.map((meeting) => [meeting.meeting_key, meeting.meeting_name]));
  const scheduled = sessions
    .filter((session) => session.session_name === "Race" && !session.is_cancelled &&
      Date.parse(session.date_start) > Date.now())
    .sort((a, b) => Date.parse(a.date_start) - Date.parse(b.date_start));
  const previous = new Map(scheduledRaces);
  scheduledRaces.clear();
  for (const session of scheduled) {
    const recording = liveFeed.recording?.session === session.session_key ? liveFeed.recording
      : newLiveRace({ ...session, meeting_name: names.get(session.meeting_key) });
    const saved = previous.get(session.session_key);
    if (saved === race && !saved.started && recording !== liveFeed.recording) {
      // Keep the chosen race mounted when its scheduled time or name is corrected.
      Object.assign(saved, recording);
      text("race-waiting-title", saved.official.name);
      refreshLiveStatus();
      scheduledRaces.set(session.session_key, saved);
      continue;
    }
    scheduledRaces.set(session.session_key, recording);
  }
}

function liveEdge(recording) {
  if (!recording.started) return recording.start;
  const latest = recording.finished === null
    ? Math.max(recording.start, recording.latest - LIVE_BUFFER_MS)
    : Math.min(recording.finished, recording.latest);
  return latest;
}

function liveStatus(recording) {
  const phase = livePhase(recording);
  if (phase === "finished") return ["FINISHED", "Chequered flag", ""];
  const now = Date.now();
  if (phase === "upcoming") {
    const scheduled = new Date(recording.scheduled).toISOString().slice(0, 16).replace("T", " ");
    return ["UPCOMING", now < recording.scheduled ? `Scheduled ${scheduled} UTC` : "Waiting for race start", ""];
  }
  if (!navigator.onLine || !liveFeed.connected) return ["RECONNECTING", "Waiting for timing updates", ""];
  const delay = Math.max(0, Math.round((now - state.time) / 1000));
  return [now - recording.receivedAt > LIVE_STALE_MS ? "DELAYED" : "LIVE", "", `${delay}s behind`];
}

function refreshLiveStatus() {
  if (!race.live) return;
  const [label, message, delay] = liveStatus(race);
  $("live-indicator").dataset.status = label.toLowerCase();
  text("live-label", label);
  text("source-status", message);
  text("live-delay", delay);
  mediaLabel(race.started && race.source === "public" ? "Timing only · sensor and GPS data unavailable" : "");
  text("race-waiting-note", race.finished !== null ? "The race has ended. Select its replay when the archive is available."
    : "Radar opens when the live timing feed starts sending race data.");
}

function refreshLiveClassification() {
  if (!race.live || state.classification === "standings") return;
  race.official.results = fieldAt(state.time).map(({ driver, position }) => {
    const gap = recentSample(driver.intervals, state.time, 25_000)?.[2];
    return { position, driver: driver.code, name: driver.name, team: driver.team,
      status: position === 1 ? "Leader" : typeof gap === "string" ? gap : fixed(gap, 3, "s"), points: "—" };
  });
  renderClassification();
}

function animateLive(now) {
  liveFeed.frame = null;
  if (!race.live || document.hidden) return;
  const before = state.time;
  const target = liveEdge(race);
  const step = liveFeed.lastFrame === null ? 0 : Math.min(now - liveFeed.lastFrame, 50);
  liveFeed.lastFrame = now;
  const available = race.finished ?? race.latest ?? race.start;
  if (target - before > 15_000 || before < race.start) state.time = target;
  else if (target > before) {
    const rate = clamp(1 + (target - before - 500) / 6000, 0.92, 1.2);
    state.time = Math.min(before + step * rate, target, available);
  }
  if (now - liveFeed.lastRender >= 180 && state.time !== before) {
    liveFeed.lastRender = liveFeed.lastChart = now;
    render();
  } else if (!reduceMotion.matches && state.time !== before) {
    const drawChart = now - liveFeed.lastChart >= 32;
    if (drawChart) liveFeed.lastChart = now;
    renderMotion(drawChart);
  }
  if (now - liveFeed.lastStatus >= 1000) {
    liveFeed.lastStatus = now;
    refreshLiveStatus();
    if (document.body.dataset.view === "data") refreshLiveClassification();
  }
  if (race.finished === null || state.time < target) liveFeed.frame = requestAnimationFrame(animateLive);
}

function startLiveClock() {
  if (liveFeed.frame !== null || document.hidden || !race.live || !race.started) return;
  liveFeed.lastFrame = null;
  liveFeed.frame = requestAnimationFrame(animateLive);
}

function stopLiveClock() {
  if (liveFeed.frame !== null) cancelAnimationFrame(liveFeed.frame);
  liveFeed.frame = liveFeed.lastFrame = null;
}

function viewLive(recording) {
  if (!recording || race === recording) return;
  state.raceRequest?.abort();
  state.raceRequest = null;
  state.shapeRequest?.abort();
  document.querySelector(".dashboard").removeAttribute("aria-busy");
  clearTimeout(state.mediaTimer);
  state.mediaRequest?.controller.abort();
  state.mediaRequest = null;
  setPlayback(false);
  stopLiveClock();
  race = recording;
  renderRace();
  refreshLiveStatus();
  startLiveClock();
}

function acceptLiveUpdate({ session, connected, rows, source = "openf1", lap = null }) {
  const previous = liveFeed.recording;
  const previousPhase = livePhase(previous);
  liveFeed.connected = connected === true;
  if (!session) {
    liveFeed.recording = null;
    if (previous) renderCatalog();
    return;
  }
  const recording = previous?.session === session.session_key ? previous
    : race.live && race.session === session.session_key ? race
      : scheduledRaces.get(session.session_key) ?? newLiveRace(session);
  liveFeed.recording = recording;
  recording.source = source;
  const hadShape = Boolean(recording.shape);
  mergeLiveRows(recording, rows ?? {});
  if (lap) {
    recording.official.total = lap.total ?? recording.official.total;
    if (recording.lapClock.at(-1)?.[1] !== lap.count) {
      addLiveSample(recording.lapClock, [Date.parse(lap.date), lap.count]);
    }
  }
  const phase = livePhase(recording);
  if (recording !== previous || phase !== previousPhase) renderCatalog();
  if (phase === "live" && liveFeed.connected && Date.now() - recording.receivedAt <= LIVE_STALE_MS &&
      !state.changedRace && !state.raceRequest && state.timer === null) {
    viewLive(recording);
  }
  if (race === recording) {
    document.body.dataset.liveSource = source;
    state.laps = raceLapTimes(recording);
    // Driver info can arrive after the first timing burst.
    if (rows?.drivers?.length) state.pairKey = "";
    if (!hadShape && recording.shape) renderShape();
    if (phase !== previousPhase || !state.battle || rows?.drivers?.length) render();
    refreshLiveStatus();
    startLiveClock();
    if (phase === "finished" && previousPhase !== "finished") void syncRace();
  }
}

async function connectLive() {
  if (location.protocol === "file:" || !navigator.onLine) return;
  const publicFallback = () => {
    liveFeed.mode = "public";
    if (typeof WebSocket === "function") connectPublicTiming();
  };
  if (liveFeed.mode === "public" || typeof EventSource !== "function") {
    publicFallback();
    return;
  }
  try {
    const response = await fetch("./api/live/status", { cache: "no-store", signal: AbortSignal.timeout(5000) });
    if (!response.ok || !response.headers.get("Content-Type")?.includes("application/json") ||
        !(await response.json()).configured) {
      if (!liveFeed.source) publicFallback();
      return;
    }
    if (liveFeed.source) return;
    const source = new EventSource("./api/live");
    liveFeed.source = source;
    refreshLiveStatus();
    source.onmessage = (event) => {
      try {
        acceptLiveUpdate(JSON.parse(event.data));
      } catch (error) {
        console.warn("Invalid race feed update", error);
      }
    };
    source.onerror = () => {
      liveFeed.connected = false;
      refreshLiveStatus();
      if (source.readyState === EventSource.CLOSED) {
        liveFeed.source = null;
        setTimeout(() => { if (!document.hidden) void connectLive(); }, 8000);
      }
    };
  } catch {
    if (!liveFeed.source) publicFallback();
  }
}
