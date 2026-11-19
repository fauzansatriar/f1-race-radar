let circuitCamera = "overview";
let circuitZoom = 0;
const MAX_CIRCUIT_ZOOM = 8;
const defaultCircuitOverview = { yaw: Math.PI / 18, pitch: .46, panX: 0, panY: 0 };
let circuitOverview = { ...defaultCircuitOverview };

function circuitOverviewAdjusted() {
  return circuitZoom > 0 || Object.keys(defaultCircuitOverview)
    .some((key) => circuitOverview[key] !== defaultCircuitOverview[key]);
}

function resetCircuitOverview() {
  circuitOverview = { ...defaultCircuitOverview };
}

function installCircuitOverviewControls(canvas) {
  let drag = null;
  let redraw = 0;
  const available = () => canvas.tabIndex === 0;
  const refresh = () => {
    if (redraw) return;
    redraw = requestAnimationFrame(() => {
      redraw = 0;
      redrawCircuitMap();
    });
  };
  const pan = (x, y) => {
    circuitOverview.panX = clamp(circuitOverview.panX + x / canvas.clientWidth, -2, 2);
    circuitOverview.panY = clamp(circuitOverview.panY + y / canvas.clientHeight, -2, 2);
  };
  const orbit = (yaw, pitch) => {
    circuitOverview.yaw = (circuitOverview.yaw + yaw) % (2 * Math.PI);
    circuitOverview.pitch = clamp(circuitOverview.pitch + pitch, .22, 1);
  };
  canvas.addEventListener("pointerdown", (event) => {
    if (!available() || (event.button !== 0 && event.button !== 2)) return;
    canvas.focus({ preventScroll: true });
    canvas.setPointerCapture(event.pointerId);
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, pan: event.button === 2 };
    canvas.dataset.dragging = "";
  });
  canvas.addEventListener("pointermove", (event) => {
    if (!available() || drag?.id !== event.pointerId) return;
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
    drag.x = event.clientX;
    drag.y = event.clientY;
    if (drag.pan || event.shiftKey) pan(dx, dy);
    else orbit(dx * .008, -dy * .004);
    refresh();
  });
  canvas.addEventListener("lostpointercapture", () => {
    drag = null;
    delete canvas.dataset.dragging;
  });
  canvas.addEventListener("contextmenu", (event) => {
    if (available()) event.preventDefault();
  });
  canvas.addEventListener("wheel", (event) => {
    if (!available() || event.ctrlKey || !event.deltaY) return;
    event.preventDefault();
    setCircuitZoom(circuitZoom - Math.sign(event.deltaY));
  }, { passive: false });
  canvas.addEventListener("keydown", (event) => {
    if (!available() || event.altKey || event.ctrlKey || event.metaKey) return;
    switch (event.key.toLowerCase()) {
      case "arrowleft": orbit(-.12, 0); break;
      case "arrowright": orbit(.12, 0); break;
      case "arrowup": orbit(0, .07); break;
      case "arrowdown": orbit(0, -.07); break;
      case "w": pan(0, 26); break;
      case "a": pan(26, 0); break;
      case "s": pan(0, -26); break;
      case "d": pan(-26, 0); break;
      case "+": case "=": setCircuitZoom(circuitZoom + 1); break;
      case "-": setCircuitZoom(circuitZoom - 1); break;
      case "home": resetCircuitOverview(); setCircuitZoom(0); break;
      default: return;
    }
    event.preventDefault();
    refresh();
  });
}

