// Guestbook: visitor display-name + plain-text message entries held privately
// until the owner approves them. Public queries whitelist approved, nonremoved
// records only; a freshly submitted entry is never reachable by a public list,
// a direct object request, or page source.

import { randomBytes } from "node:crypto";
import { newId } from "../store.js";
import { evaluateFeature } from "../policy.js";
import { defaultConfig, getFeature } from "../registry.js";

const STATUSES = ["pending", "approved", "rejected", "removed"];

let intakeHits = new Map();

export function resetIntakeRate() {
  intakeHits = new Map();
}

function limits(store) {
  const policy = store.features.guestbook;
  return { ...getFeature("guestbook").limits, ...(policy && policy.limits) };
}

function recordsFor(store, pageId) {
  return store.guestbook.filter((r) => r.pageId === pageId);
}

export function publishedConfig(store, pageId) {
  const pf = store.pageFeatures[`${pageId}:guestbook`];
  if (pf && pf.published) return pf.published;
  return defaultConfig("guestbook");
}

function effective(store, page, now) {
  return evaluateFeature(store, page.id, "guestbook", now);
}

export function isExposed(store, page, now) {
  return effective(store, page, now).effectiveEnabled;
}

export function intakeOpen(store, page, now) {
  if (!isExposed(store, page, now)) return false;
  return !publishedConfig(store, page.id).intakePaused;
}

function audit(store, entry) {
  store.audit.push({
    id: newId("audit"),
    actor: entry.actor || "system",
    scope: entry.scope || "page",
    feature: "guestbook",
    action: entry.action,
    before: entry.before || {},
    after: entry.after || {},
    reason: entry.reason || "",
    time: entry.time,
  });
}

function checkRate(store, ip, now) {
  const lim = limits(store);
  const windowMs = lim.rateWindowMs;
  const t = Date.parse(now);
  const arr = (intakeHits.get(ip) || []).filter((ts) => t - ts < windowMs);
  if (arr.length >= lim.rateMax) {
    intakeHits.set(ip, arr);
    return { limited: true, retryAfterMs: windowMs - (t - arr[0]), windowMs, max: lim.rateMax };
  }
  arr.push(t);
  intakeHits.set(ip, arr);
  return { limited: false };
}

function applyQueueLimit(store, pageId) {
  const qmax = limits(store).queueMax;
  const pending = recordsFor(store, pageId)
    .filter((r) => r.status === "pending")
    .sort((a, b) => a.submittedAt.localeCompare(b.submittedAt));
  if (pending.length > qmax) {
    const drop = new Set(pending.slice(0, pending.length - qmax).map((r) => r.id));
    store.guestbook = store.guestbook.filter((r) => !drop.has(r.id));
  }
}

function validateEntry(store, body) {
  const lim = limits(store);
  const errors = {};
  const displayName = body && typeof body.displayName === "string" ? body.displayName.trim() : "";
  const message = body && typeof body.message === "string" ? body.message.trim() : "";
  if (displayName.length < 1) errors.displayName = "A display name is required.";
  else if (displayName.length > lim.nameMax) errors.displayName = `Names are limited to ${lim.nameMax} characters.`;
  if (message.length < 1) errors.message = "A message is required.";
  else if (message.length > lim.messageMax) errors.message = `Messages are limited to ${lim.messageMax} characters.`;
  return { errors, displayName, message };
}

export function submitEntry(store, page, body, ip, now) {
  if (!isExposed(store, page, now)) return { ok: false, status: 403, message: "The guestbook is closed right now." };
  if (publishedConfig(store, page.id).intakePaused) {
    return { ok: false, status: 403, message: "The guestbook is not accepting new entries right now." };
  }
  const rate = checkRate(store, ip, now);
  if (rate.limited) {
    return {
      ok: false,
      status: 429,
      message: "Too many recent entries. Please wait and try again.",
      retryAfterMs: rate.retryAfterMs,
      retryAfterSec: Math.ceil(rate.retryAfterMs / 1000),
    };
  }
  const { errors, displayName, message } = validateEntry(store, body);
  if (Object.keys(errors).length > 0) {
    return { ok: false, status: 422, message: "Your entry was not saved. Please fix the errors.", errors };
  }
  const record = {
    id: newId("gb"),
    pageId: page.id,
    status: "pending",
    displayName,
    message,
    pinned: false,
    orderIdx: 0,
    submittedAt: now,
    approvedAt: null,
    removedAt: null,
    publicId: null,
    version: 1,
    updatedAt: now,
  };
  store.guestbook.push(record);
  applyQueueLimit(store, page.id);
  audit(store, { actor: page.id, action: "intake.guestbook_entry", after: { record: record.id }, time: now });
  return {
    ok: true,
    record,
    note: "Thank you. Your entry waits privately until the owner approves it; only approved entries appear on the profile.",
  };
}

