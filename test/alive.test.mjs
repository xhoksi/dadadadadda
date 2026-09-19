import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtempSync, readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { createApp, setServerClock } from "../src/app.js";
import { configureStore, resetStore, saveStore, getStore } from "../src/store.js";
import { formatInZone, allowedStyle } from "../src/content/alive.js";

let server;
let base;
let ownerToken;
let adminToken;
let clock;

before(async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "misa-alive-"));
  configureStore(path.join(dir, "store.json"));
  resetStore();
  saveStore();
  const app = createApp();
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
  const login = async (handle) =>
    (await (await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ handle }),
    })).json()).token;
  ownerToken = await login("nova");
  adminToken = await login("admin");
});

after(() => server?.close());

beforeEach(() => {
  resetStore();
  saveStore();
  clock = new Date("2026-01-15T12:00:00Z");
  setServerClock(() => clock);
});

function authed(token, p, opts = {}) {
  return fetch(`${base}${p}`, {
    ...opts,
    headers: {
      ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
      Authorization: `Bearer ${token}`,
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

async function setChild(token, key, on = true) {
  const r = await authed(token, `/api/me/pages/p1/features/${key}`, { method: "PATCH", body: { ownerEnabled: on } });
  assert.equal(r.status, 200);
}

async function enableAlive() {
  for (const key of ["alive", "alive_presence", "alive_clock", "alive_hits"]) await setChild(ownerToken, key, true);
  await authed(ownerToken, `/api/me/pages/p1/features/alive`, { method: "PATCH", body: { config: { timezone: "Europe/Berlin", locationLabel: "Berlin", hourFormat: "24h" } } });
  await authed(ownerToken, `/api/me/pages/p1/features/alive/publish`, { method: "POST", body: {} });
  await authed(ownerToken, `/api/me/pages/p1/features/alive_hits`, { method: "PATCH", body: { config: { counterStyle: "split-flap" } } });
  await authed(ownerToken, `/api/me/pages/p1/features/alive_hits/publish`, { method: "POST", body: {} });
}

function heartbeat(token, ua) {
  return fetch(`${base}/api/pages/nova/presence/heartbeat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(ua ? { "User-Agent": ua } : {}) },
    body: JSON.stringify({ token }),
  });
}

function hit(token, visibleMs, extraHeaders = {}) {
  return fetch(`${base}/api/pages/nova/hits`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...extraHeaders },
    body: JSON.stringify({ token, visibleMs }),
  });
}

test("10.1 tabs of one browser count once, inactive leases expire, previews/bots are excluded", async () => {
  await enableAlive();
  const one = await heartbeat("token-browser-1").then((r) => r.json());
  assert.equal(one.count, 1);
  const sameTab = await heartbeat("token-browser-1").then((r) => r.json());
  assert.equal(sameTab.count, 1, "a second tab of the same browser counts once");
  const two = await heartbeat("token-browser-2").then((r) => r.json());
  assert.equal(two.count, 2);

  // Owner previews and known bots never inflate the count.
  const preview = await fetch(`${base}/api/pages/nova/presence/heartbeat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ token: "token-owner-view" }),
  }).then((r) => r.json());
  assert.equal(preview.excluded, true);
  assert.equal(preview.count, 2);
  const bot = await heartbeat("token-googlebot", "Googlebot/2.1 (+http://www.google.com/bot.html)").then((r) => r.json());
  assert.equal(bot.excluded, true);
  assert.equal(bot.count, 2);

  // Leases expire after the limit; the endpoint reports the recorded count.
  clock = new Date("2026-01-15T12:01:01Z");
  const after = await (await fetch(`${base}/api/pages/nova/presence`)).json();
  assert.equal(after.count, 0, "inactive clients expire after the lease limit");
});

