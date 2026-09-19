// Neighbours: a small mutual network between Misa pages. Nominations are
// directed edges (fromPageId -> toPageId); a neighbour is shown publicly only
// when the reverse edge exists and both pages are public, allowed and have the
// feature enabled. Visitors never see a unilateral nomination list.

import { newId } from "../store.js";
import { evaluateFeature } from "../policy.js";
import { getFeature } from "../registry.js";

function slotsMax(store) {
  const policy = store.features.neighbours;
  const lim = { ...getFeature("neighbours").limits, ...(policy && policy.limits) };
  return lim.slotsMax;
}

function edgesFrom(store, pageId) {
  return store.neighbourEdges.filter((e) => e.fromPageId === pageId);
}

function edgeBetween(store, fromPageId, toPageId) {
  return store.neighbourEdges.find((e) => e.fromPageId === fromPageId && e.toPageId === toPageId) || null;
}

function audit(store, entry) {
  store.audit.push({
    id: newId("audit"),
    actor: entry.actor || "system",
    scope: entry.scope || "page",
    feature: "neighbours",
    action: entry.action,
    before: entry.before || {},
    after: entry.after || {},
    reason: entry.reason || "",
    time: entry.time,
  });
}

function profileColor(pageId) {
  let h = 0;
  for (const c of String(pageId)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360} 62% 52%)`;
}

function pageByHandle(store, handle) {
  const h = String(handle || "").trim().toLowerCase();
  if (!h) return null;
  const user = Object.values(store.users).find((u) => u.handle.toLowerCase() === h) || null;
  if (!user) return null;
  return Object.values(store.pages).find((p) => p.ownerId === user.id) || null;
}

// A page is publicly linkable only when it still exists, its owner is not
// suspended, it is not unpublished, and its neighbours feature is effective.
function linkable(store, pageId, now) {
  const page = store.pages[pageId];
  if (!page) return false;
  if (page.published === false) return false;
  const owner = store.users[page.ownerId];
  if (!owner || owner.suspended) return false;
  return evaluateFeature(store, pageId, "neighbours", now).effectiveEnabled;
}

function label(store, page) {
  const owner = store.users[page.ownerId];
  return {
    pageId: page.id,
    handle: owner ? owner.handle : null,
    slug: page.slug,
    color: profileColor(page.id),
  };
}

export function slots(store, pageId) {
  return { used: edgesFrom(store, pageId).length, max: slotsMax(store) };
}

export function ownerView(store, page, now) {
  const nominations = edgesFrom(store, page.id)
    .sort((a, b) => (a.order || 0) - (b.order || 0) || a.createdAt.localeCompare(b.createdAt))
    .map((e) => {
      const target = store.pages[e.toPageId];
      const reverse = edgeBetween(store, e.toPageId, page.id);
      const mutual = !!reverse && linkable(store, page.id, now) && linkable(store, e.toPageId, now);
      return {
        toPageId: e.toPageId,
        createdAt: e.createdAt,
        mutual,
        status: mutual ? "mutual" : "waiting",
        target: target ? label(store, target) : { pageId: e.toPageId, handle: null, slug: null, color: null, removed: true },
      };
    });
  const { used, max } = slots(store, page.id);
  return {
    feature: "neighbours",
    pageId: page.id,
    slotsUsed: used,
    slotsMax: max,
    slotsFree: Math.max(0, max - used),
    nominations,
  };
}

export function nominate(store, page, body, now) {
  const handle = body && (body.handle || body.toPageId);
  let target = null;
  if (body && body.toPageId) target = store.pages[body.toPageId] || null;
  else target = pageByHandle(store, handle);
  if (!target) return { ok: false, status: 404, message: "No Misa page matches that handle." };
  if (target.id === page.id) return { ok: false, status: 422, message: "You cannot nominate your own page." };
  if (edgeBetween(store, page.id, target.id)) return { ok: false, status: 409, message: "That page is already in your five slots." };
  const { used, max } = slots(store, page.id);
  if (used >= max) return { ok: false, status: 409, message: `All ${max} neighbour slots are in use. Remove one before adding another.`, slotsMax: max, slotsUsed: used };
  const edge = {
    id: newId("nb"),
    fromPageId: page.id,
    toPageId: target.id,
    createdAt: now,
    order: edgesFrom(store, page.id).length + 1,
  };
  store.neighbourEdges.push(edge);
  audit(store, { actor: page.ownerId, action: "owner.nominate", after: { toPageId: target.id }, time: now });
  return { ok: true, edge, target: label(store, target), message: "Nomination saved. It becomes visible only if they nominate you back." };
}

export function remove(store, page, toPageId, now) {
  const idx = store.neighbourEdges.findIndex((e) => e.fromPageId === page.id && e.toPageId === toPageId);
  if (idx === -1) return { ok: false, status: 404, message: "That nomination does not exist." };
  const [edge] = store.neighbourEdges.splice(idx, 1);
  audit(store, { actor: page.ownerId, action: "owner.remove_nomination", before: { toPageId: edge.toPageId }, time: now });
  return { ok: true, message: "Nomination removed. The mutual link is gone in both directions." };
}

export function reorder(store, page, order, now) {
  if (!Array.isArray(order)) return { ok: false, status: 422, message: "order must be an array of page ids." };
  const mine = edgesFrom(store, page.id);
  const byId = new Map(mine.map((e) => [e.toPageId, e]));
  const ids = order.map(String);
  const unique = ids.length === new Set(ids).size;
  if (!unique || ids.length !== mine.length || ids.some((id) => !byId.has(id))) {
    return { ok: false, status: 422, message: "order must list every nomination exactly once." };
  }
  ids.forEach((id, i) => {
    byId.get(id).order = i + 1;
  });
  return { ok: true, message: "Nomination order updated." };
}

// Public output: only mutual, currently linkable pairs. Rechecked at read time.
export function publicView(store, page, now) {
  if (!evaluateFeature(store, page.id, "neighbours", now).effectiveEnabled) return null;
  const entries = [];
  for (const e of edgesFrom(store, page.id)) {
    const reverse = edgeBetween(store, e.toPageId, page.id);
    if (!reverse) continue;
    if (!linkable(store, page.id, now) || !linkable(store, e.toPageId, now)) continue;
    const target = store.pages[e.toPageId];
    entries.push({ ...label(store, target), since: e.createdAt });
  }
  entries.sort((a, b) => String(a.handle).localeCompare(String(b.handle)));
  return { entries };
}

export function mutualFor(store, page, now) {
  const view = publicView(store, page, now);
  return view ? view.entries : [];
}
