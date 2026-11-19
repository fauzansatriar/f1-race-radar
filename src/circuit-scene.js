let circuitCamera = "overview";
let circuitZoom = 0;
const MAX_CIRCUIT_ZOOM = 8;

function setCircuitZoom(step) {
  circuitZoom = clamp(step, 0, circuitCamera.startsWith("cockpit-") ? 2 : MAX_CIRCUIT_ZOOM);
  if (state.battle) renderMotion(true);
  else drawCircuitScene([]);
}
const circuitCarMesh = /*__CAR_2026_MESH__*/ [];
const circuitTeamLogos = /*__TEAM_LOGOS__*/ {};
const circuitLogoImages = new Map();

function circuitTeamLogo(team) {
  const key = team?.toLowerCase().replace(/[^a-z0-9]/g, "");
  const source = circuitTeamLogos[key];
  if (!source) return null;
  if (!circuitLogoImages.has(key)) {
    const image = new Image();
    image.addEventListener("load", () => {
      if (!$("circuit-scene").hidden && state.battle) renderMotion();
    });
    image.src = source;
    circuitLogoImages.set(key, image);
  }
  const image = circuitLogoImages.get(key);
  return image.complete && image.naturalWidth ? image : null;
}

const smoothCircuitRoutes = new WeakMap();

function smoothCircuitRoute(points) {
  if (smoothCircuitRoutes.has(points)) return smoothCircuitRoutes.get(points);
  const count = points.length;
  const smooth = points.flatMap((point, i) => {
    const previous = points[(i + count - 1) % count];
    const next = points[(i + 1) % count];
    const after = points[(i + 2) % count];
    const length = Math.hypot(next[0] - point[0], next[1] - point[1]);
    if (length === 0) return [point];
    const steps = Math.min(12, Math.max(2, Math.ceil(length / .9)));
    return Array.from({ length: steps }, (_, step) =>
      point.map((start, axis) => {
        const end = next[axis], t = step / steps;
        const a = clamp((end - previous[axis]) / 2, -length, length);
        const b = clamp((after[axis] - start) / 2, -length, length);
        return start + t * (a + t * (3 * (end - start) - 2 * a - b + t * (2 * (start - end) + a + b)));
      }));
  });
  smoothCircuitRoutes.set(points, smooth);
  return smooth;
}

function circuitLocation(samples, time, freshness = 8000) {
  const frame = interpolateSample(samples, time, LOCATION, 3500, freshness);
  if (!frame) return frame;
  const index = sampleIndex(samples, time);
  const before = samples[index - 2], a = samples[index - 1], b = samples[index], after = samples[index + 1];
  if (!before || !a || !b || !after || frame === a ||
      Math.max(a[0] - before[0], b[0] - a[0], after[0] - b[0]) > 3500) return frame;
  const span = b[0] - a[0], t = (time - a[0]) / span;
  for (const axis of LOCATION) {
    const delta = b[axis] - a[axis];
    if (!delta) continue;
    // Limit the tangents to the sampled interval so a car cannot overshoot a stop.
    const m0 = clamp((b[axis] - before[axis]) / (b[0] - before[0]) * span / delta, 0, 3);
    const m1 = clamp((after[axis] - a[axis]) / (after[0] - a[0]) * span / delta, 0, 3);
    const weight = clamp(t * (m0 + t * (3 - 2 * m0 - m1 + t * (m0 + m1 - 2))), 0, 1);
    frame[axis] = a[axis] + delta * weight;
  }
  return frame;
}

function circuitHeading(samples, time) {
  const from = circuitLocation(samples, time - 400, 1800);
  const to = circuitLocation(samples, time + 400, 1800);
  if (!from || !to) return null;
  const dx = to[2] - from[2], dy = to[1] - from[1];
  return Math.hypot(dx, dy) > 0 ? Math.atan2(dy, dx) : null;
}

