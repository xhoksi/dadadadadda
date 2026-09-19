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

const DECK_A = ["aloha", "adios", "hola"];
const DECK_B = ["one", "two", "three", "four"];

before(async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "misa-draw-"));
  configureStore(path.join(dir, "store.json"));
  resetStore();
  saveStore();
  server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  const port = server.address().port;
  base = `http://127.0.0.1:${port}`;
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

async function enableDraw(deck = DECK_A) {
  await authed(`/api/me/pages/p1/features/daily_draw`, { method: "PATCH", body: { ownerEnabled: true } });
  const cfg = await authed(`/api/me/pages/p1/features/daily_draw`, { method: "PATCH", body: { config: { cards: deck, style: "handwritten" } } });
  assert.equal(cfg.status, 200);
  const pub = await authed(`/api/me/pages/p1/features/daily_draw/publish`, { method: "POST", body: {} });
  assert.equal(pub.status, 200);
}

function at(iso) {
  setServerClock(() => new Date(iso));
}

async function publicPage() {
  return fetch(`${base}/api/pages/luna`).then((r) => r.json());
}
async function novaPage() {
  return fetch(`${base}/api/pages/nova`).then((r) => r.json());
}

test("04.2 an empty deck is rejected on publish", async () => {
  await authed(`/api/me/pages/p1/features/daily_draw`, { method: "PATCH", body: { ownerEnabled: true } });
  await authed(`/api/me/pages/p1/features/daily_draw`, { method: "PATCH", body: { config: { cards: [] } } });
  const pub = await authed(`/api/me/pages/p1/features/daily_draw/publish`, { method: "POST", body: {} });
  assert.equal(pub.status, 422);
  assert.match((await pub.json()).message, /at least one/i);
});

test("04.2 a 13th card is rejected", async () => {
  await authed(`/api/me/pages/p1/features/daily_draw`, { method: "PATCH", body: { ownerEnabled: true } });
  const thirteen = Array.from({ length: 13 }, (_, i) => `card ${i + 1}`);
  const res = await authed(`/api/me/pages/p1/features/daily_draw`, { method: "PATCH", body: { config: { cards: thirteen } } });
  assert.equal(res.status, 422);
  assert.ok((await res.json()).errors.cards);
});

test("04.2 midday edits change the deck only at the next owner-local midnight", async () => {
  at("2026-01-10T09:00:00Z"); // Berlin 10:00
  await enableDraw(DECK_A);
  let page = await novaPage();
  assert.deepEqual(page.draw.cards, DECK_A, "deck A live immediately");

  at("2026-01-10T12:00:00Z"); // Berlin 13:00, same day
  await authed(`/api/me/pages/p1/features/daily_draw`, { method: "PATCH", body: { config: { cards: DECK_B } } });
  const pub = await authed(`/api/me/pages/p1/features/daily_draw/publish`, { method: "POST", body: {} });
  assert.equal(pub.status, 200);
  const st = await authed(`/api/me/pages/p1/features/daily_draw`).then((r) => r.json());
  assert.equal(st.state.pending.appliesOn, "2026-01-11", "pending applies on the next owner-local date");
  assert.deepEqual(st.state.active.cards, DECK_A, "active deck still A at midday");

  page = await novaPage();
  assert.deepEqual(page.draw.cards, DECK_A, "public still A before midnight");

  at("2026-01-11T00:30:00Z"); // Berlin 01:30 next day
  page = await novaPage();
  assert.deepEqual(page.draw.cards, DECK_B, "deck B live after the owner-local midnight");
});

test("04.2 a scheduled revision can be cancelled", async () => {
  at("2026-01-10T09:00:00Z");
  await enableDraw(DECK_A);
  at("2026-01-10T12:00:00Z");
  await authed(`/api/me/pages/p1/features/daily_draw`, { method: "PATCH", body: { config: { cards: DECK_B } } });
  await authed(`/api/me/pages/p1/features/daily_draw/publish`, { method: "POST", body: {} });

  const cancel = await authed(`/api/me/pages/p1/features/daily_draw/cancel`, { method: "POST", body: {} });
  assert.equal(cancel.status, 200);
  const st = await authed(`/api/me/pages/p1/features/daily_draw`).then((r) => r.json());
  assert.equal(st.state.pending, null);

  at("2026-01-11T00:30:00Z");
  const page = await novaPage();
  assert.deepEqual(page.draw.cards, DECK_A, "cancelled revision never applies");
});

test("04.1 the same browser keeps the same card for the owner-local day", async () => {
  await enableDraw(DECK_A);
  at("2026-01-10T09:00:00Z");
  const dom = new JSDOM("", { url: `${base}/p/nova`, pretendToBeVisual: true, runScripts: "outside-only" });
  dom.window.fetch = (input, opts) => fetch(new URL(input, base).toString(), opts);
  dom.window.setInterval = () => 0;
  dom.window.setTimeout = () => 0;
  const pageJs = readFileSync(new URL("../public/page.js", import.meta.url), "utf8");
  const html = await fetch(`${base}/page.html`).then((r) => r.text());

  const loadAndRead = async () => {
    dom.window.document.documentElement.innerHTML = html;
    dom.window.eval(pageJs);
    await new Promise((r) => setTimeout(r, 100));
    return dom.window.document.getElementById("draw-line").textContent;
  };

  const first = await loadAndRead();
  assert.ok(DECK_A.includes(first), `a card from the deck: ${first}`);
  const second = await loadAndRead();
  assert.equal(second, first, "reload inside the same day keeps the card");

  const seedKey = `misa_draw:p1:seed`;
  const stored = JSON.parse(dom.window.localStorage.getItem(seedKey));
  assert.equal(stored.day, "2026-01-10", "day scoped store");
  assert.ok(!Object.keys(stored).includes("index"), "no index stored");

  at("2026-01-11T00:30:00Z");
  const third = await loadAndRead();
  assert.ok(DECK_A.includes(third), "new day still draws a valid card");
  const newStored = JSON.parse(dom.window.localStorage.getItem(seedKey));
  assert.equal(newStored.day, "2026-01-11", "day store advances");
});

test("04.3 the public deck payload contains no seed or chosen index", async () => {
  await enableDraw(DECK_A);
  const page = await novaPage();
  assert.ok(Array.isArray(page.draw.cards));
  const keys = Object.keys(page.draw).sort();
  assert.deepEqual(keys, ["cards", "day", "pageId", "present", "style"]);
  const raw = JSON.stringify(page.draw);
  assert.ok(!/seed|idx|index|hash/i.test(raw), "no selection identifier is transmitted: " + raw);
  assert.deepEqual(page.draw.cards, DECK_A, "the deck itself is public");
});

test("a new day always returns a valid card even when the deck changed", async () => {
  at("2026-01-10T09:00:00Z");
  await enableDraw(DECK_A);
  const before = (await novaPage()).draw;
  at("2026-01-10T12:00:00Z");
  await authed(`/api/me/pages/p1/features/daily_draw`, { method: "PATCH", body: { config: { cards: DECK_B } } });
  await authed(`/api/me/pages/p1/features/daily_draw/publish`, { method: "POST", body: {} });
  at("2026-01-11T00:30:00Z");
  const after = (await novaPage()).draw;
  assert.equal(before.day, "2026-01-10");
  assert.equal(after.day, "2026-01-11");
  assert.deepEqual(after.cards, DECK_B);
  assert.ok(after.cards.length >= 1);
});