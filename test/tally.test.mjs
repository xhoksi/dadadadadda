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
let clock;

before(async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "misa-tally-"));
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
  clock = new Date("2026-05-01T08:00:00Z");
  setServerClock(() => clock);
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

async function saveTally(cfgOver = {}) {
  const cfg = { question: "Tea or coffee?", options: ["Tea", "Coffee"], visibility: "after_vote", acceptVotes: true, ...cfgOver };
  return authed(ownerToken, `/api/me/pages/p1/features/tally`, { method: "PATCH", body: { config: cfg } });
}

async function publishTally(cfgOver = {}) {
  await authed(ownerToken, `/api/me/pages/p1/features/tally`, { method: "PATCH", body: { ownerEnabled: true } });
  const saved = await saveTally(cfgOver);
  assert.equal(saved.status, 200);
  const pub = await authed(ownerToken, `/api/me/pages/p1/features/tally/publish`, { method: "POST", body: {} });
  assert.equal(pub.status, 200);
}

async function publicPoll() {
  const page = await (await fetch(`${base}/api/pages/nova`)).json();
  return page.tally;
}

function vote(pollId, optionId, token, idempotencyKey) {
  return fetch(`${base}/api/pages/nova/polls/${pollId}/votes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ optionId, token, idempotencyKey }),
  });
}

test("13.1 rejects too few/many options, invalid option ids and votes on a closed poll", async () => {
  await authed(ownerToken, `/api/me/pages/p1/features/tally`, { method: "PATCH", body: { ownerEnabled: true } });
  assert.equal((await saveTally({ options: ["Only one"] })).status, 422);
  assert.equal((await saveTally({ options: ["A", "B", "C", "D", "E"] })).status, 422);

  await publishTally();
  const poll = await publicPoll();
  assert.equal(poll.options.length, 2);

  assert.equal((await vote(poll.pollId, "opt_notreal", "token-aaaa")).status, 422, "invalid option id");
  assert.equal((await vote(poll.pollId, poll.options[0].id, "token-aaaa")).status, 200);

  await authed(ownerToken, `/api/me/pages/p1/features/tally/close`, { method: "POST", body: {} });
  const closed = await publicPoll();
  assert.equal(closed.status, "closed");
  assert.equal((await vote(closed.pollId, closed.options[1].id, "token-bbbb")).status, 409, "votes on a closed poll are rejected");
  assert.equal((await vote(closed.pollId, closed.options[1].id, "token-cccc")).status, 409);
});

test("13.2 parallel duplicates count once and public reads never expose dedup keys", async () => {
  await publishTally({ visibility: "always" });
  const poll = await publicPoll();
  const opt = poll.options[0].id;

  const [a, b] = await Promise.all([
    vote(poll.pollId, opt, "token-dupe").then((r) => r.json()),
    vote(poll.pollId, opt, "token-dupe").then((r) => r.json()),
  ]);
  const incremented = [a, b].filter((r) => r.incremented);
  assert.equal(incremented.length, 1, "only one counter increment");
  assert.equal(incremented[0].total, 1);

  // A retry with the same idempotency key, even from another token, adds nothing.
  const first = await vote(poll.pollId, poll.options[1].id, "token-other", "idem-123").then((r) => r.json());
  assert.equal(first.incremented, true);
  const retry = await vote(poll.pollId, poll.options[1].id, "token-other-2", "idem-123").then((r) => r.json());
  assert.equal(retry.incremented, false);
  assert.equal(retry.total, 2);

  const after = await publicPoll();
  assert.equal(after.total, 2);
  const optionIds = new Set(after.options.map((o) => o.id));
  for (const key of Object.keys(after.totals)) {
    assert.ok(optionIds.has(key), "totals only contain option ids, never dedup keys");
  }
  assert.ok(!Object.prototype.hasOwnProperty.call(after, "seen"));
  assert.ok(!JSON.stringify(after).includes("token-dupe"));
});

test("13.3 hide/re-enable preserves totals; edits after voting create a new poll revision", async () => {
  await publishTally();
  let poll = await publicPoll();
  await vote(poll.pollId, poll.options[0].id, "token-rev1");

  await authed(ownerToken, `/api/me/pages/p1/features/tally`, { method: "PATCH", body: { ownerEnabled: false } });
  let page = await (await fetch(`${base}/api/pages/nova`)).json();
  assert.equal(page.tally, null, "feature off hides poll and results");
  await authed(ownerToken, `/api/me/pages/p1/features/tally`, { method: "PATCH", body: { ownerEnabled: true } });
  poll = await publicPoll();
  assert.equal(poll.total, 1, "hide/re-enable preserves totals");

  // Substantive edits after a vote create a new revision with new option ids.
  await saveTally({ question: "Tea, coffee or water?", options: ["Tea", "Coffee", "Water"] });
  const pub = await authed(ownerToken, `/api/me/pages/p1/features/tally/publish`, { method: "POST", body: {} }).then((r) => r.json());
  assert.match(pub.message, /New poll revision 2/);
  const revision = await publicPoll();
  assert.notEqual(revision.pollId, poll.pollId);
  assert.equal(revision.revision, 2);
  assert.equal(revision.total, 0, "old totals stay separated");

  const oldOption = poll.options[0].id;
  assert.equal((await vote(poll.pollId, oldOption, "token-old-form")).status, 409, "an old form cannot vote into the new revision");

  const history = await authed(ownerToken, `/api/me/pages/p1/features/tally`).then((r) => r.json());
  assert.equal(history.state.current.revision, 2);
  assert.ok(history.state.history.some((h) => h.revision === 1 && h.total === 1), "old poll retained privately");

  // Closing keeps results visible per visibility; reopen works before keys expire.
  await authed(ownerToken, `/api/me/pages/p1/features/tally/close`, { method: "POST", body: {} });
  const closed = await publicPoll();
  assert.equal(closed.status, "closed");
  const reopened = await authed(ownerToken, `/api/me/pages/p1/features/tally/reopen`, { method: "POST", body: {} });
  assert.equal(reopened.status, 200);

  // After the dedup retention window, reopening requires a reset.
  await authed(adminToken, `/api/admin/features/tally`, { method: "PATCH", body: { limits: { retentionMs: 1000 } } });
  await authed(ownerToken, `/api/me/pages/p1/features/tally/close`, { method: "POST", body: {} });
  clock = new Date("2026-05-01T08:00:10Z");
  await publicPoll();
  const blocked = await authed(ownerToken, `/api/me/pages/p1/features/tally/reopen`, { method: "POST", body: {} });
  assert.equal(blocked.status, 409, "expired dedup keys require a reset");
  const reset = await authed(ownerToken, `/api/me/pages/p1/features/tally/reset`, { method: "POST", body: {} });
  assert.equal(reset.status, 200);
  const fresh = await publicPoll();
  assert.equal(fresh.total, 0);
  assert.equal(fresh.status, "open");
});

test("13.x page UI: voting shows scratch marks and numeric counts; a closed poll hides the form", async () => {
  await publishTally({ visibility: "always" });
  const mount = async () => {
    const dom = new JSDOM("", { url: `${base}/p/nova`, pretendToBeVisual: true, runScripts: "outside-only" });
    dom.window.fetch = (input, opts) => fetch(new URL(input, base).toString(), opts);
    dom.window.setInterval = () => 0;
    dom.window.document.documentElement.innerHTML = await fetch(`${base}/page.html`).then((r) => r.text());
    dom.window.eval(readFileSync(new URL("../public/page.js", import.meta.url), "utf8"));
    await new Promise((r) => setTimeout(r, 120));
    return dom;
  };

  let dom = await mount();
  let doc = dom.window.document;
  assert.equal(doc.getElementById("tally").hidden, false);
  assert.equal(doc.querySelectorAll("#tally-options .tally-option").length, 2);
  doc.querySelector("#tally-options input").checked = true;
  doc.getElementById("tally-form").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(doc.getElementById("tally-results").hidden, false);
  assert.equal(doc.querySelector("#tally-results .tally-count").textContent, "1");
  assert.equal(doc.querySelectorAll("#tally-results .tally-mark").length, 1, "one scratch mark for one vote");

  await authed(ownerToken, `/api/me/pages/p1/features/tally/close`, { method: "POST", body: {} });
  dom = await mount();
  doc = dom.window.document;
  assert.equal(doc.getElementById("tally-form").hidden, true, "closed poll hides the form");
  assert.equal(doc.getElementById("tally-results").hidden, false, "results stay visible");
  assert.ok(doc.querySelector("#tally-results .tally-count"));
});
