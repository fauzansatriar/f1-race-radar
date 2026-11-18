"use strict";

const F1_TIMING_SOCKET = "wss://livetiming.formula1.com/signalrcore";
const F1_FRAME_END = "\x1e";
const F1_TIMING_TOPICS = ["SessionInfo", "SessionStatus", "RaceControlMessages",
  "LapCount", "Heartbeat", "DriverList", "TimingData"];
const publicTiming = { socket: null, retry: null, delay: 4000 };

function mergeTimingPatch(previous, patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return patch;
  const merged = { ...previous };
  for (const [key, value] of Object.entries(patch)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    merged[key] = mergeTimingPatch(merged[key], value);
  }
  return merged;
}

function publicTimingValue(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (/^[+-]?\d+(?:\.\d+)?$/.test(text)) return Number(text);
  return /^\+?\d+\s+LAPS?$/i.test(text) ? text : null;
}

function readPublicSession(info) {
  if (info?.Type !== "Race" || !Number.isInteger(info.Key) ||
      typeof info.StartDate !== "string" || !/^[+-]\d\d:\d\d/.test(info.GmtOffset ?? "")) return null;
  const offset = info.GmtOffset.slice(0, 6);
  const scheduled = Date.parse(info.StartDate + offset);
  const end = Date.parse(info.EndDate + offset) || scheduled + 3_600_000 * 2;
  const now = Date.now();
  if (!Number.isFinite(scheduled) || now < scheduled - 1_800_000 || now > end + 3_600_000 * 3) return null;
  return {
    session_key: info.Key,
    date_start: new Date(scheduled).toISOString(),
    meeting_name: info.Meeting?.Name,
    country_name: info.Meeting?.Country?.Name,
    circuit_short_name: info.Meeting?.Circuit?.ShortName,
  };
}

function publicTimingUpdate(topics, changes, snapshot) {
  const session = readPublicSession(topics.SessionInfo);
  if (!session) return null;
  const status = topics.SessionStatus?.Status ?? topics.SessionInfo.SessionStatus;
  const active = /^(Started|Resumed|Aborted|Suspended)$/i.test(status ?? "");
  const over = /^(Finished|Finalised|Ends)$/i.test(status ?? "");
  if (over && liveFeed.recording?.session !== session.session_key) return null;
  const rows = { drivers: [], position: [], intervals: [], race_control: [] };
  if (changes.has("DriverList") || snapshot) {
    for (const [key, item] of Object.entries(topics.DriverList ?? {})) {
      const number = Number(key);
      if (!Number.isInteger(number) || !item?.Tla) continue;
      rows.drivers.push({ driver_number: number, name_acronym: item.Tla, full_name: item.FullName,
        team_name: item.TeamName, team_colour: item.TeamColour, headshot_url: item.HeadshotUrl });
    }
  }
  const timingDate = changes.get("TimingData")?.date ?? (snapshot ? topics.Heartbeat?.Utc : null);
  const timingTime = Date.parse(timingDate);
  if (Number.isFinite(timingTime) && Math.abs(Date.now() - timingTime) <= 180_000) {
    for (const [key, line] of Object.entries(topics.TimingData?.Lines ?? {})) {
      const number = Number(key);
      const position = Number(line?.Position);
      if (!Number.isInteger(number) || !Number.isInteger(position) || position <= 0) continue;
      rows.position.push({ driver_number: number, position, date: timingDate });
      rows.intervals.push({ driver_number: number, date: timingDate,
        interval: publicTimingValue(line.IntervalToPositionAhead?.Value),
        gap_to_leader: position === 1 ? 0 : publicTimingValue(line.GapToLeader) });
    }
  }
  if (active && (snapshot || changes.has("SessionStatus"))) {
    rows.race_control.push({ date: snapshot ? session.date_start :
      changes.get("SessionStatus")?.date ?? session.date_start, message: "RACE START" });
  }
  if (over || changes.has("RaceControlMessages")) {
    const messages = Object.values(topics.RaceControlMessages?.Messages ?? {});
    const finish = messages.find((item) => item?.Flag === "CHEQUERED" && Number.isFinite(Date.parse(item.Utc)));
    const flagDate = finish?.Utc ?? (over ? changes.get("SessionStatus")?.date ?? topics.Heartbeat?.Utc : null);
    if (Number.isFinite(Date.parse(flagDate))) rows.race_control.push({ date: flagDate, flag: "CHEQUERED" });
  }
  const count = Number(topics.LapCount?.CurrentLap);
  const total = Number(topics.LapCount?.TotalLaps);
  const lapDate = changes.get("LapCount")?.date ?? timingDate;
  const lap = Number.isInteger(count) && count > 0 && Number.isFinite(Date.parse(lapDate))
    ? { count, total: Number.isInteger(total) && total >= count ? total : null, date: lapDate } : null;
  return { session, connected: true, source: "public", rows, lap };
}

function connectPublicTiming() {
  if (publicTiming.socket || publicTiming.retry !== null || document.hidden || !navigator.onLine) return;
  const socket = new WebSocket(F1_TIMING_SOCKET);
  publicTiming.socket = socket;
  let topics = {};
  let ping = null;
  const handshake = setTimeout(() => socket.close(), 8500);
  const send = (message) => socket.send(JSON.stringify(message) + F1_FRAME_END);
  socket.onopen = () => send({ protocol: "json", version: 1 });
  socket.onmessage = ({ data }) => {
    let snapshot = false;
    const changes = new Map();
    for (const part of String(data).split(F1_FRAME_END)) {
      if (!part) continue;
      let message;
      try { message = JSON.parse(part); } catch { continue; }
      if (!message || typeof message !== "object") continue;
      if (message.error || message.type === 7) {
        socket.close();
        return;
      }
      if (!("type" in message)) {
        send({ type: 1, invocationId: "timing", target: "Subscribe", arguments: [F1_TIMING_TOPICS] });
        ping = setInterval(() => { if (socket.readyState === WebSocket.OPEN) send({ type: 6 }); }, 15_000);
      } else if (message.type === 3 && message.invocationId === "timing" && message.result) {
        clearTimeout(handshake);
        publicTiming.delay = 4000;
        liveFeed.connected = true;
        snapshot = true;
        for (const [topic, patch] of Object.entries(message.result)) {
          if (F1_TIMING_TOPICS.includes(topic)) changes.set(topic, { patch });
        }
      } else if (message.type === 1 && message.target?.toLowerCase() === "feed") {
        const [topic, patch, date] = message.arguments ?? [];
        if (!F1_TIMING_TOPICS.includes(topic)) continue;
        changes.set(topic, { patch: mergeTimingPatch(changes.get(topic)?.patch, patch), date });
      }
    }
    const next = changes.get("SessionInfo")?.patch?.Key;
    if (next && next !== topics.SessionInfo?.Key) topics = {};
    for (const [topic, { patch }] of changes) topics[topic] = mergeTimingPatch(topics[topic], patch);
    if (!changes.size) return;
    const update = publicTimingUpdate(topics, changes, snapshot);
    if (update) acceptLiveUpdate(update);
    else refreshLiveStatus();
  };
  socket.onerror = () => socket.close();
  socket.onclose = () => {
    clearTimeout(handshake);
    clearInterval(ping);
    publicTiming.socket = null;
    liveFeed.connected = false;
    refreshLiveStatus();
    publicTiming.retry = setTimeout(() => {
      publicTiming.retry = null;
      void connectLive();
    }, publicTiming.delay);
    publicTiming.delay = Math.min(60_000, publicTiming.delay * 2);
  };
}
