// The moon: a purely computed lunar phase rendered as a single SVG-drawn
// illuminated region over a dark disc. No image downloads and no runtime
// astronomy service; the calculation is deterministic for an injected UTC
// instant (Meeus, Astronomical Algorithms, truncated series).
//
// IMPORTANT: the illuminated fraction alone cannot pick the lit side — the same
// fraction occurs while waxing and while waning — so the elongation direction
// is carried separately and drives which limb is lit.

import { evaluateFeature } from "../policy.js";

const RAD = Math.PI / 180;

function sinDeg(x) {
  return Math.sin(x * RAD);
}

// Geocentric elongation of the Moon from the Sun, in degrees (0 = new, 180 = full).
function elongationDeg(d) {
  const D = 297.8501921 + 12.19074912 * d; // mean elongation
  const M = 357.5291092 + 0.98560028 * d; // Sun mean anomaly
  const Mp = 134.9633964 + 13.06499295 * d; // Moon mean anomaly
  const F = 93.272095 + 13.22935024 * d; // argument of latitude

  const moonLon =
    218.3164477 +
    13.17639648 * d +
    6.289 * sinDeg(Mp) +
    1.274 * sinDeg(2 * D - Mp) +
    0.658 * sinDeg(2 * D) +
    0.214 * sinDeg(2 * Mp) -
    0.186 * sinDeg(M) -
    0.114 * sinDeg(2 * F) +
    0.059 * sinDeg(2 * D - 2 * Mp) +
    0.057 * sinDeg(2 * D - M - Mp) +
    0.053 * sinDeg(2 * D + Mp) +
    0.046 * sinDeg(2 * D - M) +
    0.041 * sinDeg(Mp - M) -
    0.035 * sinDeg(D) -
    0.031 * sinDeg(Mp + M) -
    0.015 * sinDeg(2 * F - 2 * D) +
    0.011 * sinDeg(Mp - 4 * D);

  const sunLon = 280.46646 + 0.98564736 * d + 1.914602 * sinDeg(M) + 0.019993 * sinDeg(2 * M);
  return ((moonLon - sunLon) % 360 + 360) % 360;
}

// Names follow the illuminated fraction: crescent below 50%, gibbous above,
// with quarter/full/new kept to a narrow window around their exact instants.
const PHASES = [
  [11.25, "New moon"],
  [78.75, "Waxing crescent"],
  [101.25, "First quarter"],
  [168.75, "Waxing gibbous"],
  [191.25, "Full moon"],
  [258.75, "Waning gibbous"],
  [281.25, "Last quarter"],
  [348.75, "Waning crescent"],
];

export function phaseName(elongation) {
  for (const [limit, name] of PHASES) {
    if (elongation < limit) return name;
  }
  return "New moon";
}

// Return phase name, illumination fraction and the waxing/waning direction for
// an injected UTC instant. `hemisphere` only affects which limb reads as lit.
export function moonPhase(utcIso, hemisphere = "north") {
  const ms = Date.parse(utcIso);
  const d = ms / 86400000 - 10957.5; // days since J2000.0
  const elongation = elongationDeg(d);
  const illumination = (1 - Math.cos(elongation * RAD)) / 2;
  const waxing = elongation < 180;
  const north = hemisphere !== "south";
  // Northern convention: a waxing moon is lit on the right.
  const side = waxing === north ? "right" : "left";
  const pct = Math.round(illumination * 100);
  return {
    phase: phaseName(elongation),
    illumination: Number(illumination.toFixed(4)),
    percent: pct,
    waxing,
    waning: !waxing,
    direction: waxing ? "waxing" : "waning",
    hemisphere: north ? "north" : "south",
    side,
    elongation: Number(elongation.toFixed(3)),
    label: `${phaseName(elongation)}, ${pct}% lit`,
  };
}

// A single filled illuminated-region path over a dark disc. The lit side is
// chosen by the direction, so waxing and waning never share a shape.
export function moonPath(phase, radius = 40, cx = 50, cy = 50) {
  const r = radius;
  const k = phase.illumination;
  const right = phase.side === "right";
  const top = `${cx} ${cy - r}`;
  const bottom = `${cx} ${cy + r}`;
  // Outer limb: sweep 1 draws the right half when going top->bottom.
  const limbSweep = right ? 1 : 0;
  // Terminator ellipse's horizontal semi-axis; sign selects concave/convex.
  const rt = Math.abs(r * (1 - 2 * k));
  const termSweep = (phase.waxing ? 1 : 0) === (right ? 1 : 0) ? (k > 0.5 ? 1 : 0) : k > 0.5 ? 0 : 1;
  return `M ${top} A ${r} ${r} 0 0 ${limbSweep} ${bottom} A ${rt} ${r} 0 0 ${termSweep} ${top} Z`;
}

export function moonSvg(phase, { size = "small", color = "#c22b35" } = {}) {
  const px = size === "large" ? 64 : size === "medium" ? 48 : 34;
  return {
    viewBox: "0 0 100 100",
    width: px,
    height: px,
    color,
    dark: "#20202b",
    path: moonPath(phase, 46, 50, 50),
  };
}

export function isExposed(store, page, now) {
  return evaluateFeature(store, page.id, "moon", now).effectiveEnabled;
}

export function publicView(store, page, nowIso) {
  if (!isExposed(store, page, nowIso)) return null;
  const pf = store.pageFeatures[`${page.id}:moon`];
  const cfg = (pf && (pf.published || pf.draft)) || {};
  const hemisphere = cfg.hemisphere === "south" ? "south" : "north";
  const phase = moonPhase(nowIso, hemisphere);
  return {
    corner: cfg.corner || "top-right",
    size: cfg.size || "small",
    color: cfg.color || "#c22b35",
    showLabel: cfg.showLabel !== false,
    hemisphere,
    phase,
    svg: moonSvg(phase, { size: cfg.size || "small", color: cfg.color || "#c22b35" }),
  };
}
