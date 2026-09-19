// The tally: one anonymous poll with two to four answers. Votes are
// deduplicated with a salted pseudonymous key (never a raw identity), counted
// transactionally, and public reads expose totals only — never dedup keys.

import crypto from "node:crypto";
import { evaluateFeature } from "../policy.js";
import { getFeature } from "../registry.js";

function limits(store) {
  const policy = store.features.tally;
  return { ...getFeature("tally").limits, ...(policy && policy.limits) };
}

function pfFor(store, pageId) {
  return store.pageFeatures[`${pageId}:tally`] || null;
}

function pollsFor(store, pageId) {
  return store.tallyPolls.filter((p) => p.pageId === pageId);
}

export function publishedPoll(store, page) {
  const pf = pfFor(store, page.id);
  if (!pf || !pf.published || !pf.published.pollId) return null;
  return store.tallyPolls.find((p) => p.id === pf.published.pollId) || null;
}

export function exposed(store, page, now) {
  return evaluateFeature(store, page.id, "tally", now).effectiveEnabled;
}

function optionId() {
  return `opt_${crypto.randomBytes(4).toString("hex")}`;
}

function normalizeOptions(options) {
  return options.map((label) => ({ id: optionId(), label: String(label).trim() }));
}

function newPoll(page, revision, question, options, visibility, acceptVotes, now) {
  return {
    id: `poll_${crypto.randomBytes(6).toString("hex")}`,
    pageId: page.id,
    revision,
    question,
    options,
    visibility,
    acceptVotes,
    status: "open",
    counts: {},
    seen: {},
    idempotency: {},
    total: 0,
    salt: crypto.randomBytes(16).toString("hex"),
    keysPurged: false,
    createdAt: now,
    publishedAt: now,
    closedAt: null,
  };
}

// Purge pseudonymous dedup keys once a closed poll passes the retention window.
export function purgeExpired(store, now) {
  const lim = limits(store);
  const t = Date.parse(now);
  for (const poll of store.tallyPolls) {
    if (poll.status === "closed" && poll.closedAt && t - Date.parse(poll.closedAt) > lim.retentionMs) {
      poll.keysPurged = true;
      poll.seen = {};
      poll.idempotency = {};
      store.tallyVotes = (store.tallyVotes || []).filter((v) => v.pollId !== poll.id);
    }
  }
}

function totalsFor(poll, visibility, status, hasVoted) {
  if (visibility === "always") return true;
  if (visibility === "after_close") return status === "closed";
  return status === "closed" || !!hasVoted;
}

export function publicView(store, page, now) {
  if (!exposed(store, page, now)) return null;
  purgeExpired(store, now);
  const poll = publishedPoll(store, page);
  if (!poll) return null;
  const show = totalsFor(poll, poll.visibility, poll.status, false);
  return {
    pollId: poll.id,
    revision: poll.revision,
    question: poll.question,
    status: poll.status,
    visibility: poll.visibility,
    acceptVotes: poll.acceptVotes && poll.status === "open",
    options: poll.options.map((o) => ({ id: o.id, label: o.label })),
    total: poll.total,
    totals: show ? { ...poll.counts } : null,
  };
}

export function ownerView(store, page, now) {
  purgeExpired(store, now);
  const poll = publishedPoll(store, page);
  const current = poll
    ? {
        pollId: poll.id,
        revision: poll.revision,
        question: poll.question,
        options: poll.options,
        status: poll.status,
        visibility: poll.visibility,
        acceptVotes: poll.acceptVotes,
        total: poll.total,
        counts: poll.options.map((o) => ({ id: o.id, label: o.label, count: poll.counts[o.id] || 0 })),
        canReopen: poll.status === "closed" && !poll.keysPurged,
      }
    : null;
  const history = pollsFor(store, page.id)
    .filter((p) => !poll || p.id !== poll.id)
    .map((p) => ({ pollId: p.id, revision: p.revision, question: p.question, total: p.total, status: p.status, closedAt: p.closedAt }));
  return { current, history };
}

function validatePollConfig(cfg, lim) {
  const errors = {};
  const question = typeof cfg.question === "string" ? cfg.question.trim() : "";
  if (!question) errors.question = "A question is required.";
  else if (question.length > lim.questionMax) errors.question = `At most ${lim.questionMax} characters.`;
  const options = Array.isArray(cfg.options) ? cfg.options.map((o) => String(o).trim()).filter((o) => o.length > 0) : [];
  if (options.length < lim.optionsMin) errors.options = `At least ${lim.optionsMin} options.`;
  else if (options.length > lim.optionsMax) errors.options = `At most ${lim.optionsMax} options.`;
  else if (options.some((o) => o.length > lim.optionMax)) errors.options = `Each option is at most ${lim.optionMax} characters.`;
  else if (new Set(options).size !== options.length) errors.options = "Options must be unique.";
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, question, options };
}

