import { randomBytes } from "node:crypto";
import { newId } from "../store.js";
import { evaluateFeature } from "../policy.js";
import { defaultConfig } from "../registry.js";

export const ASK_RATE = { windowMs: 10 * 60 * 1000, max: 25 };
const QUESTION_MAX = 500;
export const ANSWER_MAX = 2000;
export const CONTACT_MAX = 200;
const RETAIN = { pending: 400, draft: 200, published: 200, rejected: 400 };

let intakeHits = new Map();

export function resetIntakeRate() {
  intakeHits = new Map();
}

function audit(store, entry) {
  store.audit.push({
    id: newId("audit"),
    actor: entry.actor || "system",
    scope: entry.scope || "page",
    feature: "ask_anything",
    action: entry.action,
    before: entry.before || {},
    after: entry.after || {},
    reason: entry.reason || "",
    time: entry.time,
  });
}

function recordsFor(store, pageId) {
  return store.askAnything.filter((r) => r.pageId === pageId);
}

export function publishedConfig(store, pageId) {
  const pf = store.pageFeatures[`${pageId}:ask_anything`];
  if (pf && pf.published) return pf.published;
  return defaultConfig("ask_anything");
}

function effective(store, page, now) {
  return evaluateFeature(store, page.id, "ask_anything", now);
}

export function isExposed(store, page, now) {
  return effective(store, page, now).effectiveEnabled;
}

export function intakeOpen(store, page, now) {
  if (!isExposed(store, page, now)) return false;
  return !!publishedConfig(store, page.id).acceptNew;
}

function checkRate(ip, now) {
  const t = Date.parse(now);
  const arr = (intakeHits.get(ip) || []).filter((ts) => t - ts < ASK_RATE.windowMs);
  if (arr.length >= ASK_RATE.max) {
    intakeHits.set(ip, arr);
    return { limited: true, retryAfterMs: ASK_RATE.windowMs - (t - arr[0]) };
  }
  arr.push(t);
  intakeHits.set(ip, arr);
  return { limited: false };
}

function applyRetention(store, pageId) {
  for (const status of Object.keys(RETAIN)) {
    const list = recordsFor(store, pageId).filter((r) => r.status === status);
    if (list.length > RETAIN[status]) {
      const drop = new Set(list.slice(0, list.length - RETAIN[status]).map((r) => r.id));
      store.askAnything = store.askAnything.filter((r) => !drop.has(r.id));
    }
  }
}

export function submitQuestion(store, page, body, ip, now) {
  if (!intakeOpen(store, page, now)) return { ok: false, status: 403, message: "The ask form is closed right now." };
  const rate = checkRate(ip, now);
  if (rate.limited) {
    return { ok: false, status: 429, message: "Too many recent questions. Please try again later.", retryAfterMs: rate.retryAfterMs };
  }
  const errors = {};
  const q = body && typeof body.question === "string" ? body.question.trim() : "";
  const contact = body && typeof body.contact === "string" ? body.contact.trim() : "";
  const config = publishedConfig(store, page.id);
  const cap = Math.max(1, Math.min(config.lengthCap ?? QUESTION_MAX, QUESTION_MAX));
  if (q.length < 1) errors.question = "Your question must not be empty.";
  else if (q.length > cap) errors.question = `Questions are limited to ${cap} characters.`;
  if (contact.length > CONTACT_MAX) errors.contact = `Contact is limited to ${CONTACT_MAX} characters.`;
  if (Object.keys(errors).length > 0) {
    return { ok: false, status: 422, message: "Your question was not sent. Please fix the errors.", errors };
  }
  const record = {
    id: newId("qa"),
    pageId: page.id,
    status: "pending",
    question: q,
    answer: null,
    contact: contact || null,
    orderIdx: 0,
    submittedAt: now,
    publishedAt: null,
    publicId: null,
    version: 1,
    updatedAt: now,
  };
  store.askAnything.push(record);
  applyRetention(store, page.id);
  audit(store, { actor: page.id, action: "intake.question", after: { record: record.id }, time: now });
  return {
    ok: true,
    record,
    note: "Your question was privately delivered. Only questions the owner knowingly answers and publishes will appear publicly.",
  };
}

