let circuitCamera = "overview";
let circuitZoom = 0;
const MAX_CIRCUIT_ZOOM = 8;

function setCircuitZoom(step) {
  circuitZoom = clamp(step, 0, MAX_CIRCUIT_ZOOM);
  if (state.battle) renderMotion(true);
  else drawCircuitScene([]);
}
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

function circuitHeading(samples, time) {
  const from = interpolateSample(samples, time - 400, LOCATION, 3500, 1800);
  const to = interpolateSample(samples, time + 400, LOCATION, 3500, 1800);
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
  if (!visible) return;
  for (const button of controls.querySelectorAll("button[data-camera]")) {
    const key = button.dataset.camera;
    const driver = state.battle?.[key];
    if (key !== "overview") {
      button.disabled = !driver;
      const label = driver ? `Follow ${driver.code}` : `Follow ${key.toUpperCase()}`;
      if (button.textContent !== label) button.textContent = label;
    }
    button.setAttribute("aria-pressed", String(key === circuitCamera));
  }
  const followed = cars.find((car) => car.key === circuitCamera);
  const zoom = 2 ** (circuitZoom / 2);
  text("circuit-zoom-readout", `${Number(zoom.toFixed(1))}×`);
  $("circuit-zoom-out").disabled = !race.shape || circuitZoom === 0;
  $("circuit-zoom-in").disabled = !race.shape || circuitZoom === MAX_CIRCUIT_ZOOM;
  $("circuit-zoom-reset").disabled = !race.shape || circuitZoom === 0;
  text("circuit-scene-status", !race.shape ? "Circuit GPS trace unavailable"
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
  const route = race.shape.points;
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
  cars.forEach(({ x, y, color, code, heading, team }, index) => {
    const [px, py] = project(x, y);
    if (px < 0 || px > width || py < 0 || py > height) return;
    const labelY = Math.max(16, py - 21 - index * 24);
    const labelX = Math.max(39, Math.min(width - 39, px + (index ? 36 : -36)));
    drawCircuitCar(ctx, project, x, y, heading, color, 5.3 * unitsPerMetre / 11.6);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.lineTo(labelX, labelY);
    ctx.stroke();
    ctx.fillStyle = "#111820";
    const logo = circuitTeamLogo(team);
    const badgeWidth = logo ? 72 : 52;
    ctx.fillRect(labelX - badgeWidth / 2, labelY - 12, badgeWidth, 24);
    if (logo) {
      const factor = Math.min(21 / logo.naturalWidth, 16 / logo.naturalHeight);
      const logoWidth = logo.naturalWidth * factor, logoHeight = logo.naturalHeight * factor;
      ctx.drawImage(logo, labelX - 21 - logoWidth / 2, labelY - logoHeight / 2, logoWidth, logoHeight);
    }
    ctx.fillStyle = "#f4f7fa";
    ctx.font = `700 11px ${getComputedStyle(document.body).getPropertyValue("--font")}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(code, labelX + (logo ? 10 : 0), labelY, 46);
  });
}

function drawCircuitCar(ctx, project, x, y, heading, color, size) {
  const forwardX = Math.cos(heading ?? 0) * size;
  const forwardY = Math.sin(heading ?? 0) * size;
  function polygon(points, z, fill) {
    ctx.beginPath();
    points.forEach(([length, lateral], i) => {
      const point = project(x + length * forwardX - lateral * forwardY,
        y + length * forwardY + lateral * forwardX, z * size);
      if (i) ctx.lineTo(...point);
      else ctx.moveTo(...point);
    });
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
  }
  function box(front, rear, left, right, z, fill) {
    polygon([[front, left], [rear, left], [rear, right], [front, right]], z, fill);
  }
  box(5.9, -5.7, -2.5, 2.5, .1, "#10141b");
  for (const side of [-1, 1]) {
    const left = Math.min(side * 1.5, side * 2.5);
    const right = Math.max(side * 1.5, side * 2.5);
    box(-2.65, -4.3, left, right, .85, "#171a20");
    box(4.1, 2.45, left, right, .85, "#171a20");
  }
  polygon([[-4.8,-1.25], [-2,-1.65], [1.35,-1.65], [2.6,-.55], [5.6,-.37],
    [5.6,.37], [2.6,.55], [1.35,1.65], [-2,1.65], [-4.8,1.25]], .85, color);
  box(5.9, 4.55, -2.1, 2.1, .7, color);
  box(-4.25, -5.15, -2.12, 2.12, 1.75, color);
  box(.35, -1.22, -.64, .64, 1.25, "#151821");
  box(-1.35, -2.3, -.48, .48, 1.4, "#dce5ee");
}
