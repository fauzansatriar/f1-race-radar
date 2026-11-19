"use strict";

const SEASON = 2026;
const OPEN_F1 = "https://api.openf1.org/v1/";
const JOLPICA = `https://api.jolpi.ca/ergast/f1/${SEASON}/`;
const BLOCK_MS = 120_000;

function group(rows, key = "driver_number") {
  const result = {};
  for (const row of rows) (result[row[key]] ??= []).push(row);
  return result;
}

function sampleIndex(rows, time, key = 0) {
  let low = 0;
  let high = rows?.length ?? 0;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (rows[middle][key] <= time) low = middle + 1;
    else high = middle;
  }
  return low;
}

function at(rows, time, key = 0) {
  const index = sampleIndex(rows, time, key);
  return index ? rows[index - 1] : null;
}

function interpolateSample(rows, time, channels, maxSpan, freshness, sameContext = null) {
  const index = sampleIndex(rows, time);
  const past = rows?.[index - 1];
  if (!past || time - past[0] > freshness) return null;
  const next = rows?.[index];
  if (!next || time === past[0] || next[0] - past[0] > maxSpan || sameContext && !sameContext(past, next)) return past;
  const fraction = (time - past[0]) / (next[0] - past[0]);
  const frame = [...past];
  for (const channel of channels) {
    if (Number.isFinite(past[channel]) && Number.isFinite(next[channel])) {
      frame[channel] += (next[channel] - past[channel]) * fraction;
    }
  }
  return frame;
}

function driverEntry(entry) {
  return {
    position: entry.position,
    driver: entry.Driver.code || entry.Driver.familyName.slice(0, 3).toUpperCase(),
    name: `${entry.Driver.givenName} ${entry.Driver.familyName}`,
    team: entry.Constructor?.name ?? entry.Constructors?.at(-1)?.name ?? "",
    points: entry.points,
  };
}

function readStandings(document) {
  const { DriverStandings = [] } = document?.MRData?.StandingsTable?.StandingsLists?.[0] ?? {};
  return DriverStandings.map((entry) => ({ ...driverEntry(entry), wins: entry.wins }));
}

function readOfficial(resultsDocument, standings = []) {
  const result = resultsDocument.MRData.RaceTable.Races[0];
  if (!result?.Results?.length) throw new Error("Classification unavailable.");
  return {
    name: result.raceName,
    shortName: result.raceName.replace(" Grand Prix", " GP"),
    circuit: result.Circuit.circuitName,
    date: result.date,
    round: result.round,
    total: Number(result.Results[0].laps),
    winner: Number(result.Results[0].number),
    results: result.Results.map((entry) => ({
      ...driverEntry(entry), status: entry.Time?.time || entry.status, raceStatus: entry.status, laps: Number(entry.laps), number: Number(entry.number), grid: Number(entry.grid),
    })),
    standings,
  };
}

function readCatalog(resultsDocument, sessions) {
  const races = resultsDocument.MRData.RaceTable.Races
    .filter((race) => race.season === String(SEASON) && Number(race.Results?.[0]?.laps) > 0);
  return races.map((race) => {
    const scheduled = Date.parse(`${race.date}T${race.time || "12:00:00Z"}`);
    const eligible = sessions.filter((session) => !session.is_cancelled && session.session_name === "Race" && session.year === SEASON);
    const session = eligible.find((entry) => Math.abs(Date.parse(entry.date_start) - scheduled) < 12 * 3_600_000);
    return {
      round: race.round,
      name: race.raceName,
      date: race.date,
      session: session ? { session_key: session.session_key, circuit_short_name: session.circuit_short_name } : null,
    };
  }).sort((a, b) => Number(b.round) - Number(a.round));
}

