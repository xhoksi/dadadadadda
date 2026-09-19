import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { createApp } from "../src/app.js";
import { configureStore, resetStore, saveStore } from "../src/store.js";
import { resetIntakeRate } from "../src/content/ask_anything.js";

let server;
let base;

before(async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "misa-ask-"));
  configureStore(path.join(dir, "store.json"));
  resetStore();
  saveStore();
  resetIntakeRate();
  server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server?.close());

beforeEach(() => {
  resetStore();
  saveStore();
  resetIntakeRate();
});

async function login(handle) {
  const res = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ handle }),
  });
  return (await res.json()).token;
}

function authed(token, p, opts = {}) {
  return fetch(`${base}${p}`, {
    ...opts,
    headers: {
      ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
      Authorization: `Bearer ${token}`,
      ...(opts.headers || {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

async function enableAsk(handle) {
  const token = await login(handle);
  const res = await authed(token, "/api/me/pages/p1/features/ask_anything", {
    method: "PATCH",
    body: { ownerEnabled: true },
  });
  assert.equal(res.status, 200);
  return token;
}

function submit(slug = "nova", body = {}) {
  return fetch(`${base}/api/pages/${slug}/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function publicAsk(slug = "nova") {
  const res = await fetch(`${base}/api/pages/${slug}/ask`);
  if (res.status !== 200) return { status: res.status, body: null };
  return { status: 200, body: await res.json() };
}

test("01.1 a submitted question stays private until Answer & publish", async () => {
  const token = await enableAsk("nova");

  const publicBefore = await publicAsk();
  assert.equal(publicBefore.status, 200);
  assert.deepEqual(publicBefore.body.published, [], "no public Q&A before publish");

  const sent = await submit("nova", { question: "What made you start making music?" });
  assert.equal(sent.status, 201);
  const sentBody = await sent.json();
  assert.equal(typeof sentBody.id, "string");
  assert.equal(sentBody.note.includes("privately delivered"), true);
  assert.equal("publicId" in sentBody, false, "submission reply must not reveal public record ids");

  const publicMid = await publicAsk();
  assert.equal(publicMid.body.published.length, 0, "still private immediately after submission");

  const inbox = await authed(token, "/api/me/pages/p1/features/ask_anything/inbox").then((r) => r.json());
  assert.equal(inbox.counts.pending, 1);
  assert.equal(inbox.statuses.pending[0].question, "What made you start making music?");

  const pub = await authed(token, `/api/me/pages/p1/features/ask_anything/records/${inbox.statuses.pending[0].id}/publish`, {
    method: "POST",
    body: { answer: "It started with a secondhand keyboard and a late night." },
  });
  assert.equal(pub.status, 200);

  const publicAfter = await publicAsk();
  assert.equal(publicAfter.body.published.length, 1);
  assert.equal(publicAfter.body.published[0].question, "What made you start making music?");
  assert.equal(publicAfter.body.published[0].answer, "It started with a secondhand keyboard and a late night.");
  const asName = Object.keys(publicAfter.body.published[0]).sort();
  assert.deepEqual(asName, ["answer", "id", "publishedAt", "question"], "private fields never leak");
  assert.ok(!publicAfter.body.published[0].id.startsWith("qa_"), "public ids are separate tokens");
});

test("01.2 drafts stay private; unpublish + retry publish without duplicates", async () => {
  const token = await enableAsk("nova");
  await submit("nova", { question: "Any advice for a beginner?" });
  const inbox = await authed(token, "/api/me/pages/p1/features/ask_anything/inbox").then((r) => r.json());
  const pending = inbox.statuses.pending[0];

  const saved = await authed(token, `/api/me/pages/p1/features/ask_anything/records/${pending.id}/draft`, {
    method: "POST",
    body: { answer: "Start before you feel ready." },
  });
  assert.equal(saved.status, 200);
  const savedBody = await saved.json();
  assert.equal(savedBody.record.status, "draft");

  let view = await publicAsk();
  assert.equal(view.body.published.length, 0, "draft answer is not public");

  const again = await authed(token, `/api/me/pages/p1/features/ask_anything/records/${pending.id}/publish`, {
    method: "POST",
    body: { answer: "Start before you feel ready." },
  });
  assert.equal(again.status, 200);
  view = await publicAsk();
  assert.equal(view.body.published.length, 1);
  const pubId = view.body.published[0].id;

  const retry = await authed(token, `/api/me/pages/p1/features/ask_anything/records/${pending.id}/publish`, {
    method: "POST",
    body: { answer: "Start before you feel ready." },
  });
  assert.equal((await retry.json()).message, "Already public — nothing changed.");
  view = await publicAsk();
  assert.equal(view.body.published.length, 1, "retrying publish must not duplicate");

  const unpub = await authed(token, `/api/me/pages/p1/features/ask_anything/records/${pending.id}/unpublish`, {
    method: "POST",
    body: {},
  });
  assert.equal(unpub.status, 200);
  view = await publicAsk();
  assert.equal(view.body.published.length, 0, "unpublished answer leaves public view");

  const repub = await authed(token, `/api/me/pages/p1/features/ask_anything/records/${pending.id}/publish`, {
    method: "POST",
    body: { answer: "Start before you feel ready." },
  });
  assert.equal(repub.status, 200);
  view = await publicAsk();
  assert.equal(view.body.published.length, 1);
  assert.equal(view.body.published[0].id, pubId, "same public record after reload");
});

test("01.3 another owner cannot read the inbox nor answer; off blocks stale submissions", async () => {
  const nova = await login("nova");
  const luna = await login("luna");

  await enableAsk("nova");
  await submit("nova", { question: "Secret to luna?" });
  const inbox = await authed(nova, "/api/me/pages/p1/features/ask_anything/inbox").then((r) => r.json());
  const recordId = inbox.statuses.pending[0].id;

  const readBlocked = await authed(luna, "/api/me/pages/p1/features/ask_anything/inbox");
  assert.equal(readBlocked.status, 403, "another owner cannot read the inbox");
  const answerBlocked = await authed(luna, `/api/me/pages/p1/features/ask_anything/records/${recordId}/publish`, {
    method: "POST",
    body: { answer: "sneaky" },
  });
  assert.equal(answerBlocked.status, 403, "another owner cannot answer");

  await authed(nova, "/api/me/pages/p1/features/ask_anything", { method: "PATCH", body: { ownerEnabled: false } });
  const stale = await submit("nova", { question: "Stale submission" });
  assert.equal(stale.status, 403, "feature off blocks stale form submission");
  assert.equal((await publicAsk()).status, 404, "feature off hides the public Q&A container");
});

test("pausing intake keeps published answers visible but closes the form", async () => {
  const token = await enableAsk("nova");
  await submit("nova", { question: "Pause test" });
  const inbox = await authed(token, "/api/me/pages/p1/features/ask_anything/inbox").then((r) => r.json());
  await authed(token, `/api/me/pages/p1/features/ask_anything/records/${inbox.statuses.pending[0].id}/publish`, {
    method: "POST",
    body: { answer: "Still visible when intake is paused." },
  });

  await authed(token, "/api/me/pages/p1/features/ask_anything", {
    method: "PATCH",
    body: { config: { acceptNew: false } },
  });
  const pub = await authed(token, "/api/me/pages/p1/features/ask_anything/publish", { method: "POST", body: {} });
  assert.equal(pub.status, 200);

  const view = await publicAsk();
  assert.equal(view.body.config.acceptNew, false);
  assert.equal(view.body.published.length, 1, "published answers stay visible when intake paused");

  const blocked = await submit("nova", { question: "Should be blocked" });
  assert.equal(blocked.status, 403);
});

test("question length cap from configured config is enforced", async () => {
  const token = await enableAsk("nova");
  await authed(token, "/api/me/pages/p1/features/ask_anything", {
    method: "PATCH",
    body: { config: { lengthCap: 20 } },
  });
  await authed(token, "/api/me/pages/p1/features/ask_anything/publish", { method: "POST", body: {} });

  const ok = await submit("nova", { question: "Short question here" });
  assert.equal(ok.status, 201);

  const long = await submit("nova", { question: "x".repeat(21) });
  assert.equal(long.status, 422);
  const body = await long.json();
  assert.match(body.errors.question, /20 characters/);
});

test("cap answer length and reject empty answers", async () => {
  const token = await enableAsk("nova");
  await submit("nova", { question: "Answer validation?" });
  const inbox = await authed(token, "/api/me/pages/p1/features/ask_anything/inbox").then((r) => r.json());
  const id = inbox.statuses.pending[0].id;

  const empty = await authed(token, `/api/me/pages/p1/features/ask_anything/records/${id}/publish`, {
    method: "POST",
    body: { answer: "  " },
  });
  assert.equal(empty.status, 422);

  const huge = await authed(token, `/api/me/pages/p1/features/ask_anything/records/${id}/publish`, {
    method: "POST",
    body: { answer: "y".repeat(2001) },
  });
  assert.equal(huge.status, 422);
});

test("owner reorders published Q&A and public view follows", async () => {
  const token = await enableAsk("nova");
  const made = [];
  for (const q of ["First", "Second", "Third"]) {
    await submit("nova", { question: q });
  }
  const inbox = await authed(token, "/api/me/pages/p1/features/ask_anything/inbox").then((r) => r.json());
  for (const rec of inbox.statuses.pending) {
    await authed(token, `/api/me/pages/p1/features/ask_anything/records/${rec.id}/publish`, {
      method: "POST",
      body: { answer: `Answer to ${rec.question}` },
    });
    made.push(rec.id);
  }

  const current = await publicAsk();
  assert.deepEqual(current.body.published.map((p) => p.question), ["First", "Second", "Third"]);

  const reorder = await authed(token, "/api/me/pages/p1/features/ask_anything/reorder", {
    method: "POST",
    body: { order: [made[2], made[0], made[1]] },
  });
  assert.equal(reorder.status, 200);

  const after = await publicAsk();
  assert.deepEqual(after.body.published.map((p) => p.question), ["Third", "First", "Second"]);
});

test("admin moderation can unpublish and delete published content", async () => {
  const admin = await login("admin");
  const nova = await enableAsk("nova");
  await submit("nova", { question: "Moderate me" });
  const inbox = await authed(nova, "/api/me/pages/p1/features/ask_anything/inbox").then((r) => r.json());
  const rec = inbox.statuses.pending[0];
  await authed(nova, `/api/me/pages/p1/features/ask_anything/records/${rec.id}/publish`, {
    method: "POST",
    body: { answer: "Publicly visible." },
  });

  const list = await authed(admin, "/api/admin/features/ask_anything/content").then((r) => r.json());
  assert.equal(list.content.length, 1);
  assert.equal(list.content[0].pageSlug, "nova");

  const noReason = await authed(admin, `/api/admin/features/ask_anything/content/${rec.id}/action`, {
    method: "POST",
    body: { action: "unpublish" },
  });
  assert.equal(noReason.status, 422, "missing reason is rejected");
  assert.equal((await publicAsk()).body.published.length, 1);

  const client = await fetch(`${base}/api/admin/features/ask_anything/content/${rec.id}/action`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${nova}` },
    body: JSON.stringify({ action: "unpublish", reason: "test" }),
  });
  assert.equal(client.status, 403, "owners cannot moderate their own published content");

  const ok = await authed(admin, `/api/admin/features/ask_anything/content/${rec.id}/action`, {
    method: "POST",
    body: { action: "unpublish", reason: "test moderation" },
  });
  assert.equal(ok.status, 200);
  assert.equal((await publicAsk()).body.published.length, 0);
});