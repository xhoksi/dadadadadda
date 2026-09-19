import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtempSync, readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { createApp } from "../src/app.js";
import { configureStore, resetStore, saveStore } from "../src/store.js";
import { localMinutes, toHHMM, inWindow, parseHHMM } from "../src/schedule.js";

let server;
let base;
let apiToken;

before(async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "misa-otherside-"));
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

async function enableOtherSide(note = "You found the other side.", animation = "fold") {
  await feature("other_side", { ownerEnabled: true });
  await feature("other_side", { config: { backNote: note, cornerLabel: "Peek", animation } });
  const pub = await authed(`/api/me/pages/p1/features/other_side/publish`, { method: "POST", body: {} });
  assert.equal(pub.status, 200);
}

async function publicPage() {
  return fetch(`${base}/api/pages/nova`).then((r) => r.json());
}

test("schedule: window rules are start-inclusive and end-exclusive, overnight aware", () => {
  assert.equal(parseHHMM("23:00"), 23 * 60);
  assert.equal(parseHHMM("9:00"), null);
  assert.equal(inWindow("23:00", "05:00", 22 * 60), false);
  assert.equal(inWindow("23:00", "05:00", 23 * 60), true);
  assert.equal(inWindow("23:00", "05:00", 4 * 60 + 59), true);
  assert.equal(inWindow("23:00", "05:00", 5 * 60), false);
  assert.equal(inWindow("09:00", "17:00", 9 * 60), true);
  assert.equal(inWindow("09:00", "17:00", 17 * 60), false);
  assert.equal(inWindow("09:00", "09:00", 12 * 60), false, "equal start/end is never 'all day'");
  assert.equal(toHHMM(23 * 60 + 59), "23:59");
});

test("02.1 flip state is emitted; link moves between front and back by placement", async () => {
  await enableOtherSide();

  const on = await publicPage();
  assert.equal(on.card.flippable, true);
  assert.equal(on.card.cornerLabel, "Peek");
  assert.equal(on.card.note, "You found the other side.");
  assert.ok(on.card.front.some((b) => b.id === "link"), "link on front by default");
  assert.ok(!on.card.back.some((b) => b.id === "link"), "no link on back by default");

  const moved = await authed("/api/me/pages/p1/blocks", {
    method: "PATCH",
    body: { blocks: [{ id: "link", side: "back" }] },
  });
  assert.equal(moved.status, 200);

  const after = await publicPage();
  assert.ok(!after.card.front.some((b) => b.id === "link"), "link moved off front");
  assert.ok(after.card.back.some((b) => b.id === "link"), "link now on back");
});

test("02.1 other owner cannot read or edit the block layout", async () => {
  const luna = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ handle: "luna" }),
  }).then((r) => r.json());

  const blocked = await fetch(`${base}/api/me/pages/p1/blocks`, {
    headers: { Authorization: `Bearer ${luna.token}` },
  });
  assert.equal(blocked.status, 403);
});

test("back placement order is preserved on the public card", async () => {
  await enableOtherSide();
  await feature("ask_anything", { ownerEnabled: true });
  await feature("moon", { ownerEnabled: true });

  const moved = await authed("/api/me/pages/p1/blocks", {
    method: "PATCH",
    body: {
      blocks: [
        { id: "moon", side: "back" },
        { id: "ask_anything", side: "back" },
        { id: "link", side: "back" },
      ],
    },
  });
  assert.equal(moved.status, 200);

  const page = await publicPage();
  assert.deepEqual(page.card.back.map((b) => b.id), ["moon", "ask_anything", "link"], "placement order (not alphabetical)");
});

test("02.3 night-only block on the back is absent outside the window, present inside", async () => {
  await enableOtherSide();
  await authed("/api/me/pages/p1/blocks", { method: "PATCH", body: { blocks: [{ id: "link", side: "back" }] } });

  const tz = "Europe/Berlin";
  const nowMin = localMinutes(tz, new Date());
  // Build a window that does NOT contain now (the following two hours).
  const startHidden = toHHMM((nowMin + 60) % 1440);
  const endHidden = toHHMM((nowMin + 120) % 1440);

  await feature("night_shift", { ownerEnabled: true });
  await feature("night_shift", {
    config: { timezone: tz, start: startHidden, end: endHidden, message: "zzz", blocks: ["link"] },
  });
  await authed("/api/me/pages/p1/features/night_shift/publish", { method: "POST", body: {} });

  let page = await publicPage();
  assert.ok(!page.card.back.some((b) => b.id === "link"), "night-only link hidden outside its window");

  // A window that certainly contains now.
  const startVisible = toHHMM((nowMin - 60 + 1440) % 1440);
  const endVisible = toHHMM((nowMin + 60) % 1440);
  await feature("night_shift", { config: { timezone: tz, start: startVisible, end: endVisible, blocks: ["link"] } });
  await authed("/api/me/pages/p1/features/night_shift/publish", { method: "POST", body: {} });

  page = await publicPage();
  assert.ok(page.card.back.some((b) => b.id === "link"), "night-only link visible inside its window");
});

test("02.3 disabling the flip never reveals a night-hidden block on the front", async () => {
  await enableOtherSide();
  await authed("/api/me/pages/p1/blocks", { method: "PATCH", body: { blocks: [{ id: "link", side: "back" }] } });

  const tz = "Europe/Berlin";
  const nowMin = localMinutes(tz, new Date());
  const startHidden = toHHMM((nowMin + 60) % 1440);
  const endHidden = toHHMM((nowMin + 120) % 1440);

  await feature("night_shift", { ownerEnabled: true });
  await feature("night_shift", { config: { timezone: tz, start: startHidden, end: endHidden, blocks: ["link"] } });
  await authed("/api/me/pages/p1/features/night_shift/publish", { method: "POST", body: {} });

  await feature("other_side", { ownerEnabled: false });

  const page = await publicPage();
  assert.equal(page.card.flippable, false, "flip disabled");
  assert.ok(!page.card.front.some((b) => b.id === "link"), "night-only link not revealed on the front");
});

test("02.1 flip UI: corner flips the card both ways with focus management", async () => {
  await enableOtherSide("Careful now.");
  const dom = new JSDOM("", { url: `${base}/p/nova`, pretendToBeVisual: true, runScripts: "outside-only" });
  dom.window.fetch = (input, opts) => fetch(new URL(input, base).toString(), opts);
  dom.window.setInterval = () => 0;
  dom.window.setTimeout = () => 0;
  const html = await fetch(`${base}/page.html`).then((r) => r.text());
  dom.window.document.documentElement.innerHTML = html;
  const pageJs = readFileSync(new URL("../public/page.js", import.meta.url), "utf8");
  dom.window.eval(pageJs);
  await tick(80);

  const doc = dom.window.document;
  assert.equal(doc.getElementById("flip-corner").hidden, false, "corner control visible when flippable");

  doc.getElementById("flip-corner").click();
  assert.equal(doc.getElementById("card").classList.contains("flipped"), true, "flipped state on");
  assert.equal(doc.getElementById("back-note").textContent, "Careful now.");
  assert.equal(doc.activeElement.id, "back-to-front", "focus moves to the front control after flip");

  doc.getElementById("back-to-front").click();
  assert.equal(doc.getElementById("card").classList.contains("flipped"), false, "flipped state off");
  assert.equal(doc.activeElement.id, "flip-corner", "focus returns to the corner control");
});

function tick(ms) {
  return new Promise((r) => setTimeout(r, ms));
}