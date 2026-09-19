import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { createApp } from "../src/app.js";
import { configureStore, resetStore, getStore, saveStore } from "../src/store.js";

let server;
let base;

before(async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "misa-test-"));
  configureStore(path.join(dir, "store.json"));
  resetStore();
  saveStore();
  server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
});

async function login(handle) {
  const res = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ handle }),
  });
  const data = await res.json();
  return data.token;
}

function authed(token, pathName, opts = {}) {
  return fetch(`${base}${pathName}`, {
    ...opts,
    headers: {
      ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
      Authorization: `Bearer ${token}`,
      ...(opts.headers || {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

async function featureState(pageId, key) {
  const store = getStore();
  const pf = store.pageFeatures[`${pageId}:${key}`];
  return { ownerEnabled: pf.ownerEnabled, published: pf.published, version: pf.version };
}

test("unauthenticated management is rejected (401)", async () => {
  const res = await fetch(`${base}/api/me/pages/p1/features`);
  assert.equal(res.status, 401);
});

test("unknown demo handle is rejected", async () => {
  const res = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ handle: "nope" }),
  });
  assert.equal(res.status, 401);
});

test("non-owner cannot touch another page", async () => {
  const token = await login("luna");
  const res = await authed(token, "/api/me/pages/p1/features");
  assert.equal(res.status, 403);
});

test("end-to-end toggle: enabling moon hides/shows it on the public page", async () => {
  const token = await login("nova");

  const before = await fetch(`${base}/api/pages/nova`).then((r) => r.json());
  assert.equal(before.features.some((f) => f.key === "moon"), false, "moon absent initially");

  const on = await authed(token, "/api/me/pages/p1/features/moon", { method: "PATCH", body: { ownerEnabled: true } });
  assert.equal(on.status, 200);
  const onBody = await on.json();
  assert.equal(onBody.effectiveEnabled, true);
  assert.equal(onBody.reasonCode, "enabled");

  const after = await fetch(`${base}/api/pages/nova`).then((r) => r.json());
  assert.equal(after.features.some((f) => f.key === "moon"), true, "moon present when enabled");

  const off = await authed(token, "/api/me/pages/p1/features/moon", { method: "PATCH", body: { ownerEnabled: false } });
  assert.equal((await off.json()).effectiveEnabled, false);

  const afterOff = await fetch(`${base}/api/pages/nova`).then((r) => r.json());
  assert.equal(afterOff.features.some((f) => f.key === "moon"), false, "moon absent when disabled");
});

test("global off wins over owner enable and keeps saved state", async () => {
  const admin = await login("admin");
  const nova = await login("nova");

  await authed(nova, "/api/me/pages/p1/features/ask_anything", { method: "PATCH", body: { ownerEnabled: true } });
  let st = await featureState("p1", "ask_anything");
  assert.equal(st.ownerEnabled, true);

  const res = await authed(admin, "/api/admin/features/ask_anything", {
    method: "PATCH",
    body: { globalEnabled: false, allowedPlans: ["free", "lifetime"], rolloutPercent: 100, defaultEnabled: false, reason: "test" },
  });
  assert.equal(res.status, 200);

  const ownerView = await authed(nova, "/api/me/pages/p1/features/ask_anything").then((r) => r.json());
  assert.equal(ownerView.effectiveEnabled, false);
  assert.equal(ownerView.reasonCode, "global_off");

  const publicView = await fetch(`${base}/api/pages/nova`).then((r) => r.json());
  assert.equal(publicView.features.some((f) => f.key === "ask_anything"), false);

  st = await featureState("p1", "ask_anything");
  assert.equal(st.ownerEnabled, true, "owner request retained while global off");
  assert.equal(st.published, null, "content retained");
});

test("plan lock: free user can request but cannot get a Lifetime feature", async () => {
  const luna = await login("luna");
  const res = await authed(luna, "/api/me/pages/p2/features/night_shift", { method: "PATCH", body: { ownerEnabled: true } });
  const body = await res.json();
  assert.equal(body.effectiveEnabled, false);
  assert.equal(body.reasonCode, "plan_locked");
  assert.equal(body.canEdit, false, "locked by plan cannot be edited");
});

test("configuration incomplete until a valid config is published", async () => {
  const nova = await login("nova");
  await authed(nova, "/api/me/pages/p1/features/night_shift", { method: "PATCH", body: { ownerEnabled: true } });
  let state = await authed(nova, "/api/me/pages/p1/features/night_shift").then((r) => r.json());
  assert.equal(state.effectiveEnabled, false);
  assert.equal(state.reasonCode, "configuration_incomplete");

  const bad = await authed(nova, "/api/me/pages/p1/features/night_shift", {
    method: "PATCH",
    body: { config: { start: "99:00", timezone: "Europe/Berlin", end: "05:00" } },
  });
  assert.equal(bad.status, 422);

  const good = await authed(nova, "/api/me/pages/p1/features/night_shift", {
    method: "PATCH",
    body: { config: { start: "23:00", timezone: "Europe/Berlin", end: "05:00", message: "Night here." } },
  });
  assert.equal(good.status, 200);

  const draftOnly = await authed(nova, "/api/me/pages/p1/features/night_shift").then((r) => r.json());
  assert.equal(draftOnly.effectiveEnabled, false, "draft alone does not enable the feature");

  const pub = await authed(nova, "/api/me/pages/p1/features/night_shift/publish", { method: "POST", body: {} });
  assert.equal(pub.status, 200);
  const published = await authed(nova, "/api/me/pages/p1/features/night_shift").then((r) => r.json());
  assert.equal(published.effectiveEnabled, true);
  assert.equal(published.reasonCode, "enabled");

  const st = await featureState("p1", "night_shift");
  assert.deepEqual(st.published, { start: "23:00", timezone: "Europe/Berlin", end: "05:00", message: "Night here.", blocks: [] });
});

test("unknown config keys and malformed drafts are rejected (422)", async () => {
  const nova = await login("nova");
  const res = await authed(nova, "/api/me/pages/p1/features/moon", { method: "PATCH", body: { config: { bogus: true } } });
  assert.equal(res.status, 422);
  const body = await res.json();
  assert.ok(body.errors.bogus, "unknown key reported");
});

test("stale edits are rejected with 409", async () => {
  const nova = await login("nova");
  const st = await featureState("p1", "moon");
  const res = await authed(nova, "/api/me/pages/p1/features/moon", {
    method: "PATCH",
    body: { ownerEnabled: true, expectedVersion: st.version + 99 },
  });
  assert.equal(res.status, 409);
});

test("admin can restrict a user's feature and effective state follows", async () => {
  const admin = await login("admin");
  const luna = await login("luna");
  await authed(luna, "/api/me/pages/p2/features/moon", { method: "PATCH", body: { ownerEnabled: true } });

  const res = await authed(admin, "/api/admin/users/u_luna/features/moon/override", {
    method: "PATCH",
    body: { kind: "restrict", reason: "Moderation action", expiry: null },
  });
  assert.equal(res.status, 200);

  const state = await authed(luna, "/api/me/pages/p2/features/moon").then((r) => r.json());
  assert.equal(state.effectiveEnabled, false);
  assert.equal(state.reasonCode, "restricted");
});

test("admin privilege is required for the catalogue", async () => {
  const nova = await login("nova");
  const res = await authed(nova, "/api/admin/features");
  assert.equal(res.status, 403);
});

test("admin catalogue lists all 16 registry rows with policy", async () => {
  const admin = await login("admin");
  const res = await authed(admin, "/api/admin/features").then((r) => r.json());
  assert.equal(res.rows.length, 16);
  const moon = res.rows.find((r) => r.key === "moon");
  assert.equal(moon.globalEnabled, true);
  assert.ok(moon.allowedPlans.includes("free"));
});

test("login row for admin exposes audit log", async () => {
  const admin = await login("admin");
  const res = await authed(admin, "/api/admin/audit").then((r) => r.json());
  assert.ok(Array.isArray(res.audit));
  assert.ok(res.audit.length > 0, "seed audit entry present");
});