function drawCircuitScene(cars) {
  const canvas = $("circuit-scene");
  const visible = !mobileLayout.matches && document.body.dataset.view === "circuit";
  canvas.hidden = !visible;
  const status = $("circuit-scene-status");
  status.hidden = !visible || Boolean(race.shape && cars.length === 2);
  const controls = $("circuit-camera");
  controls.hidden = !visible;
  $("circuit-duel").hidden = !visible || !state.battle;
  if (!visible) return;
  if (state.battle) updateCircuitDuel();
  const cockpit = circuitCamera.startsWith("cockpit-");
  for (const button of controls.querySelectorAll("button[data-camera]")) {
    const key = button.dataset.camera;
    const driver = state.battle?.[key.replace("cockpit-", "")];
    if (key !== "overview") {
      button.disabled = !driver;
      const label = `${key.startsWith("cockpit-") ? "Cockpit" : "Follow"} ${driver?.code ?? key.at(-1).toUpperCase()}`;
      if (button.textContent !== label) button.textContent = label;
    }
    button.setAttribute("aria-pressed", String(key === circuitCamera));
  }
  const followed = cars.find((car) => car.key === circuitCamera.replace("cockpit-", ""));
  const cockpitReady = cockpit && Boolean(followed && race.shape?.points.length);
  if (cockpit && !cockpitReady) status.hidden = false;
  const zoom = 2 ** (circuitZoom / 2);
  text("circuit-zoom-readout", `${Number(zoom.toFixed(1))}×`);
  $("circuit-zoom-out").disabled = !race.shape || circuitZoom === 0;
  $("circuit-zoom-in").disabled = !race.shape || circuitZoom === (cockpit ? 2 : MAX_CIRCUIT_ZOOM);
  $("circuit-zoom-reset").disabled = !race.shape || circuitZoom === 0;
  text("circuit-scene-status", !race.shape ? "Circuit GPS trace unavailable"
    : cockpit && !cockpitReady ? "Cockpit waiting for GPS"
    : circuitCamera !== "overview" && !followed ? "Follow camera waiting for GPS"
    : cars.length ? "One driver has no GPS sample here" : "Driver GPS samples unavailable here");

  const { width, height } = canvas.getBoundingClientRect();
  const ctx = canvas.getContext("2d");
  if (!ctx || width < 1 || height < 1) return;
  const density = Math.min(devicePixelRatio || 1, 2);
  const w = Math.round(width * density), h = Math.round(height * density);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  ctx.setTransform(density, 0, 0, density, 0, 0);
  // F1 location coordinates use decimetres. Convert metres into the same
  // normalized map units as the GPS trace before projecting either object.
  const unitsPerMetre = (race.shape?.transform[2] ?? 0) * 10;
  if (cockpitReady && unitsPerMetre && race.shape?.points.length) {
    drawCircuitCockpit(ctx, width, height, followed, cars, smoothCircuitRoute(race.shape.points), unitsPerMetre, zoom);
    return;
  }
  const overviewScale = Math.min(width / 345, height / 167);
  const baseScale = followed && unitsPerMetre
    ? Math.max(overviewScale, Math.min(width / 220, height / 92) / unitsPerMetre)
    : overviewScale;
  const scale = baseScale * zoom;
  // Map the GPS plane into a pitched camera. The depth below the track is decorative.
  const project = (x, y, elevation = 0) => {
    const dx = x - (followed?.x ?? 210), dy = y - (followed?.y ?? 111);
    const across = dx * .985 + dy * .174;
    const depth = dy * .985 - dx * .174;
    const perspective = 1 / Math.max(.48, 1 - depth / 440);
    return [width / 2 + across * perspective * scale,
      height * .51 + (depth * .46 - elevation) * perspective * scale];
  };
  project.depth = (x, y) => y * .985 - x * .174;
  const path = (points, elevation) => {
    ctx.beginPath();
    points.forEach(([x, y], index) => {
      const point = project(x, y, elevation);
      if (index) ctx.lineTo(...point);
      else ctx.moveTo(...point);
    });
  };
  const sky = ctx.createLinearGradient(0, 0, 0, height);
  sky.addColorStop(0, "#0a1018");
  sky.addColorStop(1, "#18242e");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = "#2e4051";
  ctx.lineWidth = 1;
  for (let x = -280; x <= 700; x += 25) {
    path([[x, -350], [x, 345]], -10);
    ctx.stroke();
  }
  for (let y = -350; y <= 345; y += 25) {
    path([[-280, y], [700, y]], -10);
    ctx.stroke();
  }
  if (!race.shape?.points.length) return;
  const route = smoothCircuitRoute(race.shape.points);
  const crossSections = route.map(([x, y], index) => {
    const before = route[(index + route.length - 1) % route.length];
    const after = route[(index + 1) % route.length];
    const dx = after[0] - before[0], dy = after[1] - before[1];
    const length = Math.hypot(dx, dy) || 1;
    return { x, y, nx: -dy / length, ny: dx / length };
  });
  for (const [ink, metres, height] of [
    ["#101620", 13, -.6], ["#b0bfcd", 12, 0], ["#27313b", 11, 0],
  ]) {
    const half = metres * unitsPerMetre / 2;
    const left = crossSections.map(({ x, y, nx, ny }) => [x + nx * half, y + ny * half]);
    const right = crossSections.map(({ x, y, nx, ny }) => [x - nx * half, y - ny * half]);
    path(left, height * unitsPerMetre);
    ctx.closePath();
    right.forEach(([x, y], i) => {
      const point = project(x, y, height * unitsPerMetre);
      if (i === 0) ctx.moveTo(...point);
      else ctx.lineTo(...point);
    });
    ctx.closePath();
    ctx.fillStyle = ink;
    ctx.fill("evenodd");
  }
  for (const { x, y, heading, color } of cars) {
    drawCircuitCar(ctx, project, x, y, heading, color, unitsPerMetre);
  }
}