function setCircuitZoom(step) {
  circuitZoom = clamp(step, 0, circuitCamera.startsWith("cockpit-") ? 2 : MAX_CIRCUIT_ZOOM);
  redrawCircuitMap();
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

function circuitAngleDelta(from, to) {
  return Math.atan2(Math.sin(to - from), Math.cos(to - from));
}

function circuitHeading(samples, time) {
  const vector = (radius) => {
    const from = circuitLocation(samples, time - radius, 1800);
    const to = circuitLocation(samples, time + radius, 1800);
    if (!from || !to) return null;
    const dx = to[2] - from[2], dy = to[1] - from[1];
    return Math.hypot(dx, dy) >= 1.5 ? Math.atan2(dy, dx) : null;
  };
  const local = vector(320);
  const wider = vector(720);
  return local === null || wider === null ? local ?? wider
    : local + .45 * circuitAngleDelta(local, wider);
}

let circuitMotion = { time: null, headings: new Map(), chase: null };

function resetCircuitMotion() {
  circuitMotion = { time: null, headings: new Map(), chase: null };
}

function dampCircuitHeadings(poses, route, time) {
  const elapsed = time - (circuitMotion.time ?? time);
  const continuous = circuitMotion.time !== null && elapsed >= 0 && elapsed <= 1100;
  const previous = continuous ? circuitMotion.headings : new Map();
  const blend = 1 - Math.exp(-elapsed / 140);
  circuitMotion.time = time;
  circuitMotion.headings = new Map();
  return poses.map((pose) => {
    const before = previous.get(pose.code);
    const target = pose.heading ?? before ?? (route ? circuitTrackTangent(route, pose.x, pose.y)?.heading : null) ?? 0;
    const heading = before === undefined ? target : before + blend * circuitAngleDelta(before, target);
    circuitMotion.headings.set(pose.code, heading);
    return { ...pose, heading };
  });
}

function circuitChasePose(driver, time, units) {
  const before = circuitMotion.chase;
  const elapsed = time - (before?.time ?? time);
  const fresh = before?.code !== driver.code || elapsed < 0 || elapsed > 1100;
  const blend = fresh ? 1 : 1 - Math.exp(-elapsed / 210);
  const x = fresh ? driver.x : before.x + (driver.x - before.x) * blend;
  const y = fresh ? driver.y : before.y + (driver.y - before.y) * blend;
  const dx = x - driver.x, dy = y - driver.y;
  // Keep the target close enough to the centre of the chase view at racing speeds.
  const limit = Math.min(1, 1.4 * units / (Math.hypot(dx, dy) || 1));
  const heading = fresh ? driver.heading : before.heading + blend * circuitAngleDelta(before.heading, driver.heading);
  circuitMotion.chase = { code: driver.code, time, x: driver.x + dx * limit, y: driver.y + dy * limit, heading };
  return circuitMotion.chase;
}

const CIRCUIT_LAUNCH_MS = 8000;

function circuitLaunchPose(slot, samples, transform, start, time) {
  const origin = circuitLocation(samples, start, 2500);
  const current = circuitLocation(samples, time);
  if (!origin || !current || time <= start) return slot;
  const [startX, startY] = mapPoint(origin, transform);
  const [x, y] = mapPoint(current, transform);
  const t = clamp((time - start - 1500) / (CIRCUIT_LAUNCH_MS - 1500), 0, 1);
  const fade = t * t * (3 - 2 * t);
  const heading = circuitHeading(samples, time) ?? slot.heading;
  const turn = circuitAngleDelta(slot.heading, heading);
  return { x: x + (slot.x - startX) * (1 - fade), y: y + (slot.y - startY) * (1 - fade),
    heading: slot.heading + turn * fade };
}

function drawCircuitScene(poses, openingGrid) {
  const shape = circuitDisplayShape(race);
  text("circuit-title", (race.circuit || race.official.circuit)
    + (shape?.estimated ? " · Estimasi Live" : " · GPS"));
  const canvas = $("circuit-scene");
  const visible = !mobileLayout.matches && document.body.dataset.view === "circuit";
  canvas.hidden = !visible;
  const overview = circuitCamera === "overview";
  const daylight = circuitDaylight(race, state.time);
  const interactive = visible && overview && Boolean(shape?.points.length);
  canvas.tabIndex = interactive ? 0 : -1;
  $("circuit-map-help").hidden = !interactive;
  const status = $("circuit-scene-status");
  status.hidden = !visible || Boolean(shape && poses.some(({ key }) => key === "a") && poses.some(({ key }) => key === "b"));
  const controls = $("circuit-camera");
  controls.hidden = !visible;
  $("circuit-duel").hidden = !visible || !state.battle;
  if (!visible) return;
  // Circuit GPS positions are in decimetres.
  const unitsPerMetre = (shape?.transform[2] ?? 0) * 10;
  const units = openingGrid?.schematic ? openingGrid.units : unitsPerMetre;
  const route = shape?.points.length && smoothCircuitRoute(shape.points);
  const headings = dampCircuitHeadings(poses, openingGrid?.schematic ? null : route, state.time);
  const cars = separateCircuitCars(headings, units);
  if (state.battle) updateCircuitDuel();
  const cockpit = circuitCamera.startsWith("cockpit-");
  for (const button of controls.querySelectorAll("button[data-camera]")) {
    const key = button.dataset.camera;
    const driver = state.battle?.[key.replace("cockpit-", "")];
    if (key !== "overview") {
      button.disabled = !driver;
      const label = `Cockpit ${driver?.code ?? key.at(-1).toUpperCase()}`;
      if (button.textContent !== label) button.textContent = label;
    }
    button.setAttribute("aria-pressed", String(key === circuitCamera));
  }
  const followed = cars.find((car) => car.key === circuitCamera.replace("cockpit-", ""));
  const cockpitReady = cockpit && Boolean(followed && shape?.points.length);
  if (cockpit && !cockpitReady) status.hidden = false;
  if (openingGrid && (openingGrid.schematic || !cars.length)) status.hidden = false;
  const zoom = 2 ** (circuitZoom / 2);
  text("circuit-zoom-readout", `${Number(zoom.toFixed(1))}×`);
  $("circuit-zoom-out").disabled = !shape || circuitZoom === 0;
  $("circuit-zoom-in").disabled = !shape || circuitZoom === (cockpit ? 2 : MAX_CIRCUIT_ZOOM);
  const reset = $("circuit-zoom-reset");
  reset.disabled = !shape || !(overview ? circuitOverviewAdjusted() : circuitZoom > 0);
  text("circuit-zoom-reset", overview ? "Reset view" : "Reset zoom");
  text("circuit-scene-status", openingGrid && !cars.length ? "Starting order unavailable"
    : openingGrid?.schematic ? "Starting grid · circuit GPS trace unavailable"
    : !shape ? "Circuit GPS trace unavailable"
    : cockpit && !cockpitReady ? "Cockpit waiting for GPS"
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
  if (cockpitReady && unitsPerMetre && !openingGrid?.schematic) {
    drawCircuitCockpit(ctx, width, height, followed, cars, route, unitsPerMetre, zoom, daylight);
    return;
  }
  if (openingGrid && ((overview && !circuitOverviewAdjusted()) || openingGrid.schematic)) {
    drawCircuitStartOverview(ctx, width, height, openingGrid, cars, openingGrid.units, daylight);
    return;
  }
  const scale = Math.min(width / 345, height / 167) * zoom;
  const { yaw, pitch, panX, panY } = overview ? circuitOverview : defaultCircuitOverview;
  const cosine = Math.cos(yaw), sine = Math.sin(yaw);
  // Map the GPS plane into a pitched camera. The depth below the track is decorative.
  const project = (x, y, elevation = 0) => {
    const dx = x - 210, dy = y - 111;
    const across = dx * cosine + dy * sine;
    const depth = dy * cosine - dx * sine;
    const perspective = 1 / Math.max(.48, 1 - depth / 440);
    return [width * (.5 + panX) + across * perspective * scale,
      height * (.51 + panY) + (depth * pitch - elevation) * perspective * scale];
  };
  project.depth = (x, y) => y * cosine - x * sine;
  const path = (points, elevation) => {
    ctx.beginPath();
    points.forEach(([x, y], index) => {
      const point = project(x, y, elevation);
      if (index) ctx.lineTo(...point);
      else ctx.moveTo(...point);
    });
  };
  const sky = ctx.createLinearGradient(0, 0, 0, height);
  sky.addColorStop(0, daylight.overviewTop);
  sky.addColorStop(1, daylight.ground);
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
  if (!shape?.points.length) return;
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
  const grid = circuitGrid(route, unitsPerMetre);
  for (const { corners, color } of grid.markings) {
    path(corners, 0);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
  }
  const orderedCars = [...cars].sort((a, b) => project.depth(a.x, a.y) - project.depth(b.x, b.y));
  const useMarkers = circuitCamera === "overview" && 5.25 * unitsPerMetre * scale < 7;
  const carMargin = Math.max(5, 4 * unitsPerMetre * scale / .48);
  for (const { x, y, heading, color, key } of orderedCars) {
    const [screenX, screenY] = project(x, y);
    if (screenX < -carMargin || screenX > width + carMargin ||
        screenY < -carMargin || screenY > height + carMargin) continue;
    if (useMarkers) {
      ctx.beginPath();
      ctx.arc(screenX, screenY, key ? 3.5 : 2.5, 0, 2 * Math.PI);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = key ? "#fff" : "#18212a";
      ctx.stroke();
    } else {
      drawCircuitCar(ctx, project, x, y, heading, color, unitsPerMetre);
    }
  }
  drawCircuitDriverPins(ctx, [...orderedCars].reverse(), width, height, project, unitsPerMetre);
}

function drawCircuitStartOverview(ctx, width, height, grid, cars, units, daylight) {
  const first = grid.slots[0], last = grid.slots.at(-1);
  const dx = first.x - last.x, dy = first.y - last.y;
  const length = Math.hypot(dx, dy);
  if (!length) return;
  const horizontal = (x, y) => ((x - last.x) * dx + (y - last.y) * dy) / length;
  const scale = (width - 64) / (length + 12 * units);
  const centre = height / 2;
  const project = (x, y, z = 0) => [
    32 + (horizontal(x, y) + 6 * units) * scale,
    centre + ((y - last.y) * dx - (x - last.x) * dy) / length * scale - z * .45 * scale,
  ];
  project.depth = (x, y) => project(x, y)[1];

  ctx.fillStyle = daylight.ground;
  ctx.fillRect(0, 0, width, height);
  const polygon = (points, color) => {
    ctx.beginPath();
    points.forEach((point, index) => index ? ctx.lineTo(...point) : ctx.moveTo(...point));
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
  };
  for (const [edge, color] of [[6, "#aab9c3"], [5.8, "#303943"]]) {
    polygon([...grid.road.map(({ left }) => project(...left(edge))),
      ...grid.road.slice().reverse().map(({ right }) => project(...right(edge)))], color);
  }
  for (const { corners, color } of grid.markings) polygon(corners.map((point) => project(...point)), color);
  for (const car of cars) drawCircuitCar(ctx, project, car.x, car.y, car.heading, car.color, units);

  const entrants = new Map(cars.map((car) => [car.gridPosition, car]));
  const positionSize = Math.min(14, Math.max(9, Math.floor(width / 42)));
  const detailSize = Math.min(11, Math.max(8, positionSize - 2));
  const positionFont = `700 ${positionSize}px "Formula One", Arial, sans-serif`;
  const detailFont = `700 ${detailSize}px "Formula One", Arial, sans-serif`;
  const lineHeight = detailSize + 3;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.strokeStyle = "#8195a3";
  ctx.lineWidth = 1;
  for (const [index, slot] of grid.slots.entries()) {
    const [x, y] = project(...slot.labelAnchor);
    const row = index % 2;
    const column = Math.floor(index / 2);
    const columns = Math.ceil((grid.slots.length - row) / 2);
    const labelX = width - 24 - column * (width - 48) / Math.max(1, columns - 1);
    const labelY = centre + (row ? -1 : 1) * Math.min(74, height / 3) - (row ? 2 * lineHeight : 0);
    const labelWidth = Math.min(44, (width - 48) / Math.max(1, columns - 1) - 4);
    const car = entrants.get(index + 1);
    const logo = car && circuitTeamLogo(car.team);
    const badgeWidth = Math.min(32, labelWidth);
    const badgeHeight = detailSize + 8;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(labelX, labelY + (row ? 2 * lineHeight + badgeHeight / 2 + 3 : -8));
    ctx.stroke();
    ctx.font = positionFont;
    ctx.fillStyle = "#fff";
    ctx.fillText(slot.label, labelX, labelY, labelWidth);
    ctx.font = detailFont;
    ctx.fillStyle = "#d9e4eb";
    if (cars.length) ctx.fillText(car?.code ?? "EMPTY", labelX, labelY + lineHeight, labelWidth);
    if (logo) {
      const badgeY = labelY + 2 * lineHeight;
      ctx.beginPath();
      ctx.roundRect(labelX - badgeWidth / 2, badgeY - badgeHeight / 2, badgeWidth, badgeHeight, 4);
      ctx.fillStyle = car.color;
      ctx.fill();
      const logoScale = Math.min((badgeWidth - 6) / logo.naturalWidth, (badgeHeight - 4) / logo.naturalHeight);
      const logoWidth = logo.naturalWidth * logoScale;
      const logoHeight = logo.naturalHeight * logoScale;
      ctx.drawImage(logo, labelX - logoWidth / 2, badgeY - logoHeight / 2, logoWidth, logoHeight);
    }
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

function drawCircuitCockpit(ctx, width, height, driver, cars, route, units, zoom, daylight) {
  const chasePose = circuitChasePose(driver, state.time, units);
  const { heading } = chasePose;
  const cos = Math.cos(heading), sin = Math.sin(heading);
  const focal = Math.min(width * .65, height * 1.23);
  const chase = 10 / zoom;
  const eyeHeight = 2.6;
  const horizon = height * .29;
  const near = 1.25;
  // Project around the damped camera target in metres.
  const camera = (x, y, elevation = 0) => {
    const dx = (x - chasePose.x) / units, dy = (y - chasePose.y) / units;
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
  sky.addColorStop(0, daylight.sky);
  sky.addColorStop(.65, daylight.middle);
  sky.addColorStop(1, daylight.horizon);
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, width, horizon);
  ctx.fillStyle = daylight.ground;
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
  const grid = circuitGrid(route, units);
  for (const { corners, color } of grid.markings) {
    polygon(corners.map(([x, y]) => camera(x, y)), color);
  }
  const projectCar = (x, y, z) => screen(camera(x, y, z));
  projectCar.depth = (x, y) => -camera(x, y)[2];
  const visibleCars = cars.map((car) => ({ car, cameraPoint: camera(car.x, car.y) }))
    .filter(({ cameraPoint: [across, , depth] }) =>
      depth >= near + 3 && Math.abs(across) <= width / 2 * depth / focal + 3)
    .sort((a, b) => b.cameraPoint[2] - a.cameraPoint[2]);
  for (const { car } of visibleCars) {
    drawCircuitCar(ctx, projectCar, car.x, car.y, car.heading ?? heading, car.color, units);
  }
  drawCircuitDriverPins(ctx, visibleCars.map(({ car }) => car).reverse(), width, height, projectCar, units);
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

const circuitGridCache = new WeakMap();
const CIRCUIT_GRID_SLOTS = 22;
const schematicGridRoute = [[190, 0], [190, 30], [0, 30], [0, 0]];

function circuitOpeningGrid(shape) {
  if (shape?.points.length) {
    const grid = circuitGrid(smoothCircuitRoute(shape.points), shape.transform[2] * 10);
    if (grid.slots.length === CIRCUIT_GRID_SLOTS) return grid;
  }
  return { ...circuitGrid(schematicGridRoute, 1), schematic: true };
}

function circuitGrid(route, units) {
  const cached = circuitGridCache.get(route);
  if (cached?.units === units) return cached;
  const grid = { units, markings: [], slots: [], road: [] };
  if (!(units > 0) || route.length < 2) return grid;
  const firstSlot = 8, spacing = 8, boxLength = 2.4;
  const carCenterOffset = 2.975;
  const gridLength = firstSlot + (CIRCUIT_GRID_SLOTS - 1) * spacing + carCenterOffset;
  // Walk backwards from the start line so each slot follows the local road.
  const series = [[0, ...route[0]]];
  for (let i = route.length - 1; i > 0 && series.at(-1)[0] < gridLength; i--) {
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
  if (series.length < 2) return grid;
  const paint = (back, length, left, right) => {
    if (series.at(-1)[0] < back + length) return;
    grid.markings.push({ corners: [point(back, left), point(back, right),
      point(back + length, right), point(back + length, left)], color: "#edf1ef" });
  };
  const roadEnd = Math.min(gridLength, series.at(-1)[0]);
  for (const [distance] of series) {
    const back = Math.min(distance, roadEnd);
    grid.road.push({ left: (edge) => point(back, -edge), right: (edge) => point(back, edge) });
    if (back === roadEnd) break;
  }
  paint(0, .35, -5.25, 5.25);
  for (let slot = 0; slot < CIRCUIT_GRID_SLOTS; slot++) {
    const back = firstSlot + slot * spacing;
    if (back + carCenterOffset > series.at(-1)[0]) break;
    const side = slot % 2 ? 2.8 : -2.8;
    paint(back, .22, side - 1.1, side + 1.1);
    paint(back, boxLength, side - 1.1, side - .92);
    paint(back, boxLength, side + .92, side + 1.1);
    const [frontX, frontY] = point(back + .35, side);
    const [x, y] = point(back + carCenterOffset, side);
    grid.slots.push({ x, y, heading: Math.atan2(frontY - y, frontX - x),
      label: `P${slot + 1}`, labelAnchor: point(back - .8, side) });
  }
  circuitGridCache.set(route, grid);
  return grid;
}

function drawCircuitDriverPins(ctx, cars, width, height, project, units) {
  ctx.save();
  ctx.font = '700 10px "Formula One", Arial, sans-serif';
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.lineWidth = 1;
  const occupied = [];
  const priority = [...cars].sort((a, b) => Number(Boolean(b.key)) - Number(Boolean(a.key)));
  for (const car of priority) {
    const [x, y] = project(car.x, car.y, 1.2 * units);
    if (!car.code || x < 0 || x > width || y < 22 || y > height) continue;
    const logo = circuitTeamLogo(car.team);
    const badgeWidth = ctx.measureText(car.code).width + (logo ? 27 : 12);
    const left = clamp(x - badgeWidth / 2, 2, width - badgeWidth - 2);
    const right = left + badgeWidth;
    const top = [22, 42, 62].map((offset) => y - offset).find((candidate) => candidate >= 2
      && !occupied.some(([px, py, end]) => Math.abs(candidate - py) < 20 && right + 3 > px && left - 3 < end));
    if (top === undefined) continue;
    occupied.push([left, top, right]);

    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(clamp(x, left + 4, right - 4), top + 17);
    ctx.strokeStyle = car.color;
    ctx.stroke();
    ctx.beginPath();
    ctx.roundRect(left, top, badgeWidth, 17, 4);
    ctx.fillStyle = "#111820";
    ctx.fill();
    ctx.stroke();
    if (logo) {
      const ratio = Math.min(13 / logo.naturalWidth, 11 / logo.naturalHeight);
      const logoWidth = logo.naturalWidth * ratio, logoHeight = logo.naturalHeight * ratio;
      ctx.drawImage(logo, left + 11 - logoWidth / 2, top + (17 - logoHeight) / 2, logoWidth, logoHeight);
    }
    ctx.fillStyle = "#fff";
    ctx.fillText(car.code, left + (logo ? 21 : 6), top + 8.5);
  }
  ctx.restore();
}

// Symmetric bounds of the rendered mesh, measured in metres.
const circuitCarHalfLength = 2.685;
const circuitCarHalfWidth = .951;

function circuitFootprintRadius(car, x, y, units) {
  return units * (circuitCarHalfLength * Math.abs(x * car.fx + y * car.fy)
    + circuitCarHalfWidth * Math.abs(y * car.fx - x * car.fy));
}

function circuitFootprintContact(car, other, units) {
  const dx = car.x - other.x, dy = car.y - other.y;
  if (dx * dx + dy * dy >= (5.7 * units) ** 2) return null;

  const axes = [[car.fx, car.fy], [-car.fy, car.fx], [other.fx, other.fy], [-other.fy, other.fx]];
  let minimum, longitudinal;
  for (const [x, y] of axes) {
    const offset = dx * x + dy * y;
    const penetration = circuitFootprintRadius(car, x, y, units)
      + circuitFootprintRadius(other, x, y, units) - Math.abs(offset);
    if (penetration <= 0) return null;
    const direction = offset > 0 ? 1 : -1;
    const axis = { x: x * direction, y: y * direction, penetration };
    longitudinal ??= axis;
    if (!minimum || penetration < minimum.penetration) minimum = axis;
  }

  const side = Math.abs(dy * car.fx - dx * car.fy);
  const aligned = car.fx * other.fx + car.fy * other.fy > .94;
  // Same-lane cars keep their lane. Side-by-side cars separate along the nearest edge.
  return aligned && side < .7 * units ? longitudinal : minimum;
}

function circuitRoomAlong(pose, car, placed, units, clearance, vx, vy) {
  const blocked = [];
  for (const other of placed) {
    const dx = pose.x - other.x, dy = pose.y - other.y;
    const axes = [[car.fx, car.fy], [-car.fy, car.fx], [other.fx, other.fy], [-other.fy, other.fx]];
    let entry = 0, exit = Infinity;
    for (const [x, y] of axes) {
      const offset = dx * x + dy * y;
      const step = vx * x + vy * y;
      const radius = circuitFootprintRadius(car, x, y, units)
        + circuitFootprintRadius(other, x, y, units) + clearance;
      if (Math.abs(step) < 1e-9) {
        if (Math.abs(offset) >= radius) exit = -Infinity;
        continue;
      }
      const near = (-radius - offset) / step, far = (radius - offset) / step;
      entry = Math.max(entry, Math.min(near, far));
      exit = Math.min(exit, Math.max(near, far));
      if (exit <= entry) break;
    }
    if (exit > entry) blocked.push([entry, exit]);
  }
  let distance = 0;
  for (const [entry, exit] of blocked.sort((a, b) => a[0] - b[0])) {
    if (entry > distance) break;
    distance = Math.max(distance, exit);
  }
  return distance;
}

function separateCircuitCars(poses, units, route) {
  if (poses.length < 2 || !(units > 0)) return poses;
  const placed = [];
  const clearance = .035 * units;
  for (const pose of poses) {
    const heading = pose.heading ?? (route && circuitTrackTangent(route, pose.x, pose.y)?.heading) ?? 0;
    const car = { ...pose, heading, fx: Math.cos(heading), fy: Math.sin(heading) };
    let contact;
    for (let attempt = 0; attempt < 8; attempt++) {
      contact = null;
      for (const other of placed) {
        contact = circuitFootprintContact(car, other, units);
        if (contact) break;
      }
      if (!contact) break;
      car.x += contact.x * (contact.penetration + clearance);
      car.y += contact.y * (contact.penetration + clearance);
    }
    const correction = Math.hypot(car.x - pose.x, car.y - pose.y);
    if (contact || correction > 5.4 * units) {
      const directions = [[-car.fx, -car.fy, 1], [car.fx, car.fy, 1.5],
        [-car.fy, car.fx, 3], [car.fy, -car.fx, 3]];
      let cost = contact ? Infinity : correction;
      for (const [vx, vy, weight] of directions) {
        const distance = circuitRoomAlong(pose, car, placed, units, clearance, vx, vy);
        if (distance * weight >= cost) continue;
        cost = distance * weight;
        car.x = pose.x + vx * distance;
        car.y = pose.y + vy * distance;
      }
    }
    placed.push(car);
  }
  return placed;
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
