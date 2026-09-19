import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtempSync, readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { createApp, setServerClock } from "../src/app.js";
import { configureStore, resetStore, saveStore } from "../src/store.js";
import { resetAttempts } from "../src/content/secret_word.js";

let server;
let base;
let ownerToken;
let adminToken;

before(async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "misa-secret-"));
  configureStore(path.join(dir, "store.json"));
  resetStore();
  saveStore();
  server = createApp().listen(0);
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
  resetAttempts();
  setServerClock(() => new Date("2026-03-01T10:00:00Z"));
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

const PHRASE = "Open Sesame";
const DEST = "https://secret-door.test/private?x=1";

async function enableSecret(over = {}) {
  await authed(ownerToken, `/api/me/pages/p1/features/secret_word`, { method: "PATCH", body: { ownerEnabled: true } });
  const saved = await authed(ownerToken, `/api/me/pages/p1/features/secret_word`, {
    method: "PATCH",
    body: { config: { phrase: PHRASE, url: DEST, label: "The door", placement: "card", ...over } },
  });
  assert.equal(saved.status, 200);
  const pub = await authed(ownerToken, `/api/me/pages/p1/features/secret_word/publish`, { method: "POST", body: {} });
  assert.equal(pub.status, 200);
}

function guess(phrase) {
  return fetch(`${base}/api/pages/nova/secret`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phrase }),
  });
}

test("11.1 no phrase or destination appears in public HTML, scripts, JSON or archive output", async () => {
  await authed(ownerToken, `/api/me/pages/p1/features/archive`, { method: "PATCH", body: { ownerEnabled: true } });
  await authed(ownerToken, `/api/me/pages/p1/features/archive`, { method: "PATCH", body: { config: { publicBrowsing: true } } });
  await authed(ownerToken, `/api/me/pages/p1/features/archive/publish`, { method: "POST", body: {} });
  await enableSecret();

  const publicOutputs = [];
  for (const p of ["/api/pages/nova", "/p/nova", "/page.js", "/page.html", "/page.css", "/styles.css", "/api/pages/nova/history"]) {
    publicOutputs.push([p, await (await fetch(`${base}${p}`)).text()]);
  }
  for (const [p, text] of publicOutputs) {
    assert.ok(!text.includes(PHRASE), `${p} must not contain the phrase`);
    assert.ok(!text.includes("Open Sesame"), `${p} must not contain the phrase (case)`);
    assert.ok(!text.includes("secret-door.test"), `${p} must not contain the destination`);
    assert.ok(!text.includes("/private"), `${p} must not contain the destination path`);
  }

  const page = await (await fetch(`${base}/api/pages/nova`)).json();
  assert.equal(page.secret_word.label, "The door", "only the label and placement are public");
  assert.equal(page.secret_word.placement, "card");
  assert.equal(page.secret_word.url, undefined);

  // A correct guess is the only thing that yields the link.
  const bad = await guess("wrong words");
  assert.equal(bad.status, 401);
  assert.ok(!JSON.stringify(await bad.json()).includes("secret-door.test"));
  const good = await guess(PHRASE).then((r) => r.json());
  assert.equal(good.url, DEST);
  assert.ok(good.grant);
});

test("11.2 typing in a form, holding modifiers or composing does not trigger capture; deliberate submit works", async () => {
  await enableSecret();
  const posts = [];
  const dom = new JSDOM("", { url: `${base}/p/nova`, pretendToBeVisual: true, runScripts: "outside-only" });
  dom.window.fetch = (input, opts) => {
    const url = new URL(input, base).toString();
    if (url.includes("/secret") && opts && opts.method === "POST") posts.push(JSON.parse(opts.body).phrase);
    return fetch(url, opts);
  };
  dom.window.setInterval = () => 0;
  dom.window.document.documentElement.innerHTML = await fetch(`${base}/page.html`).then((r) => r.text());
  dom.window.eval(readFileSync(new URL("../public/page.js", import.meta.url), "utf8"));
  await new Promise((r) => setTimeout(r, 120));
  const doc = dom.window.document;
  assert.equal(doc.getElementById("secret-card").hidden, false);

  const type = (target, key, init = {}) => {
    const ev = new dom.window.KeyboardEvent("keydown", { key, bubbles: true, ...init });
    target.dispatchEvent(ev);
  };

  const input = doc.getElementById("secret-input");
  for (const ch of "nope") type(input, ch);
  type(doc.body, "x", { ctrlKey: true });
  type(doc.body, "y", { metaKey: true });
  const composing = new dom.window.KeyboardEvent("keydown", { key: "z", bubbles: true });
  Object.defineProperty(composing, "isComposing", { value: true });
  doc.body.dispatchEvent(composing);
  await new Promise((r) => setTimeout(r, 1000));
  assert.equal(posts.length, 0, "form typing, modifiers and composition never submit a guess");

  // Deliberate keyboard/touch submission (also the accessibility path).
  input.value = PHRASE;
  doc.getElementById("secret-form").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(posts.length, 1);
  assert.equal(posts[0], PHRASE);
  const link = doc.querySelector("#secret-reveal a");
  assert.ok(link, "the label and destination are shown after success");
  assert.equal(link.textContent, "The door");
  assert.equal(link.getAttribute("href"), DEST);
  assert.equal(doc.getElementById("secret-form").hidden, true);

  // Typing the phrase outside any editable control, after a pause, also works.
  for (const ch of PHRASE.split("")) type(doc.body, ch);
  await new Promise((r) => setTimeout(r, 1000));
  assert.ok(posts.length >= 2, "the transient keyboard buffer submits after a typing pause");
});

test("11.3 brute-force limits apply first, and rotation or global disable invalidates stale grants", async () => {
  await enableSecret();
  await authed(adminToken, `/api/admin/features/secret_word`, { method: "PATCH", body: { limits: { attemptMax: 3 } } });

  for (let i = 0; i < 3; i += 1) {
    const r = await guess(`wrong ${i}`);
    assert.equal(r.status, 401);
  }
  const limited = await guess("wrong again");
  assert.equal(limited.status, 429, "further attempts are rate-limited before verification");
  assert.ok(Number(limited.headers.get("retry-after")) > 0);

  await authed(ownerToken, `/api/dev/reset`, { method: "POST", body: {} });
  await enableSecret();
  const unlocked = await guess(PHRASE).then((r) => r.json());
  assert.ok(unlocked.grant);

  await authed(ownerToken, `/api/me/pages/p1/features/secret_word`, { method: "PATCH", body: { config: { phrase: "brand new words" } } });
  await authed(ownerToken, `/api/me/pages/p1/features/secret_word/publish`, { method: "POST", body: {} });
  const stale = await fetch(`${base}/api/pages/nova/secret/grant/${unlocked.grant}`);
  assert.equal(stale.status, 410, "rotation invalidates stale grants");
  assert.equal((await guess(PHRASE)).status, 401, "the old phrase no longer matches");
  const rotated = await guess("brand new words").then((r) => r.json());
  assert.ok(rotated.grant);

  await authed(adminToken, `/api/admin/features/secret_word`, { method: "PATCH", body: { globalEnabled: false } });
  const revoked = await fetch(`${base}/api/pages/nova/secret/grant/${rotated.grant}`);
  assert.equal(revoked.status, 410, "a global disable revokes grants");
  assert.equal((await guess("brand new words")).status, 404);
});

