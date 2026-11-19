"use strict";

// 2026 session offsets cover bundled recordings that predate offset metadata.
const circuitOffsetFallback = {
  melbourne: 11, shanghai: 8, suzuka: 9, sakhir: 3, jeddah: 3,
  miami: -4, montreal: -4, montecarlo: 2, catalunya: 2, spielberg: 2,
  silverstone: 1, spafrancorchamps: 2, hungaroring: 2, zandvoort: 2, monza: 2,
  madring: 2, baku: 4, kualalumpur: 8, singapore: 8, austin: -5,
  mexicocity: -6, interlagos: -3, lasvegas: -8, lusail: 3, yasmarinacircuit: 4,
};

const circuitNight = ["#080e27", "#151e3b", "#344567", "#151e28", "#080d19"];
const circuitDawn = ["#243e68", "#667c9d", "#f0b58e", "#25343d", "#162235"];
const circuitMorning = ["#377aaa", "#75b7d4", "#d9edf0", "#2c4149", "#172933"];
const circuitDay = ["#2569ad", "#65add4", "#d2edf7", "#2d444c", "#183145"];
const circuitAfternoon = ["#435d8b", "#859bad", "#f2c4a0", "#3b4148", "#202939"];
const circuitDusk = ["#252f59", "#70638a", "#ec9270", "#2a2e39", "#151a2c"];
const circuitDaylightKeys = [
  [0, circuitNight], [4.75, circuitNight], [6, circuitDawn], [7.5, circuitMorning],
  [10, circuitMorning], [11.5, circuitDay], [14.5, circuitDay],
  [16.5, circuitAfternoon], [17.5, circuitAfternoon], [18.4, circuitDusk],
  [19.5, circuitNight], [24, circuitNight],
];
const circuitDaylightCache = new WeakMap();

function circuitLocalOffset(recording) {
  const match = /^([+-]?)(\d{2}):(\d{2})(?::\d{2})?$/.exec(recording.gmtOffset ?? "");
  if (match) return (match[1] === "-" ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3]));
  const key = recording.circuit?.toLowerCase().replace(/[^a-z0-9]/g, "");
  return Number.isFinite(circuitOffsetFallback[key]) ? circuitOffsetFallback[key] * 60 : null;
}

function circuitDaylight(recording, time) {
  const offset = circuitLocalOffset(recording);
  const minute = Math.floor((Number.isFinite(time) ? time : recording.start) / 60000);
  const cached = circuitDaylightCache.get(recording);
  if (cached?.minute === minute && cached.offset === offset) return cached.palette;
  const hour = offset === null || !Number.isFinite(minute) ? 13 : (((minute + offset) % 1440 + 1440) % 1440) / 60;
  const next = circuitDaylightKeys.findIndex(([boundary]) => boundary > hour);
  const [from, a] = circuitDaylightKeys[next - 1];
  const [to, b] = circuitDaylightKeys[next];
  const t = (hour - from) / (to - from);
  const blend = t * t * (3 - 2 * t);
  const [sky, middle, horizon, ground, overviewTop] = a.map((color, index) => {
    const first = Number.parseInt(color.slice(1), 16), last = Number.parseInt(b[index].slice(1), 16);
    const channels = [16, 8, 0].map((shift) => {
      const start = (first >> shift) & 255, end = (last >> shift) & 255;
      return Math.round(start + (end - start) * blend);
    });
    return `rgb(${channels.join(",")})`;
  });
  const palette = { sky, middle, horizon, ground, overviewTop };
  circuitDaylightCache.set(recording, { minute, offset, palette });
  return palette;
}
