// Alive: three small widgets under one parent switch — an approximate live
// visitor count (server leases), a clock in the owner's timezone, and a retro
// hit counter of qualified visits. Counts are leases, never identities; hits
// are an atomic, idempotent, deduplicated total with no visitor ledger.

import { evaluateFeature } from "../policy.js";
import { getFeature } from "../registry.js";

const BOT_RE = /bot|crawl|spider|slurp|headless|curl|wget|python-requests|monitoring/i;

function limits(store) {
  const policy = store.features.alive;
  return { ...getFeature("alive").limits, ...(policy && policy.limits) };
}

function audit(store, entry) {
  store.audit.push({
    id: `audit_${Date.now().toString(36)}_${store.audit.length}`,
    actor: entry.actor || "system",
    scope: entry.scope || "page",
    feature: entry.feature || "alive",
    action: entry.action,
    before: entry.before || {},
    after: entry.after || {},
    reason: entry.reason || "",
    time: entry.time,
  });
}

export function parentExposed(store, page, now) {
  return evaluateFeature(store, page.id, "alive", now).effectiveEnabled;
}

export function childExposed(store, page, childKey, now) {
  return evaluateFeature(store, page.id, childKey, now).effectiveEnabled;
}

function config(store, pageId) {
  const pf = store.pageFeatures[`${pageId}:alive`];
  const base = getFeature("alive").fields;
  const out = {};
  for (const [k, d] of Object.entries(base)) out[k] = d.default;
  if (pf && pf.published) Object.assign(out, pf.published);
  return out;
}

function hitsConfig(store, pageId) {
  const pf = store.pageFeatures[`${pageId}:alive_hits`];
  const base = getFeature("alive_hits").fields;
  const out = {};
  for (const [k, d] of Object.entries(base)) out[k] = d.default;
  if (pf && pf.published) Object.assign(out, pf.published);
  return out;
}

export function isBot(userAgent) {
  return BOT_RE.test(String(userAgent || ""));
}

function validToken(token) {
  return typeof token === "string" && token.length >= 8 && token.length <= 128;
}

// ---------- presence ----------

function activeLeases(store, pageId, now) {
  const t = Date.parse(now);
  return store.presenceLeases.filter((l) => l.pageId === pageId && Date.parse(l.expiresAt) > t);
}

export function presenceCount(store, page, now) {
  return activeLeases(store, page.id, now).length;
}

export function heartbeat(store, page, body, ctx, now) {
  if (!childExposed(store, page, "alive_presence", now)) {
    return { ok: false, status: 404, message: "Presence is not available." };
  }
  if (ctx.excluded) return { ok: true, count: presenceCount(store, page, now), excluded: true };
  const token = body && body.token;
  if (!validToken(token)) return { ok: false, status: 422, message: "A page-scoped browser token is required." };
  const lim = limits(store);
  const t = Date.parse(now);
  // Drop expired leases for this page, then upsert one lease per browser token
  // so multiple tabs of the same browser count once.
  store.presenceLeases = store.presenceLeases.filter((l) => Date.parse(l.expiresAt) > t);
  let lease = store.presenceLeases.find((l) => l.pageId === page.id && l.token === token);
  if (!lease) {
    lease = { id: `presence_${t}_${store.presenceLeases.length}`, pageId: page.id, token, firstSeen: now };
    store.presenceLeases.push(lease);
  }
  lease.lastSeen = now;
  lease.expiresAt = new Date(t + lim.leaseSec * 1000).toISOString();
  return {
    ok: true,
    count: activeLeases(store, page.id, now).length,
    heartbeatSec: lim.heartbeatSec,
    leaseSec: lim.leaseSec,
    ts: now,
  };
}

// ---------- clock ----------

export function formatInZone(iso, timeZone, hourFormat = "12h") {
  const opts = { timeZone, hour: "2-digit", minute: "2-digit", hour12: hourFormat === "12h" };
  try {
    return new Intl.DateTimeFormat("en-GB", opts).format(new Date(iso));
  } catch {
    return new Intl.DateTimeFormat("en-GB", { ...opts, timeZone: "UTC" }).format(new Date(iso));
  }
}

export function clockView(store, page, now) {
  const cfg = config(store, page.id);
  return {
    serverNow: now,
    timezone: cfg.timezone || page.timezone || "UTC",
    hourFormat: cfg.hourFormat === "24h" ? "24h" : "12h",
    locationLabel: cfg.locationLabel || "",
    time: formatInZone(now, cfg.timezone || page.timezone || "UTC", cfg.hourFormat),
  };
}

