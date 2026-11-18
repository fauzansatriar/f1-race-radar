function car(key, driver) {
  const { color, team } = driver;
  const asset = teamCars[team?.toLowerCase().replace(/[^a-z0-9]/g, "")];
  if (asset) {
    return `<img class="radar-car team-car ${key}" id="car-${key}" style="--car:${color}" src="${asset}" alt="" aria-hidden="true" draggable="false" decoding="async">`;
  }
  const wheel = (x) => `
    <circle cx="${x}" cy="43" r="13" fill="#0e0f13" stroke="#121217" stroke-width="1.4"/>
    <circle cx="${x}" cy="43" r="10.2" fill="#18181b" stroke="#555661" stroke-width="1.15"/>
    <circle cx="${x}" cy="43" r="7.4" fill="#0e1014" stroke="currentColor" stroke-opacity=".72" stroke-width=".65"/>
    <path d="M${x - 5} 43h10m-5-5v10m-3.5-8.5 7 7m0-7-7 7" stroke="#6b6c74" stroke-width=".5"/>
    <circle cx="${x}" cy="43" r="2.3" fill="#878892"/><circle cx="${x}" cy="43" r="1.2" fill="#17181f"/>`;
  return `<svg class="radar-car ${key}" id="car-${key}" style="--car:${color}" viewBox="0 0 225 60" aria-hidden="true">
    <defs><linearGradient id="body-${key}" x2=".15" y2="1"><stop stop-color="#747680"/><stop offset=".26" stop-color="#2b2e35"/><stop offset=".62" stop-color="#171a20"/><stop offset="1" stop-color="#0c0d10"/></linearGradient></defs>
    <ellipse cx="114" cy="52" rx="102" ry="3" fill="#08090b" opacity=".7"/>
    <path d="m6 16 25 3-2 16-18 4L6 33Zm31 8 26 4 20-10 30-5 15 2 5 8 17 5 27 9 35 1 8 8h-30l-14 3H38L16 41l8-12Z" fill="url(#body-${key})" stroke="#0a0c10" stroke-width="2.2"/>
    <path d="m7 18 17 2 5 2-2 7H10Zm34 16c26 0 43-12 68-12l12 2-13 3-26 12 16 6H71l-24-6Zm101-6 31 11 21 1-12 3-19-1-31-8Z" fill="currentColor"/>
    <path d="m76 30 18-6 21-4 11 1 10 6-12 1-8-5-18 6Zm-30 10 18 4 23 2 21-2 10-3-13 8H49Z" fill="#95dae1" opacity=".8"/>
    <path d="m105 41 14-11 18-2 17 5-18 4-14 7Zm95 1 16 1 6 7h-20Z" fill="currentColor"/>
    <path d="M25 28c28 1 41-7 61-13l21-2 22 4m15 12 27 9 36 2M49 48h129" fill="none" stroke="#a9adb8" stroke-opacity=".59" stroke-width=".8"/>
    <path d="m118 23 3-6 11-2 7 6-7 5Z" fill="#111419" stroke="#818792" stroke-width=".65"/>
    <path d="m77 37 26-6-8 8-17 4Z" fill="#eff0f4" opacity=".14"/>
    ${wheel(34)}${wheel(185)}
  </svg>`;
}

function marker(key, label) {
  return `<g class="map-marker" id="marker-${key}" style="--marker:var(--team-${key})">
    <circle r="3.6"/><rect x="7" y="-13" width="64" height="17" rx="4"/>
    <text x="12" y="-1">${label}</text>
  </g>`;
}


function gauge(color, label) {
  const arc = "M8 45a38 38 0 0 1 76 0";
  return `<div class="gauge" role="img" aria-label="Unavailable ${label}">
    <svg viewBox="0 0 92 48" aria-hidden="true">
      <path d="${arc}" fill="none" stroke="#353842" stroke-width="5" stroke-linecap="round"/>
      <path class="gauge-fill" d="${arc}" pathLength="100" fill="none" stroke="${color}" stroke-width="5"
        stroke-linecap="round" stroke-dasharray="0 100"
        style="filter:drop-shadow(0 1px 6px color-mix(in srgb, ${color} 48%, transparent))"/>
    </svg><strong>—</strong><small>${label}</small>
  </div>`;
}

function gaugeParts(node) {
  return { node, fill: node.querySelector(".gauge-fill"), value: node.querySelector("strong"), previous: null };
}

function updateGauge(gauge, value, brakeSample) {
  const brake = brakeSample !== undefined;
  const available = Number.isFinite(value);
  const level = available ? clamp(value, 0, 100) : 0;
  const display = !available ? "—" : brake ? (brakeSample === 100 ? "ON" : "OFF") : Math.round(level) + "%";
  const arc = level.toFixed(2) + " 100";
  if (gauge.previous !== arc) {
    gauge.fill.setAttribute("stroke-dasharray", arc);
    gauge.previous = arc;
  }
  if (gauge.value.textContent !== display) {
    gauge.value.textContent = display;
    gauge.node.setAttribute("aria-label", (available ? display : "Unavailable") + (brake ? " brake" : " throttle"));
  }
}

function svg(width, height, label, content) {
  return `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="${label}">${content}</svg>`;
}

function line(x1, y1, x2, y2) {
  return `<line class="plot-grid" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;
}

function polyline(points, stroke, opacity = 1, width = 1.3) {
  return `<polyline class="plot-line" points="${points.map((point) => point.join(",")).join(" ")}"
    stroke="${stroke}" opacity="${opacity}" stroke-width="${width}"/>`;
}


function updateView() {
  const hash = location.hash.slice(1);
  const mode = ["data", "circuit"].includes(hash) ? hash : "radar";
  document.body.dataset.view = mode;
  document.querySelectorAll("[data-view-link]").forEach((link) => {
    if (link.dataset.viewLink === mode) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  const showingCircuit = mode === "circuit";
  $("circuit-slot").hidden = !showingCircuit;
  $("classification").hidden = mode !== "data";
  $(showingCircuit ? "circuit-slot" : "map-slot").append($("circuit-panel"));
}