test("10.2 the clock follows the owner zone across DST; repeated hits do not double-count", async () => {
  assert.equal(formatInZone("2026-01-15T12:00:00Z", "Europe/Berlin", "24h"), "13:00");
  assert.equal(formatInZone("2026-07-15T12:00:00Z", "Europe/Berlin", "24h"), "14:00");

  await enableAlive();
  const page = await (await fetch(`${base}/api/pages/nova`)).json();
  assert.equal(page.alive.clock.timezone, "Europe/Berlin", "owner zone, never the visitor zone");
  assert.equal(page.alive.clock.time, "13:00");

  const first = await hit("hit-browser-1", 5000).then((r) => r.json());
  assert.equal(first.incremented, true);
  assert.equal(first.count, 1);
  const again = await hit("hit-browser-1", 9000).then((r) => r.json());
  assert.equal(again.incremented, false, "a repeated request does not increment twice");
  assert.equal(again.count, 1);

  const tooFast = await hit("hit-browser-2", 2000);
  assert.equal(tooFast.status, 409, "a visit before the visible dwell does not count");

  clock = new Date("2026-01-15T12:31:00Z");
  const later = await hit("hit-browser-1", 5000).then((r) => r.json());
  assert.equal(later.incremented, true, "a new visit counts after the window");
  assert.equal(later.count, 2);

  const corrected = await authed(adminToken, `/api/admin/features/alive_hits/correct`, { method: "POST", body: { pageId: "p1", count: 40, reason: "manual correction" } });
  assert.equal(corrected.status, 200);
  const view = await (await fetch(`${base}/api/pages/nova`)).json();
  assert.equal(view.alive.hits.count, 40);
});

test("10.3 child switches are independent; parent off stops heartbeats and hits; totals persist", async () => {
  await enableAlive();
  await setChild(ownerToken, "alive_presence", false);
  assert.equal((await heartbeat("token-x")).status, 404, "disabled presence stops accepting heartbeats");
  let page = await (await fetch(`${base}/api/pages/nova`)).json();
  assert.equal(page.alive.presence.available, false);
  assert.ok(page.alive.clock, "clock remains available");
  assert.ok(page.alive.hits, "hits remain available");

  await hit("token-hit", 5000);
  await setChild(ownerToken, "alive_hits", false);
  assert.equal((await hit("token-hit2", 5000)).status, 404, "disabled counter stops accepting activity");
  await setChild(ownerToken, "alive_hits", true);

  await setChild(ownerToken, "alive", false);
  page = await (await fetch(`${base}/api/pages/nova`)).json();
  assert.equal(page.alive, null, "parent off hides all three widgets");
  assert.equal((await heartbeat("token-y")).status, 404, "parent off stops heartbeats");
  assert.equal((await hit("token-y", 5000)).status, 404, "parent off stops hit collection");

  await setChild(ownerToken, "alive", true);
  page = await (await fetch(`${base}/api/pages/nova`)).json();
  assert.equal(page.alive.hits.count, 1, "cumulative hits are retained");
});

test("extra counter skins fall back to a permitted skin on the free plan", async () => {
  assert.equal(allowedStyle("free", "split-flap"), "odometer");
  assert.equal(allowedStyle("lifetime", "split-flap"), "split-flap");
  assert.equal(allowedStyle("free", "lcd"), "lcd");
});

test("10.1 UI: a presence outage shows Unavailable, never a fabricated zero", async () => {
  await enableAlive();
  const dom = new JSDOM("", { url: `${base}/p/nova`, pretendToBeVisual: true, runScripts: "outside-only" });
  dom.window.fetch = (input, opts) => {
    const url = new URL(input, base).toString();
    if (url.includes("/presence/heartbeat")) return Promise.reject(new Error("network down"));
    return fetch(url, opts);
  };
  dom.window.setInterval = () => 0;
  dom.window.setTimeout = () => 0;
  dom.window.document.documentElement.innerHTML = await fetch(`${base}/page.html`).then((r) => r.text());
  dom.window.eval(readFileSync(new URL("../public/page.js", import.meta.url), "utf8"));
  await new Promise((r) => setTimeout(r, 120));
  const doc = dom.window.document;
  assert.equal(doc.getElementById("alive").hidden, false);
  assert.equal(doc.getElementById("alive-presence").hidden, false);
  assert.equal(doc.getElementById("alive-presence-count").textContent, "Unavailable");
  assert.equal(doc.getElementById("alive-clock").hidden, false, "the clock widget stays available");
  assert.equal(doc.getElementById("alive-hits").hidden, false, "the counter widget stays available");
});
