import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtempSync, readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { createApp, setServerClock } from "../src/app.js";
import { configureStore, resetStore, saveStore } from "../src/store.js";

let server;
let base;
let apiToken;

before(async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "misa-capsule-"));
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

function at(iso) {
  setServerClock(() => new Date(iso));
}

const SECRET = "Meet me at the old pier at dusk.";

async function enableCapsule(over = {}) {
  await authed(`/api/me/pages/p1/features/time_capsule`, { method: "PATCH", body: { ownerEnabled: true } });
  const cfg = {
    label: "For later",
    body: SECRET,
    releaseDate: "2026-02-01",
    releaseTime: "00:00",
    timezone: "Europe/Berlin",
    ...over,
  };
  const saved = await authed(`/api/me/pages/p1/features/time_capsule`, { method: "PATCH", body: { config: cfg } });
  assert.equal(saved.status, 200, JSON.stringify(await saved.clone().json()));
  const pub = await authed(`/api/me/pages/p1/features/time_capsule/publish`, { method: "POST", body: {} });
  assert.equal(pub.status, 200, JSON.stringify(await pub.clone().json()));
}

function capsule() {
  return fetch(`${base}/api/pages/nova/capsule`);
}

test("05.1 before release no public output carries the body, regardless of the visitor clock", async () => {
  await enableCapsule();
  at("2026-01-31T22:59:59Z");
  const res = await capsule();
  assert.equal(res.status, 200);
  const view = await res.json();
  assert.equal(view.state, "sealed");
  assert.equal(view.body, undefined, "sealed payload has no body");
  assert.match(view.label, /For later/);
  assert.equal(view.releaseAt, "2026-01-31T23:00:00.000Z", "date-only default resolves to owner-local midnight");
  assert.ok(!JSON.stringify(view).includes("old pier"), "no fragment of the body leaks");
  const page = await (await fetch(`${base}/api/pages/nova`)).json();
  assert.ok(!JSON.stringify(page).includes("old pier"), "page hydration carries no body");
  assert.ok(!JSON.stringify(page).includes(SECRET));
});

test("05.2 the message is fetchable at the exact server release instant without any jobs", async () => {
  await enableCapsule();
  at("2026-01-31T22:59:59.999Z");
  assert.equal((await (await capsule()).json()).state, "sealed");
  at("2026-01-31T23:00:00.000Z");
  const open = await (await capsule()).json();
  assert.equal(open.state, "open");
  assert.equal(open.body, SECRET);
  assert.equal(open.serverNow, "2026-01-31T23:00:00.000Z");
});

test("05.3 DST validation rejects a nonexistent time and ambiguous repeats need an explicit offset", async () => {
  await authed(`/api/me/pages/p1/features/time_capsule`, { method: "PATCH", body: { ownerEnabled: true } });
  const gap = await authed(`/api/me/pages/p1/features/time_capsule`, {
    method: "PATCH",
    body: { config: { label: "x", body: "y", releaseDate: "2026-03-29", releaseTime: "02:30", timezone: "Europe/Berlin" } },
  });
  assert.equal(gap.status, 422);
  assert.match((await gap.json()).errors.releaseTime, /never occurs/i);

  const ambiguous = await authed(`/api/me/pages/p1/features/time_capsule`, {
    method: "PATCH",
    body: { config: { label: "x", body: "y", releaseDate: "2026-10-25", releaseTime: "02:30", timezone: "Europe/Berlin" } },
  });
  assert.equal(ambiguous.status, 422);
  assert.match((await ambiguous.json()).errors.releaseOffset, /twice|offset/i);

  const pinned = await authed(`/api/me/pages/p1/features/time_capsule`, {
    method: "PATCH",
    body: { config: { label: "x", body: "y", releaseDate: "2026-10-25", releaseTime: "02:30", timezone: "Europe/Berlin", releaseOffset: "+02:00" } },
  });
  assert.equal(pinned.status, 200);
  const pub = await authed(`/api/me/pages/p1/features/time_capsule/publish`, { method: "POST", body: {} });
  assert.equal(pub.status, 200);
  at("2026-10-25T00:30:00.000Z");
  const open = await (await capsule()).json();
  assert.equal(open.state, "open", "the pinned repeated time opened at the +02:00 instant");
});