function updateCircuitDuel() {
  for (const [key, offset] of [["a", -1], ["b", 0]]) {
    const driver = state.battle[key];
    text(`circuit-driver-${key}`, driver.code);
    text(`circuit-position-${key}`, `P${state.battle.position + offset}`);
    const image = $(`circuit-logo-${key}`);
    const logo = circuitTeamLogo(driver.team);
    image.hidden = !logo;
    if (logo && image.src !== logo.src) image.src = logo.src;
    image.parentElement.style.setProperty("--driver-color", driver.color);
  }
}

function drawCircuitCockpit(ctx, width, height, driver, cars, route, units, zoom) {
  const tangent = Number.isFinite(driver.heading) ? null : circuitTrackTangent(route, driver.x, driver.y);
  const heading = driver.heading ?? tangent?.heading;
  if (!Number.isFinite(heading)) return;
  const cos = Math.cos(heading), sin = Math.sin(heading);
  const focal = Math.min(width * .65, height * 1.23);
  const chase = 10 / zoom;
  const eyeHeight = 2.6;
  const horizon = height * .29;
  const near = 1.25;
  // Camera space in metres. Camera and car use the same interpolated GPS sample.
  const camera = (x, y, elevation = 0) => {
    const dx = (x - driver.x) / units, dy = (y - driver.y) / units;
    return [(dy * cos - dx * sin), eyeHeight - elevation / units, dx * cos + dy * sin + chase];
  };
  const screen = ([x, y, depth]) => [width / 2 + x * focal / depth, horizon + y * focal / depth];
  const polygon = (points, color, append = false) => {
    const clipped = [];
    let previous = points.at(-1);
    for (const current of points) {
      if ((previous[2] >= near) !== (current[2] >= near)) {
        const t = (near - previous[2]) / (current[2] - previous[2]);
        clipped.push([previous[0] + t * (current[0] - previous[0]), previous[1] + t * (current[1] - previous[1]), near]);
      }
      if (current[2] >= near) clipped.push(current);
      previous = current;
    }
    if (clipped.length < 3) return;
    if (!append) ctx.beginPath();
    clipped.forEach((point, index) => {
      if (index) ctx.lineTo(...screen(point));
      else ctx.moveTo(...screen(point));
    });
    ctx.closePath();
    if (!append) {
      ctx.fillStyle = color;
      ctx.fill();
    }
  };
  const sky = ctx.createLinearGradient(0, 0, 0, horizon);
  sky.addColorStop(0, "#24445d");
  sky.addColorStop(1, "#b2c5d4");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, width, horizon);
  ctx.fillStyle = "#293940";
  ctx.fillRect(0, horizon, width, height - horizon);
  const routeInCamera = route.map(([x, y]) => camera(x, y));
  const sections = routeInCamera.map(([x, y, z], i) => {
    const a = routeInCamera[(i + route.length - 1) % route.length];
    const b = routeInCamera[(i + 1) % route.length];
    const dx = b[0] - a[0], dz = b[2] - a[2];
    const length = Math.hypot(dx, dz) || 1;
    return { z, edge: (metres) => [x - dz * metres / length, y, z + dx * metres / length] };
  });
  const segments = sections.map((section, i) => [section, sections[(i + 1) % sections.length]])
    .filter(([a, b]) => Math.max(a.z, b.z) >= near && Math.min(a.z, b.z) < 450)
    .sort(([a, b], [c, d]) => c.z + d.z - a.z - b.z);
  for (const [edge, ink] of [[7, "#52636a"], [6, "#d1d9df"], [5.83, "#313942"]]) {
    ctx.beginPath();
    for (const [a, b] of segments) polygon([a.edge(-edge), a.edge(edge), b.edge(edge), b.edge(-edge)], ink, true);
    ctx.fillStyle = ink;
    ctx.fill();
  }
  for (const { corners, color } of recordedCircuitGrid(race, route, units)) {
    polygon(corners.map(([x, y]) => camera(x, y)), color);
  }
  const projectCar = (x, y, z) => screen(camera(x, y, z));
  projectCar.depth = (x, y) => -camera(x, y)[2];
  for (const car of [...cars].sort((a, b) => camera(b.x, b.y)[2] - camera(a.x, a.y)[2])) {
    if (camera(car.x, car.y)[2] < near + 3) continue;
    drawCircuitCar(ctx, projectCar, car.x, car.y, car.heading ?? heading, car.color, units);
  }
}