// ---------- hits ----------

// Extra skins are a Lifetime entitlement; a free plan falls back to a static
// permitted skin while the hit widget itself stays eligible.
export function allowedStyle(plan, style) {
  const free = ["odometer", "lcd"];
  const all = ["odometer", "lcd", "split-flap"];
  const allowed = plan === "lifetime" ? all : free;
  return allowed.includes(style) ? style : free[0];
}

export function hitsTotal(store, pageId) {
  const rec = store.hits[pageId];
  return rec ? rec.count : 0;
}

export function hitsView(store, page, now) {
  const owner = store.users[page.ownerId];
  const cfg = hitsConfig(store, page.id);
  return {
    count: hitsTotal(store, page.id),
    style: allowedStyle(owner ? owner.plan : "free", cfg.counterStyle || "odometer"),
    requestedStyle: cfg.counterStyle || "odometer",
    windowMin: limits(store).hitWindowMin,
    dwellSec: limits(store).hitDwellSec,
  };
}

export function recordHit(store, page, body, ctx, now) {
  if (!childExposed(store, page, "alive_hits", now)) {
    return { ok: false, status: 404, message: "The hit counter is not available." };
  }
  const lim = limits(store);
  const total = hitsTotal(store, page.id);
  if (ctx.excluded) return { ok: true, incremented: false, count: total, excluded: true };
  const token = body && body.token;
  if (!validToken(token)) return { ok: false, status: 422, message: "A page-scoped browser token is required." };
  const visibleMs = Number(body && body.visibleMs);
  if (!Number.isFinite(visibleMs) || visibleMs < lim.hitDwellSec * 1000) {
    return {
      ok: false,
      status: 409,
      message: `A visit counts only after ${lim.hitDwellSec} visible seconds.`,
      dwellSec: lim.hitDwellSec,
    };
  }
  const t = Date.parse(now);
  const windowMs = lim.hitWindowMin * 60 * 1000;
  // Expire stale dedup keys, then increment at most once per browser per window.
  for (const key of Object.keys(store.hitDedup)) {
    if (t - Date.parse(store.hitDedup[key]) > windowMs) delete store.hitDedup[key];
  }
  const key = `${page.id}:${token}`;
  const last = store.hitDedup[key];
  if (last && t - Date.parse(last) < windowMs) {
    const nextEligibleAt = new Date(Date.parse(last) + windowMs).toISOString();
    const view = hitsView(store, page, now);
    return { ok: true, incremented: false, count: view.count, nextEligibleAt, style: view.style };
  }
  store.hitDedup[key] = now;
  if (!store.hits[page.id]) store.hits[page.id] = { count: 0, updatedAt: now };
  store.hits[page.id].count += 1;
  store.hits[page.id].updatedAt = now;
  const view = hitsView(store, page, now);
  return { ok: true, incremented: true, count: view.count, nextEligibleAt: new Date(t + windowMs).toISOString(), style: view.style };
}

export function correctHits(store, pageId, count, actorId, reason, now) {
  if (!Number.isInteger(count) || count < 0) return { ok: false, status: 422, message: "count must be a non-negative integer." };
  if (!reason || typeof reason !== "string" || reason.trim().length === 0) {
    return { ok: false, status: 422, message: "A reason is required for a counter correction." };
  }
  const before = hitsTotal(store, pageId);
  store.hits[pageId] = { count, updatedAt: now };
  audit(store, { actor: actorId, scope: "moderation", feature: "alive_hits", action: "admin.correct_hits", before: { count: before }, after: { count }, reason: reason.trim(), time: now });
  return { ok: true, count, message: `Counter corrected from ${before} to ${count}.` };
}

// ---------- public ----------

export function publicView(store, page, now) {
  if (!parentExposed(store, page, now)) return null;
  const presence = childExposed(store, page, "alive_presence", now)
    ? { available: true, count: presenceCount(store, page, now), ...limits(store) }
    : { available: false };
  const clock = childExposed(store, page, "alive_clock", now) ? clockView(store, page, now) : null;
  const hits = childExposed(store, page, "alive_hits", now) ? hitsView(store, page, now) : null;
  return { presence, clock, hits };
}
