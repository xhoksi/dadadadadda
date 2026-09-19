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
let adminToken;

before(async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "misa-guestbook-"));
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

beforeEach(async () => {
  resetStore();
  saveStore();
  setServerClock(() => new Date("2026-05-01T12:00:00Z"));
  await fetch(`${base}/api/dev/reset`, { method: "POST" });
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

async function enableGuestbook(config = {}) {
  await authed(ownerToken, `/api/me/pages/p1/features/guestbook`, { method: "PATCH", body: { ownerEnabled: true } });
  const saved = await authed(ownerToken, `/api/me/pages/p1/features/guestbook`, {
    method: "PATCH",
    body: { config: { heading: "Guestbook", prompt: "Sign the guestbook", intakePaused: false, pinning: true, handwriting: "handwritten", ...config } },
  });
  assert.equal(saved.status, 200);
  const pub = await authed(ownerToken, `/api/me/pages/p1/features/guestbook/publish`, { method: "POST", body: {} });
  assert.equal(pub.status, 200);
}

function submit(body) {
  return fetch(`${base}/api/pages/nova/guestbook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function publicList() {
  const res = await fetch(`${base}/api/pages/nova/guestbook`, { headers: { Accept: "application/json" } });
  if (res.status === 404) return null;
  return res.json();
}

async function ownerApprove(recordId, expectedVersion) {
  return authed(ownerToken, `/api/me/pages/p1/features/guestbook/records/${recordId}/approve`, {
    method: "POST",
    body: expectedVersion === undefined ? {} : { expectedVersion },
  });
}

test("08.1 a fresh entry is absent from the public list, direct object requests and page source", async () => {
  await enableGuestbook();
  const secret = "marmalade-zoom-9911";
  const res = await submit({ displayName: "Ghost", message: secret });
  assert.equal(res.status, 201);
  const receipt = await res.json();
  assert.equal(receipt.status, "pending");

  const list = await publicList();
  assert.equal(list.entries.length, 0, "public list hides pending entries");

  const byId = await fetch(`${base}/api/pages/nova/guestbook/${receipt.id}`);
  assert.equal(byId.status, 404, "internal id is not publicly reachable");

  const page = await (await fetch(`${base}/api/pages/nova`)).json();
  assert.equal(page.guestbook.entries.length, 0);
  assert.ok(!JSON.stringify(page).includes(secret), "page payload never carries a pending message");
  const html = await (await fetch(`${base}/p/nova`)).text();
  assert.ok(!html.includes(secret), "page source never carries a pending message");
});

test("08.2 approval displays once; rejection and removal hide it; stale moderation conflicts", async () => {
  await enableGuestbook();
  const { id } = await (await submit({ displayName: "Ada", message: "hello there" })).json();

  const approved = await ownerApprove(id, 1);
  assert.equal(approved.status, 200);
  let list = await publicList();
  assert.equal(list.entries.length, 1);
  const publicId = list.entries[0].id;

  // Approval is idempotent: a repeat does not duplicate the entry.
  const again = await ownerApprove(id);
  assert.equal(again.status, 200);
  list = await publicList();
  assert.equal(list.entries.length, 1, "approval displays once");

  const direct = await fetch(`${base}/api/pages/nova/guestbook/${publicId}`);
  assert.equal(direct.status, 200);

  // Concurrent moderation: the second call with a stale version must conflict.
  const stale = await authed(ownerToken, `/api/me/pages/p1/features/guestbook/records/${id}/remove`, { method: "POST", body: { expectedVersion: 1 } });
  assert.equal(stale.status, 409, "stale version conflicts instead of silently reversing");

  // Rejection hides it, with the current version.
  const afterApprove = await authed(ownerToken, `/api/me/pages/p1/features/guestbook/inbox?status=approved`).then((r) => r.json());
  const current = afterApprove.entries.find((e) => e.id === id).version;
  const rejected = await authed(ownerToken, `/api/me/pages/p1/features/guestbook/records/${id}/reject`, { method: "POST", body: { expectedVersion: current } });
  assert.equal(rejected.status, 200);
  list = await publicList();
  assert.equal(list.entries.length, 0, "rejection hides the entry");
  assert.equal((await fetch(`${base}/api/pages/nova/guestbook/${publicId}`)).status, 404);

  // Re-approve then remove also hides it.
  await ownerApprove(id);
  list = await publicList();
  assert.equal(list.entries.length, 1);
  const v = list.entries.length ? (await authed(ownerToken, `/api/me/pages/p1/features/guestbook/inbox?status=approved`).then((r) => r.json())).entries[0].version : 1;
  const removed = await authed(ownerToken, `/api/me/pages/p1/features/guestbook/records/${id}/remove`, { method: "POST", body: { expectedVersion: v } });
  assert.equal(removed.status, 200);
  assert.equal((await publicList()).entries.length, 0, "removal hides the entry");
  assert.equal((await fetch(`${base}/api/pages/nova/guestbook/${publicId}`)).status, 404);
});

test("08.3 HTML-looking text stays text and is never auto-linked", async () => {
  await enableGuestbook();
  const rawName = "<script>alert(1)</script>";
  const rawMessage = "<b>bold</b> https://evil.example";
  const { id } = await (await submit({ displayName: rawName, message: rawMessage })).json();
  await ownerApprove(id);
  const list = await publicList();
  assert.equal(list.entries[0].displayName, rawName, "HTML-looking name is returned as plain text");
  assert.equal(list.entries[0].message, rawMessage, "message is not auto-linked or transformed");

  const dom = new JSDOM("", { url: `${base}/p/nova`, pretendToBeVisual: true, runScripts: "outside-only" });
  dom.window.fetch = (input, opts) => fetch(new URL(input, base).toString(), opts);
  dom.window.setInterval = () => 0;
  dom.window.setTimeout = () => 0;
  dom.window.document.documentElement.innerHTML = await fetch(`${base}/page.html`).then((r) => r.text());
  dom.window.eval(readFileSync(new URL("../public/page.js", import.meta.url), "utf8"));
  await new Promise((r) => setTimeout(r, 80));
  const doc = dom.window.document;
  const entryEl = doc.querySelector("#guestbook-entries .guest-entry");
  assert.ok(entryEl, "approved entry is rendered");
  assert.equal(entryEl.querySelectorAll("script").length, 0, "no script element is injected");
  assert.equal(entryEl.querySelector("a"), null, "no auto-linked URL");
  assert.match(entryEl.textContent, /<script>alert\(1\)<\/script>/, "markup shown as harmless text");
});

test("08.3 floods get a retryable limit and never bypass the queue", async () => {
  await enableGuestbook();
  const patched = await authed(adminToken, `/api/admin/features/guestbook`, { method: "PATCH", body: { limits: { rateMax: 2, rateWindowMs: 600000 } } });
  assert.equal(patched.status, 200);
  await submit({ displayName: "One", message: "first" });
  await submit({ displayName: "Two", message: "second" });
  const limited = await submit({ displayName: "Three", message: "third" });
  assert.equal(limited.status, 429, "flood gets a retryable limit response");
  assert.ok(limited.headers.get("retry-after"), "Retry-After header is present");
  const body = await limited.json();
  assert.ok(body.retryAfterMs > 0);

  const list = await publicList();
  assert.equal(list.entries.length, 0, "flooded entries never bypass moderation");
  const inbox = await authed(ownerToken, `/api/me/pages/p1/features/guestbook/inbox?status=pending`).then((r) => r.json());
  assert.equal(inbox.counts.pending, 2, "accepted flood entries wait in the private queue");
  assert.equal(inbox.counts.approved, 0);
});

test("intake pause hides only the form; switching the feature off retains the queue", async () => {
  await enableGuestbook({ intakePaused: true });
  const view = await publicList();
  assert.equal(view.acceptNew, false, "paused intake closes the form");
  const blocked = await submit({ displayName: "Nope", message: "should not save" });
  assert.equal(blocked.status, 403);

  await enableGuestbook({ intakePaused: false });
  const { id } = await (await submit({ displayName: "Kept", message: "remember me" })).json();
  await ownerApprove(id);

  await authed(ownerToken, `/api/me/pages/p1/features/guestbook`, { method: "PATCH", body: { ownerEnabled: false } });
  assert.equal(await publicList(), null, "feature off hides the guestbook");
  const inbox = await authed(ownerToken, `/api/me/pages/p1/features/guestbook/inbox?status=approved`).then((r) => r.json());
  assert.equal(inbox.counts.approved, 1, "approved records are retained while off");

  await authed(ownerToken, `/api/me/pages/p1/features/guestbook`, { method: "PATCH", body: { ownerEnabled: true } });
  const back = await publicList();
  assert.equal(back.entries.length, 1, "re-enabling shows approved records again");
});

test("pinning only works when enabled and public pagination caps visible entries", async () => {
  await enableGuestbook({ pinning: false });
  const { id } = await (await submit({ displayName: "P", message: "pin me" })).json();
  await ownerApprove(id);
  const denied = await authed(ownerToken, `/api/me/pages/p1/features/guestbook/records/${id}/pin`, { method: "POST", body: {} });
  assert.equal(denied.status, 409);

  await enableGuestbook({ pinning: true });
  const box = await authed(ownerToken, `/api/me/pages/p1/features/guestbook/inbox?status=approved`).then((r) => r.json());
  const v = box.entries.find((e) => e.id === id).version;
  const pinned = await authed(ownerToken, `/api/me/pages/p1/features/guestbook/records/${id}/pin`, { method: "POST", body: { expectedVersion: v, pinned: true } });
  assert.equal(pinned.status, 200);
  const list = await publicList();
  assert.equal(list.entries[0].pinned, true);

  for (let i = 0; i < 25; i++) {
    const r = await (await submit({ displayName: `N${i}`, message: `m${i}` })).json();
    await ownerApprove(r.id);
  }
  const paged = await fetch(`${base}/api/pages/nova/guestbook?page=1`).then((r) => r.json());
  assert.equal(paged.entries.length, 20, "public list is capped at 20 per page");
  assert.ok(paged.page.total >= 26);
  assert.equal(paged.page.pages, Math.ceil(paged.page.total / 20));
  const p2 = await fetch(`${base}/api/pages/nova/guestbook?page=2`).then((r) => r.json());
  assert.equal(p2.page.page, 2);
  assert.ok(p2.entries.length > 0);
});