function sanitize(r) {
  return { id: r.publicId, displayName: r.displayName, message: r.message, approvedAt: r.approvedAt, pinned: !!r.pinned };
}

function orderFor(store, pageId) {
  const max = recordsFor(store, pageId).reduce((m, r) => Math.max(m, r.orderIdx || 0), 0);
  return max + 1;
}

function approvedFor(store, pageId) {
  return recordsFor(store, pageId).filter((r) => r.status === "approved");
}

function sortApproved(store, pageId, list) {
  const pinning = !!publishedConfig(store, pageId).pinning;
  return [...list].sort((a, b) => {
    if (pinning && !!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
    return (a.orderIdx || 0) - (b.orderIdx || 0) || String(b.approvedAt).localeCompare(String(a.approvedAt));
  });
}

function paginate(list, page, pageSize) {
  const p = Math.max(1, Number.parseInt(page, 10) || 1);
  const size = Math.max(1, Number.parseInt(pageSize, 10) || 20);
  const total = list.length;
  const start = (p - 1) * size;
  return { items: list.slice(start, start + size), page: p, pageSize: size, total, pages: Math.max(1, Math.ceil(total / size)) };
}

export function publicView(store, page, now, opts = {}) {
  if (!isExposed(store, page, now)) return null;
  const config = publishedConfig(store, page.id);
  const lim = limits(store);
  const pageSize = Math.min(lim.visibleMax, Math.max(1, Number.parseInt(opts.pageSize, 10) || lim.visibleMax));
  const list = sortApproved(store, page.id, approvedFor(store, page.id)).map(sanitize);
  const pageData = paginate(list, opts.page, pageSize);
  return {
    config: {
      heading: config.heading,
      prompt: config.prompt,
      intakePaused: !!config.intakePaused,
      pinning: !!config.pinning,
      handwriting: config.handwriting,
      nameMax: lim.nameMax,
      messageMax: lim.messageMax,
    },
    entries: pageData.items,
    page: { page: pageData.page, pageSize: pageData.pageSize, total: pageData.total, pages: pageData.pages },
    acceptNew: !config.intakePaused,
  };
}

export function publicEntry(store, page, publicId, now) {
  if (!isExposed(store, page, now)) return null;
  const rec = recordsFor(store, page.id).find((r) => r.status === "approved" && r.publicId && r.publicId === publicId);
  return rec ? sanitize(rec) : null;
}

export function inbox(store, pageId, { status, page, pageSize } = {}) {
  const counts = {};
  for (const s of STATUSES) counts[s] = recordsFor(store, pageId).filter((r) => r.status === s).length;
  const wanted = STATUSES.includes(status) ? status : "pending";
  const list = recordsFor(store, pageId)
    .filter((r) => r.status === wanted)
    .sort((a, b) => (wanted === "pending" ? a.submittedAt.localeCompare(b.submittedAt) : String(b.updatedAt).localeCompare(String(a.updatedAt))));
  const pageData = paginate(list, page, pageSize);
  return { statuses: STATUSES, status: wanted, counts, entries: pageData.items.map((r) => structuredClone(r)), page: { page: pageData.page, pageSize: pageData.pageSize, total: pageData.total, pages: pageData.pages } };
}

function findRecord(store, pageId, recordId) {
  return recordsFor(store, pageId).find((r) => r.id === recordId) || null;
}

export function moderate(store, page, recordId, action, body, now) {
  const rec = findRecord(store, page.id, recordId);
  if (!rec) return { ok: false, status: 404, message: "Entry not found." };
  const expectedVersion = body && body.expectedVersion;
  if (expectedVersion !== undefined && expectedVersion !== rec.version) {
    return { ok: false, status: 409, message: "Stale moderation. Reload the latest state and try again.", after: structuredClone(rec) };
  }
  const from = rec.status;
  if (action === "approve") {
    if (rec.status === "approved") return { ok: true, record: rec, message: "Already approved — nothing changed." };
    rec.status = "approved";
    rec.approvedAt = rec.approvedAt || now;
    rec.publicId = rec.publicId || randomBytes(8).toString("hex");
    rec.orderIdx = rec.orderIdx || orderFor(store, page.id);
    rec.removedAt = null;
  } else if (action === "reject") {
    if (rec.status === "rejected") return { ok: true, record: rec, message: "Already rejected — nothing changed." };
    rec.status = "rejected";
  } else if (action === "remove") {
    if (rec.status === "removed") return { ok: true, record: rec, message: "Already removed — nothing changed." };
    rec.status = "removed";
    rec.removedAt = now;
  } else if (action === "pin") {
    if (!publishedConfig(store, page.id).pinning) {
      return { ok: false, status: 409, message: "Enable pinning in the guestbook settings before pinning entries." };
    }
    if (rec.status !== "approved") return { ok: false, status: 409, message: "Only approved entries can be pinned." };
    rec.pinned = typeof body.pinned === "boolean" ? body.pinned : !rec.pinned;
  } else {
    return { ok: false, status: 422, message: "action must be one of: approve, reject, remove, pin." };
  }
  rec.version += 1;
  rec.updatedAt = now;
  audit(store, {
    actor: page.ownerId,
    action: `owner.guestbook_${action}`,
    before: { status: from, version: rec.version - 1 },
    after: { status: rec.status, version: rec.version, pinned: rec.pinned },
    time: now,
  });
  const msgs = {
    approve: "Approved. The entry is now public.",
    reject: "Rejected. It stays private and will not appear.",
    remove: "Removed from public view. It remains in the private queue.",
    pin: rec.pinned ? "Pinned to the top." : "Unpinned.",
  };
  return { ok: true, record: rec, message: msgs[action] };
}

export function deleteEntry(store, page, recordId, now) {
  const globalIdx = store.guestbook.findIndex((r) => r.id === recordId && r.pageId === page.id);
  if (globalIdx === -1) return { ok: false, status: 404, message: "Entry not found." };
  const [rec] = store.guestbook.splice(globalIdx, 1);
  audit(store, { actor: page.ownerId, action: "owner.guestbook_delete", before: { status: rec.status }, after: {}, time: now });
  return { ok: true, message: "Deleted permanently. It cannot reappear through a cached or historical view." };
}

export function reorder(store, page, order, now) {
  if (!Array.isArray(order)) return { ok: false, status: 422, message: "order must be an array of entry ids." };
  const list = approvedFor(store, page.id);
  const byId = new Map(list.map((r) => [r.id, r]));
  const ids = order.map(String);
  const unique = ids.length === new Set(ids).size;
  if (!unique || ids.length !== list.length || ids.some((id) => !byId.has(id))) {
    return { ok: false, status: 422, message: "order must list every approved entry exactly once." };
  }
  ids.forEach((id, i) => {
    byId.get(id).orderIdx = i + 1;
  });
  audit(store, { actor: page.ownerId, action: "owner.guestbook_reorder", before: {}, after: { order: ids }, time: now });
  return { ok: true, message: "Approved-entry order updated." };
}

export function adminContent(store) {
  return store.guestbook
    .filter((r) => r.status === "approved")
    .map((r) => ({
      id: r.id,
      publicId: r.publicId,
      pageId: r.pageId,
      pageSlug: store.pages[r.pageId] ? store.pages[r.pageId].slug : null,
      displayName: r.displayName,
      message: r.message,
      submittedAt: r.submittedAt,
      approvedAt: r.approvedAt,
    }))
    .sort((a, b) => String(b.approvedAt).localeCompare(String(a.approvedAt)));
}

export function adminAction(store, recordId, action, actorId, reason, now) {
  const rec = store.guestbook.find((r) => r.id === recordId && r.status === "approved");
  if (!rec) return { ok: false, status: 404, message: "Approved entry not found." };
  if (!reason || typeof reason !== "string" || reason.trim().length === 0) {
    return { ok: false, status: 422, message: "A reason is required for moderation." };
  }
  if (action === "unpublish") {
    rec.status = "removed";
    rec.removedAt = now;
    rec.version += 1;
    rec.updatedAt = now;
    audit(store, { actor: actorId, scope: "moderation", action: "admin.remove_entry", before: { status: "approved" }, after: { status: "removed" }, reason: reason.trim(), time: now });
    return { ok: true, message: "Removed from public view." };
  }
  if (action === "delete") {
    store.guestbook.splice(store.guestbook.indexOf(rec), 1);
    audit(store, { actor: actorId, scope: "moderation", action: "admin.delete_entry", before: { status: "approved" }, after: {}, reason: reason.trim(), time: now });
    return { ok: true, message: "Deleted permanently." };
  }
  return { ok: false, status: 422, message: "action must be one of: unpublish, delete." };
}