function gridStartSample(samples, start) {
  const sample = recentSample(samples, start, 2500);
  const prior = sample && recentSample(samples, sample[0] - 650, 1700);
  return prior && Math.hypot(sample[1] - prior[1], sample[2] - prior[2]) <= 20 ? sample : null;
}

function circuitTrackTangent(route, x, y) {
  let nearest = Infinity, direction;
  for (let i = 0; i < route.length; i++) {
    const [ax, ay] = route[i], [bx, by] = route[(i + 1) % route.length];
    const dx = bx - ax, dy = by - ay, length = Math.hypot(dx, dy);
    if (!length) continue;
    const t = clamp(((x - ax) * dx + (y - ay) * dy) / (length * length), 0, 1);
    const distance = Math.hypot(x - ax - t * dx, y - ay - t * dy);
    if (distance >= nearest) continue;
    nearest = distance;
    direction = [dx / length, dy / length];
  }
  if (!direction) return null;
  const [dx, dy] = direction;
  return { dx, dy, distance: nearest, heading: Math.atan2(dy, dx) };
}

const recordedGridCache = new WeakMap();

function recordedCircuitGrid(recording, route, units) {
  if (recording.live) return circuitGrid(route, units);
  const locations = mediaState(recording).get(0)?.locations;
  const cached = recordedGridCache.get(recording);
  if (cached?.route === route && (!locations || locations === cached.locations)) return cached.markings;

  const markings = circuitGrid(route, units).slice(0, 1);
  for (const driver of Object.values(recording.participants)) {
    const sample = gridStartSample(locations?.[driver.number] ?? driver.locations, recording.start);
    if (!sample) continue;
    const [x, y] = mapPoint(sample, recording.shape.transform);
    const tangent = circuitTrackTangent(route, x, y);
    if (!tangent || tangent.distance > 4.4 * units) continue;
    const { dx, dy } = tangent;
    const point = (forward, side) => [x + (dx * forward - dy * side) * units,
      y + (dy * forward + dx * side) * units];
    const stripe = (rear, front, left, right) => {
      markings.push({ corners: [point(rear, left), point(rear, right),
        point(front, right), point(front, left)], color: "#edf1ef" });
    };
    stripe(2.8, 3, -1.08, 1.08);
    stripe(1.15, 3, -1.08, -.90);
    stripe(1.15, 3, .90, 1.08);
  }
  const rendered = markings.length > 1 ? markings : circuitGrid(route, units);
  recordedGridCache.set(recording, { route, locations, markings: rendered });
  return rendered;
}