function replayWindow(laps, official, controls = []) {
  const lead = laps.filter((lap) => lap.driver_number === official.winner && lap.date_start)
    .sort((a, b) => a.lap_number - b.lap_number);
  const first = lead.find((lap) => lap.lap_number === 1);
  const last = lead.findLast((lap) => lap.lap_number === official.total && lap.lap_duration > 0);
  if (!first || !last) throw new Error("OpenF1 first or final lap timing unavailable.");
  const from = Date.parse(first.date_start);
  const lastStart = Date.parse(last.date_start);
  const green = controls.find((item) => item.message === "RACE START" && Math.abs(Date.parse(item.date) - from) < 60_000);
  const flag = controls.find((item) => item.flag === "CHEQUERED" && Date.parse(item.date) >= lastStart);
  const start = green ? Date.parse(green.date) : from;
  const end = flag ? Date.parse(flag.date) : Math.round(lastStart + last.lap_duration * 1000);
  if (!(end > start)) throw new Error("Invalid OpenF1 race duration.");
  return { start, end };
}

function timedSamples(rows, project) {
  const values = new Map();
  for (const row of rows ?? []) {
    const time = Date.parse(row.date);
    if (!Number.isFinite(time)) continue;
    const bin = Math.floor(time / 800);
    if ((values.get(bin)?.[0] ?? -Infinity) <= time) values.set(bin, [time, ...project(row)]);
  }
  return [...values.values()].sort((a, b) => a[0] - b[0]);
}

const telemetryFields = (row) => [
  row.speed, row.throttle, row.brake === 0 || row.brake === 100 ? row.brake : null,
  row.n_gear, row.rpm,
];
const locationFields = (row) => [row.x, row.y];

function lapSample(row, start = Date.parse(row.date_start)) {
  return [
    start, row.lap_number, row.lap_duration,
    [row.duration_sector_1, row.duration_sector_2, row.duration_sector_3],
    [row.segments_sector_1, row.segments_sector_2, row.segments_sector_3].flatMap((sector) => sector ?? []),
    Boolean(row.is_pit_out_lap),
  ];
}

function driverIdentity(driver, result = {}) {
  return {
    code: result.driver || driver.name_acronym || String(driver.driver_number),
    name: result.name || driver.full_name || String(driver.driver_number),
    team: driver.team_name || result.team || "",
    color: /^[0-9a-f]{6}$/i.test(driver.team_colour) ? `#${driver.team_colour}` : "#e0e0e8",
    headshot: /^https:\/\/media\.formula1\.com\//.test(driver.headshot_url) ? driver.headshot_url : "",
  };
}

function circuitShape(points, start, length) {
  const lap = points.filter(([time]) => time >= start && time < start + length * 1000);
  if (lap.length < 40) return null;
  const horizontal = lap.map((point) => point[2]);
  const vertical = lap.map((point) => -point[1]);
  const minX = Math.min(...horizontal), maxX = Math.max(...horizontal);
  const minY = Math.min(...vertical), maxY = Math.max(...vertical);
  const scale = Math.min(280 / (maxX - minX), 181 / (maxY - minY));
  if (!Number.isFinite(scale)) return null;
  const xCenter = (minX + maxX) / 2, yCenter = (minY + maxY) / 2;
  const transform = [xCenter, yCenter, scale];
  return { transform, points: lap.map((point) => mapPoint(point, transform)) };
}

function mapPoint(point, [x, y, scale]) {
  return [210 + (point[2] - x) * scale, 111 + (point[1] + y) * scale];
}

