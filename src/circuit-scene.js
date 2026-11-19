function drawCircuitScene(cars) {
  const canvas = $("circuit-scene");
  const visible = !mobileLayout.matches && document.body.dataset.view === "circuit";
  canvas.hidden = !visible;
  const status = $("circuit-scene-status");
  status.hidden = !visible || Boolean(race.shape && cars.length === 2);
  if (!visible) return;
  text("circuit-scene-status", !race.shape ? "Circuit GPS trace unavailable"
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
  const scale = Math.min(width / 345, height / 167);
  // Map the GPS plane into a pitched camera. The depth below the track is decorative.
  const project = (x, y, elevation = 0) => {
    const dx = x - 210, dy = y - 111;
    const across = dx * .985 + dy * .174;
    const depth = dy * .985 - dx * .174;
    const perspective = 1 / (1 - depth / 440);
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
  ctx.lineJoin = ctx.lineCap = "round";
  for (const [ink, weight, elevation] of [
    ["#090d14", 16, -5], ["#354657", 14, -2],
    ["#bcc9d3", 10, 0], ["#27313b", 7, 0],
  ]) {
    path(race.shape.points, elevation);
    ctx.closePath();
    ctx.strokeStyle = ink;
    ctx.lineWidth = weight;
    ctx.stroke();
  }
  cars.forEach(({ x, y, color, code }, index) => {
    const [px, py] = project(x, y);
    if (px < 0 || px > width || py < 0 || py > height) return;
    const labelY = Math.max(16, py - 21 - index * 24);
    const labelX = Math.max(29, Math.min(width - 29, px + (index ? 26 : -26)));
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(px, py, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.lineTo(labelX, labelY);
    ctx.stroke();
    ctx.fillStyle = "#111820";
    ctx.fillRect(labelX - 26, labelY - 11, 52, 22);
    ctx.fillStyle = "#f4f7fa";
    ctx.font = '700 11px "Formula1", sans-serif';
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(code, labelX, labelY, 46);
  });
}