const circuitGridCache = new WeakMap();

function circuitGrid(route, units) {
  const cached = circuitGridCache.get(route);
  if (cached?.units === units) return cached.markings;
  // Walk backwards from the start line so each slot follows the local road.
  const series = [[0, ...route[0]]];
  for (let i = route.length - 1; i > 0 && series.at(-1)[0] < 68; i--) {
    const [distance, x, y] = series.at(-1);
    const [nextX, nextY] = route[i];
    const span = Math.hypot(nextX - x, nextY - y) / units;
    if (span > 0) series.push([distance + span, nextX, nextY]);
  }
  const point = (metres, lateral) => {
    const end = Math.min(series.length - 1, sampleIndex(series, metres));
    const [d0, x0, y0] = series[end - 1];
    const [d1, x1, y1] = series[end];
    const t = (metres - d0) / (d1 - d0);
    return [x0 + (x1 - x0) * t - (y1 - y0) * lateral / (d1 - d0),
      y0 + (y1 - y0) * t + (x1 - x0) * lateral / (d1 - d0)];
  };
  const markings = [];
  const paint = (back, length, left, right) => {
    if (series.at(-1)[0] < back + length) return;
    markings.push({ corners: [point(back, left), point(back, right),
      point(back + length, right), point(back + length, left)], color: "#edf1ef" });
  };
  paint(0, .35, -5.25, 5.25);
  for (let slot = 0; slot < 8; slot++) {
    const back = 8 + slot * 8, side = slot % 2 ? 2.8 : -2.8;
    paint(back, .22, side - 1.1, side + 1.1);
    paint(back, 2.4, side - 1.1, side - .92);
    paint(back, 2.4, side + .92, side + 1.1);
  }
  circuitGridCache.set(route, { units, markings });
  return markings;
}

const circuitCarMaterials = {
  carbon: "#292f37", metal: "#68737e", dark: "#141821", tyre: "#22262b",
};

const circuitCarFaces = circuitCarMesh.flatMap(({ ink, vertices, triangles }, part) =>
  triangles.map(([a, b, c]) => {
    const [ux, uy, uz] = vertices[b].map((value, i) => value - vertices[a][i]);
    const [vx, vy, vz] = vertices[c].map((value, i) => value - vertices[a][i]);
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const light = Math.abs(nx * .35 - ny * .45 + nz * .82) / (Math.hypot(nx, ny, nz) || 1);
    return { part, a, b, c, ink, shade: Math.round((.56 + .44 * light) * 16) / 16 };
  }));

const circuitCarPalette = new Map();

function drawCircuitCar(ctx, project, x, y, heading, color, units) {
  const forwardX = Math.cos(heading ?? 0) * units;
  const forwardY = Math.sin(heading ?? 0) * units;
  const projected = circuitCarMesh.map(({ vertices }) => vertices.map(([length, lateral, height]) => {
    const wx = x + length * forwardX - lateral * forwardY;
    const wy = y + length * forwardY + lateral * forwardX;
    return [...project(wx, wy, height * units), project.depth(wx, wy)];
  }));
  if (!circuitCarPalette.has(color)) {
    circuitCarPalette.set(color, circuitCarFaces.map(({ ink, shade }) => {
      const rgb = Number.parseInt((circuitCarMaterials[ink] ?? color).slice(1), 16);
      return "rgb(" + [16, 8, 0].map(shift => Math.round(((rgb >> shift) & 255) * shade)).join(",") + ")";
    }));
  }
  const palette = circuitCarPalette.get(color);
  const faces = circuitCarFaces.map(({ part, a, b, c }, index) => {
    const points = projected[part];
    return { a: points[a], b: points[b], c: points[c], color: palette[index],
      depth: points[a][2] + points[b][2] + points[c][2] };
  }).sort((a, b) => a.depth - b.depth);
  for (const { a, b, c, color } of faces) {
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0], b[1]);
    ctx.lineTo(c[0], c[1]);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
  }
}
