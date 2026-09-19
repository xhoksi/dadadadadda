import { allFeatures, getFeature } from "../registry.js";
import { evaluateFeature } from "../policy.js";

// The archive: up to 12 previous page versions for recovery, plus an optional
// public browsing switch. Capture happens on every state change (drafts never
// count) and stores immutable, redacted snapshots. Restore never moves a
// pointer destructively: the pre-restore current becomes a revision and the
// restored version becomes the new current.
//
// Snapshots hold layout, text and configuration only. Inboxes, votes, presence,
// hit totals, secret-word material and capsule bodies are never captured.

const SCHEMA = 1;

export function captureAllowed(store, page, now) {
  const policy = store.features.archive;
  if (!policy || !policy.globalEnabled) return false;
  const owner = store.users[page.ownerId];
  if (!owner || owner.suspended) return false;
  if (!policy.eligiblePlans.includes(owner.plan)) return false;
  if (policy.limits && policy.limits.capturePaused) return false;
  return true;
}

function redactConfig(key, cfg) {
  const clone = structuredClone(cfg);
  if (key === "time_capsule") {
    clone.body = "";
    clone.redacted = true;
  }
  if (key === "secret_word") {
    if (clone.phrase) clone.phrase = "";
    clone.redacted = true;
  }
  return clone;
}

function contentOf(store, page) {
  const features = {};
  for (const f of allFeatures()) {
    const pf = store.pageFeatures[`${page.id}:${f.key}`];
    features[f.key] = {
      ownerEnabled: !!(pf && pf.ownerEnabled),
      published: pf && pf.published ? redactConfig(f.key, pf.published) : null,
    };
  }
  return {
    schemaVersion: SCHEMA,
    profile: structuredClone(page.profile),
    placements: structuredClone(store.placements[page.id] || null),
    features,
  };
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function hashOf(content) {
  const s = stable(content);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0).toString(16);
}

function bucket(store, page, create = false) {
  if (!store.pageArchive || typeof store.pageArchive !== "object") store.pageArchive = {};
  if (!store.pageArchive[page.id] && create) {
    store.pageArchive[page.id] = { version: 1, head: null, headHash: null, revisions: [] };
  }
  return store.pageArchive[page.id] || null;
}

function retention(store) {
  const limits = store.features.archive && store.features.archive.limits;
  return (limits && limits.revisionsMax) || 12;
}

// Capture the current page as the new head. The previous head becomes a
// revision. A no-op (content identical to the head) records nothing.
export function capture(store, page, actor, now, reason = "") {
  if (!captureAllowed(store, page, now)) return null;
  const content = contentOf(store, page);
  const h = hashOf(content);
  const b = bucket(store, page, true);
  if (b.headHash === h) return null;
  const revision = b.head
    ? { id: b.headId, time: b.headTime, actor: b.headActor, reason: b.headReason || "", content: b.head }
    : null;
  if (revision) {
    b.revisions.push(revision);
    const max = retention(store);
    if (b.revisions.length > max) b.revisions = b.revisions.slice(b.revisions.length - max);
  }
  b.head = content;
  b.headHash = h;
  b.headId = `rev_${hashOf({ ...content, n: (b.revisions.length + 1) * 1000 })}`;
  b.headTime = now;
  b.headActor = actor;
  b.headReason = reason;
  b.version += 1;
  return b.headId;
}

// The 13th change trims the oldest so at most `retention` previous versions
// remain in addition to the current head.
export function list(store, page) {
  const b = bucket(store, page);
  if (!b) return { current: null, revisions: [], publicBrowsing: false, version: 1 };
  const pf = store.pageFeatures[`${page.id}:archive`];
  return {
    current: b.head ? { id: b.headId, time: b.headTime, actor: b.headActor, reason: b.headReason || "", profile: b.head.profile } : null,
    revisions: [...b.revisions].reverse().map((r) => ({ id: r.id, time: r.time, actor: r.actor, reason: r.reason, profile: r.content.profile })),
    publicBrowsing: !!(pf && pf.published && pf.published.publicBrowsing),
    version: b.version,
  };
}

export function getRevision(store, page, rid) {
  const b = bucket(store, page);
  if (!b) return null;
  if (b.headId === rid) return { id: b.headId, time: b.headTime, actor: b.headActor, content: b.head, current: true };
  const r = b.revisions.find((x) => x.id === rid);
  if (!r) return null;
  return { id: r.id, time: r.time, actor: r.actor, content: r.content, current: false };
}

