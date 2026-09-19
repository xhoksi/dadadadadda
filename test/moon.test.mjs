import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtempSync, readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { createApp, setServerClock } from "../src/app.js";
import { configureStore, resetStore, saveStore } from "../src/store.js";
import { moonPhase } from "../src/content/moon.js";

let server;
let base;
let apiToken;

before(async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "misa-moon-"));
  configureStore(path.join(dir, "store.json"));
  resetStore();
  saveStore();
  server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
  apiToken = (await (await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ handle: "nova" }),
  })).json()).token;
});

after(() => server?.close());

beforeEach(() => {
  resetStore();
  saveStore();
  setServerClock(() => new Date("2026-01-10T09:00:00Z"));
});

function authed(p, opts = {}) {
  return fetch(`${base}${p}`, {
    ...opts,
    headers: {
      ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
      Authorization: `Bearer ${apiToken}`,
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

async function enableMoon(over = {}) {
  await authed(`/api/me/pages/p1/features/moon`, { method: "PATCH", body: { ownerEnabled: true } });
  const cfg = { corner: "top-right", size: "small", color: "#c22b35", showLabel: true, hemisphere: "north", ...over };
  const saved = await authed(`/api/me/pages/p1/features/moon`, { method: "PATCH", body: { config: cfg } });
  assert.equal(saved.status, 200);
  const pub = await authed(`/api/me/pages/p1/features/moon/publish`, { method: "POST", body: {} });
  assert.equal(pub.status, 200);
}

// 07.1 trusted ephemeris fixtures (timeanddate / online-siesta, UTC). Proposed
// tolerance is 2 percentage points.
const FIXTURES = [
  ["2026-01-03T10:02:00Z", 1.0, "Full moon"],
  ["2026-01-10T15:48:00Z", 0.5, "Last quarter"],
  ["2026-01-18T19:52:00Z", 0.0, "New moon"],
  ["2026-01-26T04:47:00Z", 0.5, "First quarter"],
  ["2026-02-01T22:09:00Z", 1.0, "Full moon"],
  ["2026-08-20T02:46:00Z", 0.5, "First quarter"],
  ["2026-08-21T17:19:00Z", 0.652, "Waxing gibbous"],
  ["2026-08-28T04:18:00Z", 1.0, "Full moon"],
  ["2026-08-29T20:23:00Z", 0.969, "Waning gibbous"],
  ["2026-09-01T11:00:00Z", 0.803, "Waning gibbous"],
  ["2026-09-07T10:23:00Z", 0.171, "Waning crescent"],
];

test("07.1 known phases match a trusted ephemeris within 2 percentage points", () => {
  for (const [iso, expected, name] of FIXTURES) {
    const p = moonPhase(iso, "north");
    assert.ok(Math.abs(p.illumination - expected) <= 0.02, `${iso} illumination ${p.illumination} vs ${expected}`);
    assert.equal(p.phase, name, `${iso} phase name`);
  }
});

test("07.2 the lit side follows waxing/waning and flips with the hemisphere", () => {
  const waxing = moonPhase("2026-08-21T17:19:00Z", "north");
  const waning = moonPhase("2026-09-01T11:00:00Z", "north");
  assert.equal(waxing.waxing, true);
  assert.equal(waxing.side, "right", "waxing is lit on the right in the northern convention");
  assert.equal(waning.waning, true);
  assert.equal(waning.side, "left", "waning is lit on the left in the northern convention");

  const waxingSouth = moonPhase("2026-08-21T17:19:00Z", "south");
  const waningSouth = moonPhase("2026-09-01T11:00:00Z", "south");
  assert.equal(waxingSouth.side, "left", "southern convention mirrors waxing");
  assert.equal(waningSouth.side, "right", "southern convention mirrors waning");

  // The same fraction can be waxing or waning; the shape must differ.
  assert.equal(waxing.illumination.toFixed(3), "0.651");
  assert.notEqual(waxing.side, waning.side);
});

test("07.3 no runtime image or astronomy-service fetch, and an accessible label is present", async () => {
  await enableMoon();
  setServerClock(() => new Date("2026-08-21T17:19:00Z"));

  const page = await (await fetch(`${base}/api/pages/nova`)).json();
  assert.ok(page.moon, "moon payload computed server-side");
  assert.match(page.moon.phase.label, /Waxing gibbous, 65% lit/);
  assert.ok(page.moon.phase.label.length > 0);

  const dom = new JSDOM("", { url: `${base}/p/nova`, pretendToBeVisual: true, runScripts: "outside-only" });
  dom.window.fetch = (input, opts) => fetch(new URL(input, base).toString(), opts);
  dom.window.setInterval = () => 0;
  dom.window.setTimeout = () => 0;
  dom.window.document.documentElement.innerHTML = await fetch(`${base}/page.html`).then((r) => r.text());
  dom.window.eval(readFileSync(new URL("../public/page.js", import.meta.url), "utf8"));
  await new Promise((r) => setTimeout(r, 80));
  const doc = dom.window.document;
  const svg = doc.querySelector("#moon-wrap svg");
  assert.ok(svg, "an SVG moon is drawn");
  assert.equal(svg.getAttribute("role"), "img");
  assert.match(svg.getAttribute("aria-label"), /Waxing gibbous/);
  assert.ok(doc.querySelector("#moon-wrap .moon-label").textContent.includes("Waxing gibbous"));
  assert.equal(doc.querySelectorAll("#moon-wrap img").length, 0, "no downloaded moon image");

  const source = readFileSync(new URL("../public/page.js", import.meta.url), "utf8");
  const external = source.match(/https?:\/\/[^\s"')]+/g) || [];
  assert.ok(!external.some((u) => /moon|ephemeris|astro|api\./i.test(u)), "page never calls a moon service");
});

test("when switched off the moon disappears, and style settings are retained", async () => {
  await enableMoon({ hemisphere: "south", color: "#123456" });
  await authed(`/api/me/pages/p1/features/moon`, { method: "PATCH", body: { ownerEnabled: false } });
  const page = await (await fetch(`${base}/api/pages/nova`)).json();
  assert.equal(page.moon, null, "no moon output while off");

  const detail = await authed(`/api/me/pages/p1/features/moon`).then((r) => r.json());
  assert.equal(detail.config.draft.hemisphere, "south", "style settings retained");
  assert.equal(detail.config.published.color, "#123456");
});