export function inbox(store, pageId) {
  const statuses = { pending: [], draft: [], published: [], rejected: [] };
  for (const r of recordsFor(store, pageId)) {
    (statuses[r.status] || statuses.pending).push(structuredClone(r));
  }
  for (const key of Object.keys(statuses)) {
    statuses[key].sort((a, b) =>
      key === "pending" ? a.submittedAt.localeCompare(b.submittedAt) : b.updatedAt.localeCompare(a.updatedAt)
    );
  }
  return { statuses, counts: { pending: statuses.pending.length, draft: statuses.draft.length, published: statuses.published.length, rejected: statuses.rejected.length } };
}

function findRecord(store, pageId, recordId) {
  return store.askAnything.find((r) => r.id === recordId && r.pageId === pageId) || null;
}

function versionCheck(rec, expectedVersion) {
  if (expectedVersion !== undefined && expectedVersion !== rec.version) return false;
  return true;
}

function validateAnswer(answer) {
  const a = typeof answer === "string" ? answer.trim() : "";
  if (a.length < 1) return { ok: false, errors: { answer: "Answer must not be empty." } };
  if (a.length > ANSWER_MAX) return { ok: false, errors: { answer: `Answers are limited to ${ANSWER_MAX} characters.` } };
  return { ok: true, value: a };
}

export function saveDraft(store, page, recordId, body, now) {
  const rec = findRecord(store, page.id, recordId);
  if (!rec) return { ok: false, status: 404, message: "Record not found." };
  if (rec.status === "published") return { ok: false, status: 409, message: "Unpublish this answer before editing it again." };
  if (!versionCheck(rec, body && body.expectedVersion)) return { ok: false, status: 409, message: "Stale edit. Reload and try again." };
  const v = validateAnswer(body && body.answer);
  if (!v.ok) return { ok: false, status: 422, message: "Answer draft was not saved.", errors: v.errors };
  const from = rec.status;
  rec.answer = v.value;
  rec.status = "draft";
  rec.version += 1;
  rec.updatedAt = now;
  audit(store, { actor: page.ownerId, action: "owner.answer_draft", before: { status: from, version: rec.version - 1 }, after: { status: "draft", version: rec.version }, time: now });
  return { ok: true, record: rec, message: "Answer draft saved. It stays private until you publish it." };
}

export function publishAnswer(store, page, recordId, body, now) {
  const rec = findRecord(store, page.id, recordId);
  if (!rec) return { ok: false, status: 404, message: "Record not found." };
  if (!versionCheck(rec, body && body.expectedVersion)) return { ok: false, status: 409, message: "Stale edit. Reload and try again." };
  const v = validateAnswer(body && body.answer);
  if (!v.ok) return { ok: false, status: 422, message: "Nothing was published.", errors: v.errors };
  if (rec.status === "published") return { ok: true, record: rec, message: "Already public — nothing changed." };
  const firstPublish = !rec.publishedAt;
  rec.answer = v.value;
  rec.status = "published";
  rec.publishedAt = rec.publishedAt || now;
  rec.publicId = rec.publicId || randomBytes(8).toString("hex");
  rec.orderIdx = rec.orderIdx || nextOrder(store, page.id);
  rec.version += 1;
  rec.updatedAt = now;
  audit(store, { actor: page.ownerId, action: "owner.publish_answer", before: { status: rec.status, firstPublish }, after: { status: "published", publicId: rec.publicId }, time: now });
  return { ok: true, record: rec, message: "Answer & question are now public." };
}

export function unpublish(store, page, recordId, body, now) {
  const rec = findRecord(store, page.id, recordId);
  if (!rec) return { ok: false, status: 404, message: "Record not found." };
  if (rec.status !== "published") return { ok: false, status: 409, message: "This record is not public." };
  if (!versionCheck(rec, body && body.expectedVersion)) return { ok: false, status: 409, message: "Stale edit. Reload and try again." };
  rec.status = "draft";
  rec.publishedAt = null;
  rec.version += 1;
  rec.updatedAt = now;
  audit(store, { actor: page.ownerId, action: "owner.unpublish_answer", before: { status: "published" }, after: { status: "draft" }, time: now });
  return { ok: true, record: rec, message: "Unpublished. The Q&A is private again." };
}

export function reject(store, page, recordId, body, now) {
  const rec = findRecord(store, page.id, recordId);
  if (!rec) return { ok: false, status: 404, message: "Record not found." };
  if (rec.status === "published") return { ok: false, status: 409, message: "Unpublish before rejecting." };
  if (!versionCheck(rec, body && body.expectedVersion)) return { ok: false, status: 409, message: "Stale edit. Reload and try again." };
  rec.status = "rejected";
  rec.version += 1;
  rec.updatedAt = now;
  audit(store, { actor: page.ownerId, action: "owner.reject_question", before: {}, after: { status: "rejected" }, time: now });
  return { ok: true, record: rec, message: "Rejected. It will never appear publicly." };
}