// Publishing with no votes edits the poll in place; substantive edits after a
// vote create a new revision so the old totals stay separated.
export function publishPoll(store, page, cfg, now) {
  const lim = limits(store);
  const valid = validatePollConfig(cfg, lim);
  if (!valid.ok) return { ok: false, status: 422, message: "Draft does not validate. Nothing was published.", errors: valid.errors };
  const existing = publishedPoll(store, page);
  const substantive = existing && (existing.question !== valid.question || JSON.stringify(existing.options.map((o) => o.label)) !== JSON.stringify(valid.options));
  if (existing && existing.total > 0 && substantive) {
    const revision = Math.max(...pollsFor(store, page.id).map((p) => p.revision)) + 1;
    const poll = newPoll(page, revision, valid.question, normalizeOptions(valid.options), cfg.visibility || existing.visibility, cfg.acceptVotes !== false, now);
    store.tallyPolls.push(poll);
    return { ok: true, poll, message: `New poll revision ${revision}. The previous totals stay separate.` };
  }
  if (existing) {
    existing.question = valid.question;
    if (existing.total === 0) existing.options = normalizeOptions(valid.options);
    existing.visibility = cfg.visibility || existing.visibility;
    existing.acceptVotes = cfg.acceptVotes !== false;
    existing.publishedAt = now;
    return { ok: true, poll: existing, message: "Poll updated." };
  }
  const poll = newPoll(page, 1, valid.question, normalizeOptions(valid.options), cfg.visibility || "after_vote", cfg.acceptVotes !== false, now);
  store.tallyPolls.push(poll);
  return { ok: true, poll, message: "Published. Voting is open." };
}

export function closePoll(store, page, now) {
  const poll = publishedPoll(store, page);
  if (!poll) return { ok: false, status: 404, message: "No published poll." };
  poll.status = "closed";
  poll.closedAt = now;
  return { ok: true, pollId: poll.id, status: "closed", message: "Voting closed. Totals follow the visibility rule." };
}

export function reopenPoll(store, page, now) {
  purgeExpired(store, now);
  const poll = publishedPoll(store, page);
  if (!poll) return { ok: false, status: 404, message: "No published poll." };
  if (poll.keysPurged) return { ok: false, status: 409, message: "Dedup keys expired. Reset to start a new poll." };
  poll.status = "open";
  poll.closedAt = null;
  return { ok: true, pollId: poll.id, status: "open", message: "Voting reopened." };
}

export function resetPoll(store, page, now) {
  const pf = pfFor(store, page.id);
  const poll = publishedPoll(store, page);
  if (!pf || !poll) return { ok: false, status: 404, message: "No published poll." };
  const next = newPoll(
    page,
    Math.max(...pollsFor(store, page.id).map((p) => p.revision)) + 1,
    poll.question,
    poll.options.map((o) => ({ id: optionId(), label: o.label })),
    poll.visibility,
    poll.acceptVotes,
    now
  );
  store.tallyPolls.push(next);
  pf.published = { ...(pf.published || {}), pollId: next.id, question: next.question, options: next.options.map((o) => o.label), visibility: next.visibility, acceptVotes: next.acceptVotes };
  store.tallyVotes = (store.tallyVotes || []).filter((v) => v.pollId !== poll.id);
  pf.version += 1;
  pf.updatedAt = now;
  return { ok: true, pollId: next.id, revision: next.revision, message: "Reset. Previous totals are kept separately." };
}

export function castVote(store, page, pollId, body, now) {
  if (!exposed(store, page, now)) return { ok: false, status: 404, message: "Voting is not available." };
  purgeExpired(store, now);
  const current = publishedPoll(store, page);
  if (!current || current.id !== pollId) return { ok: false, status: 409, message: "This poll is no longer current. Reload the page." };
  if (current.status !== "open" || !current.acceptVotes) return { ok: false, status: 409, message: "Voting is closed for this poll." };
  const chosen = body && body.optionId;
  if (!current.options.some((o) => o.id === chosen)) return { ok: false, status: 422, message: "That option is not part of this poll." };
  const token = body && body.token;
  if (typeof token !== "string" || token.length < 8) return { ok: false, status: 422, message: "A page-scoped browser token is required." };
  const idempotencyKey = body && body.idempotencyKey;
  if (idempotencyKey) {
    const prior = current.idempotency && current.idempotency[idempotencyKey];
    if (prior) {
      return { ok: true, incremented: false, pollId: current.id, optionId: prior.optionId, total: current.total, totals: totalsFor(current, current.visibility, current.status, true) ? { ...current.counts } : null };
    }
  }
  const key = crypto.createHmac("sha256", current.salt).update(token).digest("hex");
  if (current.seen[key]) {
    return { ok: true, incremented: false, pollId: current.id, total: current.total, totals: totalsFor(current, current.visibility, current.status, true) ? { ...current.counts } : null, alreadyVoted: true };
  }
  current.counts[chosen] = (current.counts[chosen] || 0) + 1;
  current.seen[key] = true;
  current.total += 1;
  current.updatedAt = now;
  store.tallyVotes = store.tallyVotes || [];
  store.tallyVotes.push({ id: `vote_${crypto.randomBytes(6).toString("hex")}`, pollId: current.id, key, optionId: chosen, createdAt: now });
  if (idempotencyKey) {
    current.idempotency = current.idempotency || {};
    current.idempotency[idempotencyKey] = { optionId: chosen };
  }
  return { ok: true, incremented: true, pollId: current.id, optionId: chosen, total: current.total, totals: totalsFor(current, current.visibility, current.status, true) ? { ...current.counts } : null };
}

export function adminContent(store) {
  const totals = {};
  for (const poll of store.tallyPolls) totals[poll.pageId] = (totals[poll.pageId] || 0) + poll.total;
  return { polls: store.tallyPolls.length, pages: totals };
}
