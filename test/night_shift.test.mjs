import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtempSync, readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { createApp, setServerClock } from "../src/app.js";
import { configureStore, resetStore, saveStore } from "../src/store.js";
import { localMinutes, isDaylight, nightActive, nextBoundaryUtc } from "../src/schedule.js";
import { nightHiddenBlocks } from "../src/content/blocks.js";
import { evaluateFeature } from "../src/policy.js";
import { getStore } from "../src/store.js";

let server;
let base;
let apiToken;

before(async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "misa-nightshift-"));
  configureStore(path.join(dir, "store.json"));
  resetStore();
  saveStore();
  server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  const port = server.address().port;
  base = `http://127.0.0.1:${port}`;
  const login = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ handle: "nova" }),
  });
  apiToken = (await login.json()).token;
});

after(() => server?.close());

beforeEach(() => {
  resetStore();
  saveStore();
  setServerClock(() => new Date());
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

async function feature(key, body) {
  const res = await authed(`/api/me/pages/p1/features/${key}`, { method: "PATCH", body });
  assert.equal(res.status, 200);
}

async function configureNight(cfg) {
  await feature("night_shift", { ownerEnabled: true });
  await feature("night_shift", { config: cfg });
  const pub = await authed(`/api/me/pages/p1/features/night_shift/publish`, { method: "POST", body: {} });
  assert.equal(pub.status, 200);
}

function at(iso) {
  setServerClock(() => new Date(iso));
}

async function setupNightOnlyLink(moveToBack = false) {
  await configureNight({ timezone: "UTC", start: "23:00", end: "05:00", message: "It's late where I am." });
  await authed("/api/me/pages/p1/blocks", {
    method: "PATCH",
    body: { blocks: moveToBack ? [{ id: "link", side: "back" }] : [{ id: "link", side: "front" }] },
  });
  await feature("night_shift", { config: { blocks: ["link"] } });
  await authed(`/api/me/pages/p1/features/night_shift/publish`, { method: "POST", body: {} });
}

async function publicPage() {
  return fetch(`${base}/api/pages/nova`).then((r) => r.json());
}

test("validate rejects equal start/end instead of treating it as all day", async () => {
  await feature("night_shift", { ownerEnabled: true });
  const res = await authed(`/api/me/pages/p1/features/night_shift`, {
    method: "PATCH",
    body: { config: { timezone: "UTC", start: "23:00", end: "23:00" } },
  });
  assert.equal(res.status, 422);
  const body = await res.json();
  assert.ok(body.errors.end, "end field explained");

  const pub = await authed(`/api/me/pages/p1/features/night_shift/publish`, { method: "POST", body: {} });
  const pubBody = await pub.json();
  assert.equal(pub.status, 400, "no draft exists after the rejected save");
  assert.equal(pubBody.message, "Nothing to publish. Save a draft first.");
});

test("03.1 morning window uses server time; hidden at 22:59/05:00, shown at 23:00/04:59", async () => {
  await setupNightOnlyLink();

  for (const [iso, expectVisible] of [
    ["2026-01-10T22:59:00Z", false],
    ["2026-01-10T23:00:00Z", true],
    ["2026-01-11T04:59:00Z", true],
    ["2026-01-11T05:00:00Z", false],
  ]) {
    at(iso);
    const page = await publicPage();
    const onFront = page.card.front.some((b) => b.id === "link");
    assert.equal(onFront, expectVisible, `${iso} visible expected ${expectVisible}`);
    assert.equal(page.night.active, expectVisible, `night.active mirrors visibility at ${iso}`);
    assert.equal(page.night.message, expectVisible ? "It's late where I am." : "", `${iso} message`);
    if (!expectVisible) {
      const raw = JSON.stringify(page);
      assert.ok(!raw.includes("night.example"), "no protected/asset URL leaks out of the window");
    }
  }
});

test("03.1 boundary state endpoint reports the next opening in owner time and UTC", async () => {
  await setupNightOnlyLink();
  at("2026-01-10T22:59:59Z");
  const res = await authed("/api/me/pages/p1/features/night_shift");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.state.active, false);
  assert.equal(body.state.localTime, "22:59");
  assert.equal(body.state.next.label, "opens");
  assert.ok(new Date(body.state.next.at).toISOString().startsWith("2026-01-10T23:00:00"), `next opening ${body.state.next.at}`);
});

test("03.2 daytime window and same-schedule semantics", async () => {
  await configureNight({ timezone: "UTC", start: "09:00", end: "17:00", message: "The office is open." });
  await authed("/api/me/pages/p1/blocks", { method: "PATCH", body: { blocks: [{ id: "link", side: "front" }] } });
  await feature("night_shift", { config: { blocks: ["link"] } });
  await authed(`/api/me/pages/p1/features/night_shift/publish`, { method: "POST", body: {} });

  for (const [iso, expectVisible] of [
    ["2026-01-10T08:59:00Z", false],
    ["2026-01-10T09:00:00Z", true],
    ["2026-01-10T16:59:00Z", true],
    ["2026-01-10T17:00:00Z", false],
  ]) {
    at(iso);
    const page = await publicPage();
    assert.equal(page.card.front.some((b) => b.id === "link"), expectVisible, iso);
  }
});

test("03.2 DST: skipped minutes never occur; repeated fall-back hour keeps identical eligibility", () => {
  const berlin = "Europe/Berlin";
  assert.equal(isDaylight(berlin, new Date("2026-03-29T00:30:00Z")), false, "before spring forward");
  assert.equal(isDaylight(berlin, new Date("2026-03-29T01:30:00Z")), true, "after spring forward");

  // 2026-03-29 spring forward: 02:xx CET local never exists.
  assert.equal(localMinutes(berlin, new Date("2026-03-29T01:15:00Z")), 3 * 60 + 15, "02:15 never appears");

  // 2026-10-25 fall back: 02:30 appears twice (CEST then CET), same value.
  const first = localMinutes(berlin, new Date("2026-10-25T00:30:00Z"));
  const second = localMinutes(berlin, new Date("2026-10-25T01:30:00Z"));
  assert.equal(first, second, "repeated 02:30 has identical wall-clock minute");
  assert.equal(nightActive(berlin, "02:30", "03:30", new Date("2026-10-25T00:30:00Z")), true);
  assert.equal(nightActive(berlin, "02:30", "03:30", new Date("2026-10-25T01:30:00Z")), true);

  const next = nextBoundaryUtc(berlin, "23:00", "05:00", new Date("2026-03-28T21:00:00Z"));
  assert.equal(next.label, "opens");
  assert.equal(next.at, "2026-03-28T22:00:00.000Z", "CET→CEST shift still opens at 23:00 Berlin");
});

test("03.2 visitors in any timezone see the same eligibility (owner zone + server time)", () => {
  const ny = "America/New_York";
  const instant = new Date("2026-01-10T04:00:00Z"); // 23:00 EST in NY
  assert.equal(localMinutes(ny, instant), 23 * 60, "owner-local carnder clock");
  assert.equal(nightActive(ny, "23:00", "05:00", instant), true);

  const store = getStore();
  const page = store.pages.p1;
  const nf = store.pageFeatures["p1:night_shift"];
  nf.ownerEnabled = true;
  nf.published = { timezone: ny, start: "23:00", end: "05:00", message: "hi", blocks: ["link"] };
  const hidden = nightHiddenBlocks(store, page, instant.toISOString());
  assert.equal(hidden.has("link"), false, "in-window blocks show even while it is daytime where the visitor is");
  nf.published = null;
  nf.ownerEnabled = false;
});

test("03.x when switched off every night-only block is hidden, content kept", async () => {
  await feature("night_shift", { ownerEnabled: true });
  await feature("night_shift", { config: { timezone: "UTC", start: "23:00", end: "05:00", blocks: ["link"] } });
  await feature("night_shift", { ownerEnabled: false });
  const pub = await authed(`/api/me/pages/p1/features/night_shift/publish`, { method: "POST", body: {} });
  assert.equal(pub.status, 200, "publishing while off keeps schedule & flags");

  at("2026-01-10T12:00:00Z");
  const page = await publicPage();
  assert.equal(evaluateFeature(getStore(), "p1", "night_shift", new Date().toISOString()).effectiveEnabled, false);
  assert.ok(!page.card.front.some((b) => b.id === "link"), "night-only link hidden while feature is off");
  assert.equal(page.night, null, "no night leak while disabled");

  const blocks = await authed("/api/me/pages/p1/blocks").then((r) => r.json());
  assert.ok(blocks.nightOnly.includes("link"), "schedule retained for the editor");
  assert.ok(blocks.nightHidden.includes("link"), "editor reports it as hidden now");
});

test("night-only link on the back is hidden while the feature is off", async () => {
  await feature("other_side", { ownerEnabled: true });
  await feature("other_side", { config: { backNote: "b", cornerLabel: "Peek", animation: "fold" } });
  await authed("/api/me/pages/p1/features/other_side/publish", { method: "POST", body: {} });

  await feature("night_shift", { ownerEnabled: true });
  await feature("night_shift", { config: { blocks: ["link"] } });
  await authed("/api/me/pages/p1/features/night_shift/publish", { method: "POST", body: {} });
  await authed("/api/me/pages/p1/blocks", { method: "PATCH", body: { blocks: [{ id: "link", side: "back" }] } });
  await feature("night_shift", { ownerEnabled: false });

  const page = await publicPage();
  assert.equal(page.card.flippable, true, "flip still on");
  assert.ok(!page.card.back.some((b) => b.id === "link"), "night-only back block hidden while off");
  assert.ok(!page.card.front.some((b) => b.id === "link"), "and never revealed on the front");
});

test("03.3 page UI: night note visible during the window, blocks hidden outside", async () => {
  await setupNightOnlyLink();
  at("2026-01-10T23:30:00Z");

  const dom = new JSDOM("", { url: `${base}/p/nova`, pretendToBeVisual: true, runScripts: "outside-only" });
  dom.window.fetch = (input, opts) => fetch(new URL(input, base).toString(), opts);
  dom.window.document.documentElement.innerHTML = await fetch(`${base}/page.html`).then((r) => r.text());
  const pageJs = readFileSync(new URL("../public/page.js", import.meta.url), "utf8");
  dom.window.eval(pageJs);
  await new Promise((r) => setTimeout(r, 80));

  const chips = (doc) => [...doc.querySelectorAll(".block-chip")].map((li) => li.textContent);
  const hasLink = (doc) => [...doc.querySelectorAll(".m-link")].some((a) => a.textContent === "My website");
  const doc = dom.window.document;
  assert.equal(doc.getElementById("night-note").hidden, false, "night message rendered");
  assert.equal(doc.getElementById("night-note").textContent, "It's late where I am.");
  assert.ok(hasLink(doc), "link visible inside the window");

  at("2026-01-10T06:00:00Z");
  const dom2 = new JSDOM("", { url: `${base}/p/nova`, pretendToBeVisual: true, runScripts: "outside-only" });
  dom2.window.fetch = (input, opts) => fetch(new URL(input, base).toString(), opts);
  dom2.window.document.documentElement.innerHTML = await fetch(`${base}/page.html`).then((r) => r.text());
  dom2.window.eval(pageJs);
  await new Promise((r) => setTimeout(r, 80));
  const doc2 = dom2.window.document;
  assert.equal(doc2.getElementById("night-note").hidden, true, "no night message outside the window");
  assert.ok(!hasLink(doc2), "link absent outside the window");
});