function applySnapshot(store, page, content) {
  page.profile = structuredClone(content.profile);
  if (content.placements) store.placements[page.id] = structuredClone(content.placements);
  else delete store.placements[page.id];
  for (const f of allFeatures()) {
    const src = content.features[f.key];
    const pf = store.pageFeatures[`${page.id}:${f.key}`];
    if (!pf || !src) continue;
    pf.ownerEnabled = !!src.ownerEnabled;
    pf.published = src.published ? structuredClone(src.published) : null;
    pf.draft = null;
    pf.version += 1;
  }
}

// Features the restore would switch back on, for explicit owner review.
export function restoreSwitches(store, page, content) {
  const out = [];
  for (const f of allFeatures()) {
    const src = content.features[f.key];
    if (!src || !src.ownerEnabled) continue;
    const pf = store.pageFeatures[`${page.id}:${f.key}`];
    if (pf && !pf.ownerEnabled) out.push({ key: f.key, name: f.name });
  }
  return out;
}

export function restore(store, page, rid, actor, now, { acknowledgeFeatureSwitches = false, expectedVersion } = {}) {
  const b = bucket(store, page);
  if (!b) return { ok: false, status: 404, message: "Nothing archived yet." };
  if (expectedVersion !== undefined && expectedVersion !== b.version) {
    return { ok: false, status: 409, message: "Stale restore. Reload the archive and try again." };
  }
  const target = getRevision(store, page, rid);
  if (!target) return { ok: false, status: 404, message: "Revision not found." };
  if (target.current) return { ok: false, status: 422, message: "That is already the current version." };

  const switches = restoreSwitches(store, page, target.content);
  if (switches.length > 0 && !acknowledgeFeatureSwitches) {
    return { ok: false, status: 409, message: "Restoring would switch features back on. Review and confirm.", requiresAcknowledgement: switches };
  }

  const preRestore = { id: b.headId, time: b.headTime, actor: b.headActor, reason: b.headReason || "", content: b.head };
  applySnapshot(store, page, target.content);
  const cleaned = b.revisions.filter((r) => r.id !== rid);
  cleaned.push(preRestore);
  const max = retention(store);
  b.revisions = cleaned.length > max ? cleaned.slice(cleaned.length - max) : cleaned;
  b.head = target.content;
  b.headHash = hashOf(target.content);
  b.headId = target.id;
  b.headTime = now;
  b.headActor = actor;
  b.headReason = `restore of ${rid}`;
  b.version += 1;
  return { ok: true, restored: rid, archivedPreRestore: preRestore.id, switchesAcknowledged: switches };
}

export function remove(store, page, rid) {
  const b = bucket(store, page);
  if (!b) return { ok: false, status: 404, message: "Nothing archived yet." };
  const before = b.revisions.length;
  b.revisions = b.revisions.filter((r) => r.id !== rid);
  if (b.revisions.length === before) return { ok: false, status: 404, message: "Revision not found." };
  b.version += 1;
  return { ok: true, removed: rid };
}

// Public browsing is gated on the archive feature being effective and its
// publicBrowsing switch being on; a policy/deletion change always wins.
export function publicAllowed(store, page, now) {
  const ev = evaluateFeature(store, page.id, "archive", now);
  if (!ev.effectiveEnabled) return false;
  const pf = store.pageFeatures[`${page.id}:archive`];
  return !!(pf && pf.published && pf.published.publicBrowsing);
}

export function publicList(store, page, now) {
  if (!publicAllowed(store, page, now)) return null;
  const b = bucket(store, page);
  if (!b) return { pageId: page.id, revisions: [] };
  return {
    pageId: page.id,
    revisions: [...b.revisions].reverse().map((r) => ({ id: r.id, time: r.time, label: dateLabel(r.time) })),
  };
}

export function publicGet(store, page, rid, now) {
  if (!publicAllowed(store, page, now)) return null;
  const rev = getRevision(store, page, rid);
  if (!rev) return null;
  return publicSnapshot(store, page, rev, now);
}

// Public history suppresses every payload that current policy disallows and
// never carries secret/timed material (already redacted at capture time).
export function publicSnapshot(store, page, rev, now) {
  const enabled = allFeatures()
    .filter((f) => {
      const src = rev.content.features[f.key];
      if (!src || !src.published) return false;
      return evaluateFeature(store, page.id, f.key, now).effectiveEnabled;
    })
    .map((f) => ({ key: f.key, name: f.name }));
  return {
    id: rev.id,
    time: rev.time,
    label: dateLabel(rev.time),
    historical: !rev.current,
    profile: structuredClone(rev.content.profile),
    placements: structuredClone(rev.content.placements),
    features: enabled,
    note: "A historical appearance. Live inboxes, votes and secret content are never included.",
  };
}

export function dateLabel(iso) {
  return new Date(iso).toISOString().slice(0, 10);
}