function packRace(session, official, input, window) {
  const { start, end } = window;
  const lapRows = group(input.laps);
  const intervals = group(input.intervals);
  const positions = group(input.position);
  const telemetry = group(input.car_data);
  const locations = group(input.location);
  const participants = {};
  const sorted = (rows) => rows.sort((a, b) => a[0] - b[0]);
  const hasDate = (row) => Boolean(row.date);
  const recent = (row) => {
    const time = Date.parse(row.date);
    return time >= start - 35_000 && time <= end + 1000;
  };
  for (const driver of input.drivers) {
    const n = driver.driver_number;
    const result = official.results.find((item) => item.number === n);
    if (!result || result.raceStatus === "Did not start") continue;
    const lastRecordedLap = (lapRows[n] ?? []).filter((row) => row.date_start)
      .sort((a, b) => b.lap_number - a.lap_number)[0];
    const retired = result.laps < official.total - 2 && !/^(Finished|Lapped|\+\d+ Laps?)$/i.test(result.raceStatus);
    const activeThrough = retired && lastRecordedLap
      ? Date.parse(lastRecordedLap.date_start) + (lastRecordedLap.lap_duration ?? 120) * 1000
      : null;
    participants[n] = {
      number: n,
      activeThrough,
      ...driverIdentity(driver, result),
      laps: sorted((lapRows[n] ?? []).filter((row) => row.date_start).map((row) => lapSample(row))),
      positions: sorted((positions[n] ?? []).filter(hasDate).map((row) => [Date.parse(row.date), row.position])),
      intervals: sorted((intervals[n] ?? []).filter(recent).map((row) => [Date.parse(row.date), row.interval, row.gap_to_leader])),
      telemetry: timedSamples(telemetry[n], telemetryFields),
      locations: timedSamples(locations[n], locationFields),
    };
  }
  if (!Object.keys(participants).length || !participants[official.winner]?.laps.length) {
    throw new Error("OpenF1 timing unavailable for this race.");
  }
  return { session: session.session_key, official, start, end, shape: input.shape ?? null,
    circuit: session.circuit_short_name, participants, embeddedBlocks: input.embeddedBlocks ?? [] };
}

function dateRange(from, to) {
  return `&date%3E${new Date(from).toISOString()}&date%3C${new Date(to).toISOString()}`;
}

async function requestJSON(url, signal) {
  const timeout = AbortSignal.timeout(35000);
  const requestSignal = signal ? AbortSignal.any([timeout, signal]) : timeout;
  const response = await fetch(url, { cache: "no-store", signal: requestSignal });
  if (response.status === 429) {
    await new Promise((resolve) => setTimeout(resolve, 3500));
    requestSignal.throwIfAborted();
    const retry = await fetch(url, { cache: "no-store", signal: requestSignal });
    if (retry.ok) return retry.json();
  }
  if (!response.ok) throw new Error(`HTTP ${response.status} at ${new URL(url).hostname}`);
  return response.json();
}

function fetchOpen(endpoint, query, signal) {
  return requestJSON(OPEN_F1 + endpoint + "?" + query, signal);
}

async function fetchRace(session, official, signal) {
  const filter = `session_key=${session.session_key}`;
  const input = { car_data: [], location: [] };
  for (const endpoint of ["laps", "drivers", "position", "intervals"]) {
    signal?.throwIfAborted();
    input[endpoint] = await fetchOpen(endpoint, filter, signal);
  }
  const controls = await fetchOpen("race_control", filter, signal).catch(() => []);
  signal?.throwIfAborted();
  const window = replayWindow(input.laps, official, controls);
  return packRace(session, official, input, window);
}

async function fetchShape(recording, signal) {
  const { winner } = recording.official;
  const typical = recording.participants[winner].laps.filter((lap) => lap[1] >= 3 && lap[2] > 30 && lap[2] < 240 && !lap[5]);
  const lap = typical.length ? typical.reduce((best, current) => current[2] < best[2] ? current : best) : null;
  if (!lap) return null;
  const query = `session_key=${recording.session}&driver_number=${winner}` + dateRange(lap[0] - 1000, lap[0] + (lap[2] + 1) * 1000);
  const rows = await fetchOpen("location", query, signal);
  return circuitShape(timedSamples(rows, locationFields), lap[0], lap[2]);
}

async function fetchBlock(recording, index, signal) {
  const from = recording.start + index * BLOCK_MS;
  const to = Math.min(recording.end, from + BLOCK_MS + 5000);
  const query = `session_key=${recording.session}` + dateRange(from - 30_000, to + 1000);
  const [cars, positions] = await Promise.allSettled([
    fetchOpen("car_data", query, signal), fetchOpen("location", query, signal),
  ]);
  signal?.throwIfAborted();
  const pack = (result, fields) => result.status === "fulfilled"
    ? Object.fromEntries(Object.entries(group(result.value)).map(([number, rows]) => [number, timedSamples(rows, fields)])) : null;
  return { telemetry: pack(cars, telemetryFields), locations: pack(positions, locationFields) };
}

if (typeof module !== "undefined") module.exports = { interpolateSample, readOfficial, readStandings, readCatalog, replayWindow, packRace, circuitShape, timedSamples, locationFields };
