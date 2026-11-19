"use strict";

const lasVegasCircuit = /*__LAS_VEGAS_CIRCUIT__*/ {};

function circuitDisplayShape(recording) {
  return recording.shape ?? recording.estimatedCircuit?.shape;
}

function makeEstimatedCircuit(points, pace) {
  if (points.length < 40 || points.some(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y))) return null;
  const samples = points.map(([x, y], index) => [index * 1000, x, y]);
  const shape = circuitShape(samples, 0, points.length);
  if (!shape) return null;
  shape.estimated = true;
  const route = smoothCircuitRoute(shape.points);
  const distance = [[0, ...route[0]]];
  for (const [x, y] of [...route.slice(1), route[0]]) {
    const [previous, px, py] = distance.at(-1);
    const span = Math.hypot(x - px, y - py);
    if (span > 0) distance.push([previous + span, x, y]);
  }
  const length = distance.at(-1)[0];
  return length ? { shape, distance, length, pace: pace >= 55 && pace <= 155 ? pace : 95 } : null;
}

async function attachEstimatedCircuit(recording, session) {
  if (recording.shape || recording.estimatedCircuit || recording.estimateRequested) return;
  const key = Number(session.circuit_key);
  const vegas = key === 152 || /las vegas/i.test(recording.circuit);
  if (!vegas && !(Number.isInteger(key) && key > 0)) return;
  recording.estimateRequested = true;
  try {
    let map = lasVegasCircuit;
    if (!vegas) {
      const year = new Date(recording.scheduled).getUTCFullYear();
      const response = await fetch(`https://api.multiviewer.app/api/v1/circuits/${key}/${year}`,
        { signal: AbortSignal.timeout(5000) });
      if (!response.ok) return;
      const data = await response.json();
      if (data.circuitKey !== key || !Array.isArray(data.x) || data.x.length !== data.y?.length) return;
      map = { points: data.x.map((x, index) => [x, data.y[index]]), pace: data.candidateLap?.lapTime };
    }
    recording.estimatedCircuit = makeEstimatedCircuit(map.points, map.pace);
    if (race === recording && recording.estimatedCircuit) {
      renderShape();
      render();
    }
  } catch {
    // Live timing remains available when the external track map cannot load.
  }
}

function estimatedCircuitPose(recording, driver, position, time, slot) {
  const { shape, distance, length, pace } = recording.estimatedCircuit;
  const lap = at(recording.lapClock, time);
  const lapStart = lap?.[1] > 1 ? Math.max(recording.start, lap[0]) : recording.start;
  const elapsed = Math.max(0, time - lapStart);
  const duration = (recording.estimatePace ?? pace) * 1000;
  const gap = interpolateSample(driver.intervals, time, [2], 25000, 25000)?.[2];
  const delta = Number.isFinite(gap) ? Math.max(0, gap) * 1000 : (position - 1) * 500;
  const fromStart = time - recording.start;
  const blend = clamp(fromStart / CIRCUIT_LAUNCH_MS, 0, 1);
  const release = blend * blend * (3 - 2 * blend);
  const units = shape.transform[2] * 10;
  const gridDistance = (8 + (position - 1) * 8 + 2.975) * units;
  const progress = Math.min(elapsed / duration, .9999) * length;
  const travelled = fromStart < CIRCUIT_LAUNCH_MS
    ? progress * (.25 + .75 * release) - gridDistance * (1 - release) - length * delta / duration * release
    : progress - length * delta / duration;
  const along = ((travelled % length) + length) % length;
  const end = Math.min(sampleIndex(distance, along), distance.length - 1);
  const [a, ax, ay] = distance[end - 1];
  const [b, bx, by] = distance[end];
  const t = (along - a) / (b - a);
  const x = ax + (bx - ax) * t, y = ay + (by - ay) * t;
  if (slot && release === 0) return slot;
  return { x: slot ? x * release + slot.x * (1 - release) : x,
    y: slot ? y * release + slot.y * (1 - release) : y, heading: Math.atan2(by - ay, bx - ax) };
}
