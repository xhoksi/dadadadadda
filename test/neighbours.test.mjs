import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtempSync } from "node:fs";
import { createApp, setServerClock } from "../src/app.js";
import { configureStore, resetStore, saveStore, getStore } from "../src/store.js";

let server;
let base;
let novaToken;
let lunaToken;

before(async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "misa-neighbours-"));
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
  novaToken = await login("nova");
  lunaToken = await login("luna");
});

after(() => server?.close());

beforeEach(() => {
  resetStore();
  saveStore();
  setServerClock(() => new Date("2026-05-01T12:00:00Z"));
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

async function enable(token, pageId) {
  const r = await authed(token, `/api/me/pages/${pageId}/features/neighbours`, { method: "PATCH", body: { ownerEnabled: true } });
  assert.equal(r.status, 200);
}

function addPages(defs) {
  const store = getStore();
  for (const [id, handle] of defs) {
    store.users[`u_${id}`] = { id: `u_${id}`, handle, role: "owner", plan: "free", suspended: false };
    store.pages[id] = { id, slug: handle, ownerId: `u_${id}`, timezone: "UTC", profile: { displayName: handle, bio: "", link: { label: "l", url: "https://example.com" } } };
    store.pageFeatures[`${id}:neighbours`] = { pageId: id, featureKey: "neighbours", ownerEnabled: true, draft: null, published: null, version: 1, updatedAt: new Date().toISOString() };
  }
  saveStore();
}

async function publicNeighbours(slug) {
  const page = await (await fetch(`${base}/api/pages/${slug}`)).json();
  return page.neighbours;
}

test("09.1 a one-sided nomination is private; mutual nomination shows on both; removal hides both", async () => {
  await enable(novaToken, "p1");
  await enable(lunaToken, "p2");

  const first = await authed(novaToken, `/api/me/pages/p1/neighbours`, { method: "POST", body: { handle: "luna" } });
  assert.equal(first.status, 201);
  assert.equal((await publicNeighbours("nova")).entries.length, 0, "unilateral nomination is not public on A");
  assert.equal((await publicNeighbours("luna")).entries.length, 0, "unilateral nomination is not public on B");

  const ownerView = await authed(novaToken, `/api/me/pages/p1/neighbours`).then((r) => r.json());
  assert.equal(ownerView.nominations[0].status, "waiting");
  assert.equal(ownerView.nominations[0].target.handle, "luna");

  const back = await authed(lunaToken, `/api/me/pages/p2/neighbours`, { method: "POST", body: { toPageId: "p1" } });
  assert.equal(back.status, 201);
  const a = await publicNeighbours("nova");
  const b = await publicNeighbours("luna");
  assert.equal(a.entries.length, 1, "mutual link shows on A");
  assert.equal(b.entries.length, 1, "mutual link shows on B");
  assert.equal(a.entries[0].handle, "luna");
  assert.equal(b.entries[0].handle, "nova");
  assert.ok(a.entries[0].color, "profile color is exposed");
  assert.match(a.entries[0].color, /^hsl\(/);

  const gone = await authed(novaToken, `/api/me/pages/p1/neighbours/p2`, { method: "DELETE" });
  assert.equal(gone.status, 200);
  assert.equal((await publicNeighbours("nova")).entries.length, 0, "removing either side hides both (A)");
  assert.equal((await publicNeighbours("luna")).entries.length, 0, "removing either side hides both (B)");
});

test("09.2 self-link, duplicate and overflow are rejected, including concurrent adds", async () => {
  await enable(novaToken, "p1");
  await enable(lunaToken, "p2");

  const self = await authed(novaToken, `/api/me/pages/p1/neighbours`, { method: "POST", body: { toPageId: "p1" } });
  assert.equal(self.status, 422, "self-link rejected");

  await authed(novaToken, `/api/me/pages/p1/neighbours`, { method: "POST", body: { handle: "luna" } });
  const dup = await authed(novaToken, `/api/me/pages/p1/neighbours`, { method: "POST", body: { handle: "luna" } });
  assert.equal(dup.status, 409, "duplicate rejected");

  addPages([["px1", "x1"], ["px2", "x2"], ["px3", "x3"], ["px4", "x4"]]);
  for (const id of ["px1", "px2", "px3"]) {
    const r = await authed(novaToken, `/api/me/pages/p1/neighbours`, { method: "POST", body: { toPageId: id } });
    assert.equal(r.status, 201);
  }
  // Four slots used; two concurrent adds for the last free slot.
  const results = await Promise.all([
    authed(novaToken, `/api/me/pages/p1/neighbours`, { method: "POST", body: { toPageId: "px4" } }),
    authed(novaToken, `/api/me/pages/p1/neighbours`, { method: "POST", body: { toPageId: "px4" } }),
  ]);
  const statuses = results.map((r) => r.status).sort();
  assert.deepEqual(statuses, [201, 409], "concurrent adds cannot exceed the slot limit");

  addPages([["px5", "x5"]]);
  const sixth = await authed(novaToken, `/api/me/pages/p1/neighbours`, { method: "POST", body: { toPageId: "px5" } });
  assert.equal(sixth.status, 409, "a sixth nomination is rejected");
  const view = await authed(novaToken, `/api/me/pages/p1/neighbours`).then((r) => r.json());
  assert.equal(view.slotsUsed, 5);
  assert.equal(view.slotsMax, 5);
});

test("09.3 rename, disable, suspend, unpublish and delete keep labels and visibility correct", async () => {
  await enable(novaToken, "p1");
  await enable(lunaToken, "p2");
  await authed(novaToken, `/api/me/pages/p1/neighbours`, { method: "POST", body: { handle: "luna" } });
  await authed(lunaToken, `/api/me/pages/p2/neighbours`, { method: "POST", body: { toPageId: "p1" } });
  assert.equal((await publicNeighbours("nova")).entries.length, 1);

  // Rename: the relationship survives and the label follows the new slug/handle.
  const store = getStore();
  store.pages.p2.slug = "luna-renamed";
  store.users.u_luna.handle = "luna2";
  saveStore();
  const renamed = await publicNeighbours("nova");
  assert.equal(renamed.entries.length, 1, "renaming preserves the relationship");
  assert.equal(renamed.entries[0].slug, "luna-renamed");
  assert.equal(renamed.entries[0].handle, "luna2");

  // Disable on the target hides it on both pages.
  await authed(lunaToken, `/api/me/pages/p2/features/neighbours`, { method: "PATCH", body: { ownerEnabled: false } });
  assert.equal((await publicNeighbours("nova")).entries.length, 0, "target disabled hides on A");
  assert.equal(await publicNeighbours("luna-renamed"), null, "target disabled hides its own output");
  await authed(lunaToken, `/api/me/pages/p2/features/neighbours`, { method: "PATCH", body: { ownerEnabled: true } });
  assert.equal((await publicNeighbours("nova")).entries.length, 1, "re-enabling restores the mutual link");

  // Suspend the target owner.
  getStore().users.u_luna.suspended = true;
  saveStore();
  assert.equal((await publicNeighbours("nova")).entries.length, 0, "suspended target is suppressed");
  getStore().users.u_luna.suspended = false;
  saveStore();

  // Unpublish the target page.
  getStore().pages.p2.published = false;
  saveStore();
  assert.equal((await publicNeighbours("nova")).entries.length, 0, "unpublished target is suppressed");
  getStore().pages.p2.published = true;
  saveStore();
  assert.equal((await publicNeighbours("nova")).entries.length, 1);

  // Delete the target page: the nomination is retained but shows as removed.
  const store2 = getStore();
  delete store2.pages.p2;
  saveStore();
  assert.equal((await publicNeighbours("nova")).entries.length, 0, "deleted target is suppressed");
  const view = await authed(novaToken, `/api/me/pages/p1/neighbours`).then((r) => r.json());
  assert.equal(view.nominations.length, 1, "retained nomination while the target is gone");
  assert.equal(view.nominations[0].target.removed, true);
});