test("05.3 reschedule before release moves the reveal; disabling across the boundary hides then shows the open state", async () => {
  await enableCapsule();
  const moved = await authed(`/api/me/pages/p1/features/time_capsule`, {
    method: "PATCH",
    body: { config: { label: "For later", body: SECRET, releaseDate: "2026-01-31", releaseTime: "18:00", timezone: "Europe/Berlin" } },
  });
  assert.equal(moved.status, 200);
  assert.equal((await authed(`/api/me/pages/p1/features/time_capsule/publish`, { method: "POST", body: {} })).status, 200);
  at("2026-01-31T16:59:59Z");
  assert.equal((await (await capsule()).json()).state, "sealed", "still sealed after reschedule");
  at("2026-01-31T17:00:00Z");
  assert.equal((await (await capsule()).json()).state, "open", "opened at the rescheduled instant");

  // Switch off while the release passes: hidden, retained release time.
  await authed(`/api/me/pages/p1/features/time_capsule`, { method: "PATCH", body: { ownerEnabled: false } });
  at("2026-02-05T00:00:00Z");
  assert.equal((await capsule()).status, 404, "hidden while disabled");
  await authed(`/api/me/pages/p1/features/time_capsule`, { method: "PATCH", body: { ownerEnabled: true } });
  const reenabled = await (await capsule()).json();
  assert.equal(reenabled.state, "open", "re-enabling after the retained release shows the open state");
  assert.equal(reenabled.releaseAt, "2026-01-31T17:00:00.000Z", "absolute release instant never moved");
});

test("a released capsule cannot be re-sealed and unpublishing hides future reads", async () => {
  await enableCapsule();
  at("2026-02-02T00:00:00Z");
  assert.equal((await (await capsule()).json()).state, "open");

  const reseal = await authed(`/api/me/pages/p1/features/time_capsule`, {
    method: "PATCH",
    body: { config: { label: "For later", body: SECRET, releaseDate: "2026-03-01", releaseTime: "00:00", timezone: "Europe/Berlin" } },
  });
  assert.equal(reseal.status, 200);
  const rejected = await authed(`/api/me/pages/p1/features/time_capsule/publish`, { method: "POST", body: {} });
  assert.equal(rejected.status, 409, "rescheduling into the future after release is refused");

  const unpub = await authed(`/api/me/pages/p1/features/time_capsule/unpublish`, { method: "POST", body: {} });
  assert.equal(unpub.status, 200);
  assert.equal((await capsule()).status, 404, "unpublished capsule is not readable");
});

async function renderPage() {
  const dom = new JSDOM("", { url: `${base}/p/nova`, pretendToBeVisual: true, runScripts: "outside-only" });
  dom.window.fetch = (input, opts) => fetch(new URL(input, base).toString(), opts);
  dom.window.setInterval = () => 0;
  dom.window.setTimeout = () => 0;
  dom.window.document.documentElement.innerHTML = await fetch(`${base}/page.html`).then((r) => r.text());
  dom.window.eval(readFileSync(new URL("../public/page.js", import.meta.url), "utf8"));
  await new Promise((r) => setTimeout(r, 80));
  return dom.window.document;
}

test("05.x page UI: a sealed capsule shows the wax seal and countdown, then the body at release", async () => {
  await enableCapsule();
  at("2026-01-20T00:00:00Z");
  const sealed = await renderPage();
  const card = sealed.getElementById("capsule-card");
  assert.equal(card.hidden, false, "capsule section visible");
  assert.equal(sealed.getElementById("capsule-sealed").hidden, false, "seal shown");
  assert.equal(sealed.getElementById("capsule-body").hidden, true, "body hidden while sealed");
  assert.match(sealed.getElementById("capsule-count").textContent, /Opens in/);
  assert.equal(sealed.getElementById("capsule-label").textContent, "For later");
  assert.ok(!sealed.body.textContent.includes("old pier"), "no body text in the DOM before release");

  at("2026-01-31T23:00:00Z");
  const open = await renderPage();
  assert.equal(open.getElementById("capsule-sealed").hidden, true, "seal replaced at release");
  assert.equal(open.getElementById("capsule-body").hidden, false, "message is visible");
  assert.equal(open.getElementById("capsule-body").textContent, SECRET);
});
