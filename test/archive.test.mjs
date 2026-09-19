import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtempSync } from "node:fs";
import { createApp, setServerClock } from "../src/app.js";
import { configureStore, resetStore, saveStore, getStore } from "../src/store.js";

let server;
let base;
let apiToken;
let adminToken;

before(async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "misa-archive-"));
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
  apiToken = await login("nova");
  adminToken = await login("admin");
});

after(() => server?.close());

beforeEach(() => {
  resetStore();
  saveStore();
  setServerClock(() => new Date("2026-01-10T09:00:00Z"));
});

function authed(p, opts = {}, token = apiToken) {
  return fetch(`${base}${p}`, {
    ...opts,
    headers: {
      ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
      Authorization: `Bearer ${token}`,
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

function saveBio(text) {
  return authed(`/api/me/pages/p1/profile`, {
    method: "PATCH",
    body: { displayName: "Nova", bio: text, link: { label: "My website", url: "https://example.com" } },
  });
}

async function archiveList(token = apiToken) {
  return (await authed(`/api/me/pages/p1/archive`, {}, token)).json();
}

async function publishFeature(key, config) {
  await authed(`/api/me/pages/p1/features/${key}`, { method: "PATCH", body: { ownerEnabled: true } });
  await authed(`/api/me/pages/p1/features/${key}`, { method: "PATCH", body: { config } });
  const pub = await authed(`/api/me/pages/p1/features/${key}/publish`, { method: "POST", body: {} });
  assert.equal(pub.status, 200);
}

test("06.1 only the latest 12 previous versions are retained and a no-op save creates no revision", async () => {
  for (let i = 1; i <= 13; i++) {
    const r = await saveBio(`v${i}`);
    assert.equal(r.status, 200);
  }
  const list = await archiveList();
  assert.equal(list.revisions.length, 12, "12 previous versions retained");
  assert.equal(list.current.profile.bio, "v13", "current head is the latest save");
  assert.equal(list.revisions[list.revisions.length - 1].profile.bio, "v1", "oldest retained is v1");
  assert.equal(list.revisions[0].profile.bio, "v12", "newest previous is v12");

  const before = list.revisions.length;
  await saveBio("v13");
  const after = await archiveList();
  assert.equal(after.revisions.length, before, "a no-op save added no revision");
});

test("06.2 restoring archives the pre-restore current, which can itself be restored back", async () => {
  for (let i = 1; i <= 5; i++) await saveBio(`v${i}`);
  let list = await archiveList();
  const v2 = list.revisions.find((r) => r.profile.bio === "v2");
  assert.ok(v2);

  const restored = await authed(`/api/me/pages/p1/archive/${v2.id}/restore`, {
    method: "POST",
    body: { expectedVersion: list.version },
  });
  assert.equal(restored.status, 200, JSON.stringify(await restored.clone().json()));
  list = await archiveList();
  assert.equal(list.current.profile.bio, "v2", "restored version is current");
  const preRestore = list.revisions.find((r) => r.profile.bio === "v5");
  assert.ok(preRestore, "the pre-restore current became a revision");

  const back = await authed(`/api/me/pages/p1/archive/${preRestore.id}/restore`, {
    method: "POST",
    body: { expectedVersion: list.version },
  });
  assert.equal(back.status, 200);
  assert.equal((await archiveList()).current.profile.bio, "v5", "and it can be restored back");
});

test("06.3 capsule bodies are never captured, and disabled features vanish from historical reads", async () => {
  await publishFeature("time_capsule", {
    label: "Later",
    body: "the hidden capsule words",
    releaseDate: "2030-01-01",
    releaseTime: "00:00",
    timezone: "UTC",
  });
  await publishFeature("moon", { corner: "top-right", size: "small", color: "#c22b35", showLabel: true, hemisphere: "north" });
  await publishFeature("archive", { publicBrowsing: true });

  const list = await archiveList();
  const raw = JSON.stringify(list);
  assert.ok(!raw.includes("the hidden capsule words"), "capsule body absent from the private archive index");
  const someRev = await authed(`/api/me/pages/p1/archive/${list.revisions[0].id}`).then((r) => r.json());
  assert.equal(someRev.content.features.time_capsule.published.body, "", "capsule body redacted in the snapshot");
  assert.ok(!JSON.stringify(someRev).includes("the hidden capsule words"));

  const history = await (await fetch(`${base}/api/pages/nova/history`)).json();
  assert.ok(history.revisions.length > 0);
  assert.match(history.revisions[0].label, /^\d{4}-\d{2}-\d{2}$/, "dated historical label");
  const pubSnap = await (await fetch(`${base}/api/pages/nova/history/${list.revisions[0].id}`)).json();
  assert.ok(!JSON.stringify(pubSnap).includes("the hidden capsule words"), "public history suppresses the capsule body");
  assert.ok(Array.isArray(pubSnap.features));

  // Global policy still overrides the snapshot: moon disappears everywhere.
  await authed(`/api/admin/features/moon`, { method: "PATCH", body: { globalEnabled: false } }, adminToken);
  const afterOff = await (await fetch(`${base}/api/pages/nova/history/${list.revisions[0].id}`)).json();
  assert.ok(!afterOff.features.some((f) => f.key === "moon"), "a globally disabled feature is unavailable through historical reads");
});

test("public history is blocked while the browsing switch is off", async () => {
  await saveBio("private only");
  let res = await fetch(`${base}/api/pages/nova/history`);
  assert.equal(res.status, 404, "no public history by default");

  await publishFeature("archive", { publicBrowsing: false });
  res = await fetch(`${base}/api/pages/nova/history`);
  assert.equal(res.status, 404, "still blocked when the switch is off");

  await authed(`/api/me/pages/p1/features/archive`, { method: "PATCH", body: { config: { publicBrowsing: true } } });
  await authed(`/api/me/pages/p1/features/archive/publish`, { method: "POST", body: {} });
  res = await fetch(`${base}/api/pages/nova/history`);
  assert.equal(res.status, 200, "browsing on exposes the dated history");
});

test("restoring a version that re-enables features requires explicit owner review", async () => {
  await publishFeature("moon", { corner: "top-right", size: "small", color: "#c22b35", showLabel: true, hemisphere: "north" });
  await saveBio("keep");
  await authed(`/api/me/pages/p1/features/moon`, { method: "PATCH", body: { ownerEnabled: false } });

  const list = await archiveList();
  let target = null;
  for (const r of list.revisions) {
    const detail = await authed(`/api/me/pages/p1/archive/${r.id}`).then((x) => x.json());
    if (detail.content.features.moon.ownerEnabled) {
      target = r;
      break;
    }
  }
  assert.ok(target, "found a revision where the moon was on");

  const res = await authed(`/api/me/pages/p1/archive/${target.id}/restore`, { method: "POST", body: {} });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.ok(body.requiresAcknowledgement.some((s) => s.key === "moon"), "review lists the feature that would switch back on");

  const ack = await authed(`/api/me/pages/p1/archive/${target.id}/restore`, {
    method: "POST",
    body: { acknowledgeFeatureSwitches: true, expectedVersion: (await archiveList()).version },
  });
  assert.equal(ack.status, 200);
  assert.equal((await archiveList()).current.profile.bio, target.profile.bio);
});
