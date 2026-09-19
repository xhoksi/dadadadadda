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
let ownerToken;

before(async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "misa-chalk-"));
  configureStore(path.join(dir, "store.json"));
  resetStore();
  saveStore();
  server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
  ownerToken = (await (await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ handle: "nova" }),
  })).json()).token;
});

after(() => server?.close());

beforeEach(() => {
  resetStore();
  saveStore();
  setServerClock(() => new Date("2026-04-01T09:00:00Z"));
});

function authed(p, opts = {}) {
  return fetch(`${base}${p}`, {
    ...opts,
    headers: {
      ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
      Authorization: `Bearer ${ownerToken}`,
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

async function enableChalkboard(over = {}) {
  await authed(`/api/me/pages/p1/features/chalkboard`, { method: "PATCH", body: { ownerEnabled: true } });
  await authed(`/api/me/pages/p1/features/chalkboard`, {
    method: "PATCH",
    body: { config: { title: "Doodle wall", theme: "dark", gallerySize: 20, intakePaused: false, ...over } },
  });
  await authed(`/api/me/pages/p1/features/chalkboard/publish`, { method: "POST", body: {} });
}

function drawing(over = {}) {
  return { schemaVersion: 1, strokes: [{ points: [[0, 0], [0.5, 0.5], [1, 1]] }], description: "a line", ...over };
}

function submit(body) {
  return fetch(`${base}/api/pages/nova/drawings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function keepOne() {
  await submit(drawing({ description: "first" }));
  const board = await authed(`/api/me/pages/p1/features/chalkboard/board`).then((r) => r.json());
  const id = board.pending[0].id;
  const kept = await authed(`/api/me/pages/p1/features/chalkboard/records/${id}/keep`, { method: "POST", body: {} }).then((r) => r.json());
  return { id, kept };
}

test("12.1 touch, mouse and stylus strokes are normalized so a resize reproduces them", async () => {
  await enableChalkboard();
  const sent = [];
  const dom = new JSDOM("", { url: `${base}/p/nova`, pretendToBeVisual: true, runScripts: "outside-only" });
  dom.window.fetch = (input, opts) => {
    const url = new URL(input, base).toString();
    if (url.includes("/drawings")) {
      sent.push(JSON.parse(opts.body));
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ note: "queued" }) });
    }
    return fetch(url, opts);
  };
  dom.window.setInterval = () => 0;
  dom.window.setTimeout = () => 0;
  dom.window.HTMLCanvasElement.prototype.getContext = () => null;
  dom.window.document.documentElement.innerHTML = await fetch(`${base}/page.html`).then((r) => r.text());
  dom.window.eval(readFileSync(new URL("../public/page.js", import.meta.url), "utf8"));
  await new Promise((r) => setTimeout(r, 120));
  const doc = dom.window.document;
  const canvas = doc.getElementById("chalk-canvas");
  assert.equal(doc.getElementById("chalkboard").hidden, false);

  const rect = (w, h) => {
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: w, height: h, right: w, bottom: h });
  };
  const pointer = (type, x, y) => canvas.dispatchEvent(new dom.window.MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true }));

  rect(200, 120);
  pointer("pointerdown", 20, 12);
  pointer("pointermove", 120, 72);
  pointer("pointerup", 120, 72);
  doc.getElementById("chalk-form").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(sent.length, 1);
  const first = sent[0].strokes[0].points;
  assert.ok(Math.abs(first[0][0] - 0.1) < 1e-9 && Math.abs(first[0][1] - 0.1) < 1e-9);
  assert.ok(Math.abs(first[1][0] - 0.6) < 1e-9 && Math.abs(first[1][1] - 0.6) < 1e-9);

  // The same normalized shape is produced after a resize.
  rect(400, 240);
  pointer("pointerdown", 40, 24);
  pointer("pointermove", 240, 144);
  pointer("pointerup", 240, 144);
  doc.getElementById("chalk-form").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(sent[1].strokes[0].points, first, "resizing reproduces the same normalized strokes");

  // Undo removes one stroke; Clear removes all (payload then rejected client-side).
  pointer("pointerdown", 10, 10);
  pointer("pointerup", 10, 10);
  doc.getElementById("chalk-undo").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  pointer("pointerdown", 30, 30);
  pointer("pointerup", 30, 30);
  doc.getElementById("chalk-clear").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  doc.getElementById("chalk-form").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(sent.length, 2, "cleared board sends nothing");
  assert.match(doc.getElementById("chalk-status").textContent, /Draw something first/);
});

test("12.2 oversized, empty, malformed, nonfinite and image/SVG payloads are rejected", async () => {
  await enableChalkboard();
  const cases = {
    empty: { schemaVersion: 1, strokes: [] },
    tooManyStrokes: { schemaVersion: 1, strokes: Array.from({ length: 101 }, () => ({ points: [[0, 0], [0.1, 0.1]] })) },
    tooManyPoints: { schemaVersion: 1, strokes: [{ points: Array.from({ length: 10001 }, (_, i) => [(i % 100) / 100, (i % 7) / 10]) }] },
    oversizedPayload: { schemaVersion: 1, strokes: [{ points: Array.from({ length: 9000 }, (_, i) => [0.1234567890123456, (i % 97) / 100]) }] },
    malformed: { schemaVersion: 1, strokes: "abc" },
    nonfinite: { schemaVersion: 1, strokes: [{ points: [[null, 0]] }] },
    outOfRange: { schemaVersion: 1, strokes: [{ points: [[1.5, 0]] }] },
    rawSvg: { schemaVersion: 1, strokes: [{ points: [[0, 0]] }], svg: "<svg onload=alert(1)></svg>" },
    imageUpload: { schemaVersion: 1, strokes: [{ points: [[0, 0]] }], imageUrl: "https://evil.test/x.png" },
    unknownAttribute: { schemaVersion: 1, strokes: [{ points: [[0, 0]], fill: "#fff" }] },
    wrongSchema: { schemaVersion: 2, strokes: [{ points: [[0, 0]] }] },
  };
  for (const [name, body] of Object.entries(cases)) {
    const res = await submit(body);
    assert.equal(res.status, 422, `${name} must be rejected`);
    const data = await res.json();
    assert.ok(!JSON.stringify(data).includes("evil.test"));
  }
  const page = await (await fetch(`${base}/api/pages/nova`)).json();
  assert.equal(page.chalkboard.gallery.length, 0, "nothing invalid became public");
});

test("12.3 pending stays private; keeping/pinning is idempotent, capped and disable-gated", async () => {
  await enableChalkboard();
  await submit(drawing({ description: "hidden" }));
  let pub = await (await fetch(`${base}/api/pages/nova`)).json();
  assert.equal(pub.chalkboard.gallery.length, 0, "pending drawings never appear publicly");

  const board = await authed(`/api/me/pages/p1/features/chalkboard/board`).then((r) => r.json());
  assert.equal(board.counts.pending, 1);
  const id = board.pending[0].id;

  const pinBeforeKeep = await authed(`/api/me/pages/p1/features/chalkboard/records/${id}/pin`, { method: "POST", body: {} });
  assert.equal(pinBeforeKeep.status, 409, "only a kept drawing can be pinned");

  const kept = await authed(`/api/me/pages/p1/features/chalkboard/records/${id}/keep`, { method: "POST", body: {} }).then((r) => r.json());
  assert.equal(kept.status, "kept");
  const keptAgain = await authed(`/api/me/pages/p1/features/chalkboard/records/${id}/keep`, { method: "POST", body: {} }).then((r) => r.json());
  assert.equal(keptAgain.status, "kept", "keeping is idempotent");

  pub = await (await fetch(`${base}/api/pages/nova`)).json();
  assert.equal(pub.chalkboard.gallery.length, 1);

  // Pin cap: three pinned, the fourth fails clearly.
  for (let i = 0; i < 2; i += 1) await submit(drawing());
  const more = await authed(`/api/me/pages/p1/features/chalkboard/board`).then((r) => r.json());
  for (const p of more.pending) await authed(`/api/me/pages/p1/features/chalkboard/records/${p.id}/keep`, { method: "POST", body: {} });
  const all = await authed(`/api/me/pages/p1/features/chalkboard/board`).then((r) => r.json());
  for (const d of all.kept) {
    const r = await authed(`/api/me/pages/p1/features/chalkboard/records/${d.id}/pin`, { method: "POST", body: {} });
    assert.equal(r.status, 200);
  }
  const overflow = await authed(`/api/me/pages/p1/features/chalkboard/board`).then((r) => r.json());
  assert.equal(overflow.counts.pinned, 3);
  await submit(drawing());
  const extra = await authed(`/api/me/pages/p1/features/chalkboard/board`).then((r) => r.json());
  const extraId = extra.pending[0].id;
  await authed(`/api/me/pages/p1/features/chalkboard/records/${extraId}/keep`, { method: "POST", body: {} });
  const overCap = await authed(`/api/me/pages/p1/features/chalkboard/records/${extraId}/pin`, { method: "POST", body: {} });
  assert.equal(overCap.status, 409, "pinning fails clearly at the cap");

  // Reject and delete remove drawings from public reads.
  await authed(`/api/me/pages/p1/features/chalkboard/records/${extraId}/reject`, { method: "POST", body: {} });
  await authed(`/api/me/pages/p1/features/chalkboard/records/${id}`, { method: "DELETE" });
  pub = await (await fetch(`${base}/api/pages/nova`)).json();
  assert.ok(!pub.chalkboard.gallery.some((g) => g.id === id || g.id === extraId));

  // Intake pause hides the form but keeps the gallery visible.
  const beforePause = pub.chalkboard.gallery.length;
  await authed(`/api/me/pages/p1/features/chalkboard`, { method: "PATCH", body: { config: { intakePaused: true } } });
  await authed(`/api/me/pages/p1/features/chalkboard/publish`, { method: "POST", body: {} });
  assert.equal((await submit(drawing())).status, 403);
  pub = await (await fetch(`${base}/api/pages/nova`)).json();
  assert.equal(pub.chalkboard.acceptNew, false);
  assert.equal(pub.chalkboard.gallery.length, beforePause, "paused intake leaves kept drawings visible");

  // Disabling blocks submissions and hides the board, then totals survive.
  await authed(`/api/me/pages/p1/features/chalkboard`, { method: "PATCH", body: { ownerEnabled: false } });
  assert.equal((await submit(drawing())).status, 404);
  pub = await (await fetch(`${base}/api/pages/nova`)).json();
  assert.equal(pub.chalkboard, null);
  await authed(`/api/me/pages/p1/features/chalkboard`, { method: "PATCH", body: { ownerEnabled: true } });
  const restored = await authed(`/api/me/pages/p1/features/chalkboard/board`).then((r) => r.json());
  assert.equal(restored.counts.kept, beforePause, "hide/re-enable preserves totals");
});