export function restoreDraft(store, page, recordId, body, now) {
  const rec = findRecord(store, page.id, recordId);
  if (!rec) return { ok: false, status: 404, message: "Record not found." };
  if (rec.status !== "rejected") return { ok: false, status: 409, message: "Only rejected records can be restored." };
  if (!versionCheck(rec, body && body.expectedVersion)) return { ok: false, status: 409, message: "Stale edit. Reload and try again." };
  rec.status = "draft";
  rec.version += 1;
  rec.updatedAt = now;
  return { ok: true, record: rec, message: "Moved back to drafts." };
}

export function remove(store, page, recordId, now) {
  const idx = store.askAnything.findIndex((r) => r.id === recordId && r.pageId === page.id);
  if (idx === -1) return { ok: false, status: 404, message: "Record not found." };
  const [rec] = store.askAnything.splice(idx, 1);
  audit(store, { actor: page.ownerId, action: "owner.delete_question", before: { status: rec.status }, after: {}, time: now });
  return { ok: true, message: "Deleted permanently. A deleted record is never published." };
}

export function reorder(store, page, order, now) {
  if (!Array.isArray(order)) return { ok: false, status: 422, message: "order must be an array of record ids." };
  const pub = recordsFor(store, page.id).filter((r) => r.status === "published");
  const byId = new Map(pub.map((r) => [r.id, r]));
  const ids = order.map(String);
  const unique = ids.length === new Set(ids).size;
  if (!unique || ids.length !== pub.length || ids.some((id) => !byId.has(id))) {
    return { ok: false, status: 422, message: "order must list every published record exactly once." };
  }
  ids.forEach((id, i) => {
    byId.get(id).orderIdx = i + 1;
  });
  return { ok: true, message: "Published order updated." };
}

export function publicView(store, page, now) {
  const config = publishedConfig(store, page.id);
  const exposed = effective(store, page, now).effectiveEnabled;
  const published = exposed
    ? recordsFor(store, page.id)
        .filter((r) => r.status === "published")
        .sort((a, b) => (a.orderIdx || 0) - (b.orderIdx || 0) || b.publishedAt.localeCompare(a.publishedAt))
        .map((r) => ({ id: r.publicId, question: r.question, answer: r.answer, publishedAt: r.publishedAt }))
    : [];
  return {
    config: {
      acceptNew: !!config.acceptNew,
      prompt: config.prompt,
      lengthCap: config.lengthCap,
      anonymousLabel: !!config.anonymousLabel,
      handwriting: config.handwriting,
    },
    published,
  };
}

export function adminContent(store) {
  return store.askAnything
    .filter((r) => r.status === "published")
    .map((r) => ({
      id: r.id,
      publicId: r.publicId,
      pageId: r.pageId,
      pageSlug: store.pages[r.pageId] ? store.pages[r.pageId].slug : null,
      question: r.question,
      answer: r.answer,
      submittedAt: r.submittedAt,
      publishedAt: r.publishedAt,
    }))
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
}

export function adminAction(store, recordId, action, actorId, reason, now) {
  const rec = store.askAnything.find((r) => r.id === recordId && r.status === "published");
  if (!rec) return { ok: false, status: 404, message: "Published record not found." };
  if (!reason || typeof reason !== "string" || reason.trim().length === 0) {
    return { ok: false, status: 422, message: "A reason is required for moderation." };
  }
  if (action === "unpublish") {
    rec.status = "draft";
    rec.publishedAt = null;
    rec.version += 1;
    rec.updatedAt = now;
    audit(store, { actor: actorId, scope: "moderation", action: "admin.unpublish_content", before: { status: "published" }, after: { status: "draft" }, reason: reason.trim(), time: now });
    return { ok: true, message: "Removed from public view." };
  }
  if (action === "delete") {
    store.askAnything.splice(store.askAnything.indexOf(rec), 1);
    audit(store, { actor: actorId, scope: "moderation", action: "admin.delete_content", before: { status: "published" }, after: {}, reason: reason.trim(), time: now });
    return { ok: true, message: "Deleted permanently." };
  }
  return { ok: false, status: 422, message: "action must be one of: unpublish, delete." };
}

function nextOrder(store, pageId) {
  const max = recordsFor(store, pageId).reduce((m, r) => Math.max(m, r.orderIdx || 0), 0);
  return max + 1;
}