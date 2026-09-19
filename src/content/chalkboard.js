// A chalkboard: visitors submit normalized pen strokes; the owner keeps,
// rejects or pins them. Only validated stroke data is stored — never uploads,
// images or raw SVG — and only kept drawings ever appear in public output.

import { evaluateFeature } from "../policy.js";
import { getFeature } from "../registry.js";

const SCHEMA = 1;
const ALLOWED_STROKE_KEYS = new Set(["points", "color", "width"]);
const COLOR_RE = /^#[0-9a-f]{3,6}$/i;
const NOISE_KEYS = ["svg", "image", "imageUrl", "dataUrl", "html", "file", "upload"];

function limits(store) {
  const policy = store.features.chalkboard;
  return { ...getFeature("chalkboard").limits, ...(policy && policy.limits) };
}

function config(store, pageId) {
  const pf = store.pageFeatures[`${pageId}:chalkboard`];
  const base = getFeature("chalkboard").fields;
  const out = {};
  for (const [k, d] of Object.entries(base)) out[k] = d.default;
  if (pf && pf.published) Object.assign(out, pf.published);
  return out;
}

export function exposed(store, page, now) {
  return evaluateFeature(store, page.id, "chalkboard", now).effectiveEnabled;
}

function recordsFor(store, pageId) {
  return store.drawings.filter((d) => d.pageId === pageId);
}

export function counts(store, pageId) {
  const list = recordsFor(store, pageId);
  return {
    pending: list.filter((d) => d.status === "pending").length,
    kept: list.filter((d) => d.status === "kept").length,
    pinned: list.filter((d) => d.status === "kept" && d.pinned).length,
  };
}

// Reduce near-duplicate points without visibly changing the drawing.
export function simplify(points, tolerance = 0.004) {
  const out = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || Math.abs(p[0] - last[0]) >= tolerance || Math.abs(p[1] - last[1]) >= tolerance) out.push(p);
  }
  if (out.length === 1 && points.length > 1) out.push(points[points.length - 1]);
  return out;
}

export function validateDrawing(body, lim) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, errors: { _: "A drawing object is required." } };
  for (const key of NOISE_KEYS) {
    if (body[key] !== undefined) return { ok: false, errors: { _: "Images, SVG and uploads are not accepted." } };
  }
  if (body.schemaVersion !== SCHEMA) return { ok: false, errors: { schemaVersion: "Unsupported stroke schema version." } };
  const raw = body.strokes;
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, errors: { strokes: "Draw at least one stroke." } };
  if (raw.length > lim.strokesMax) return { ok: false, errors: { strokes: `At most ${lim.strokesMax} strokes.` } };

  let pointCount = 0;
  const strokes = [];
  for (const stroke of raw) {
    if (!stroke || typeof stroke !== "object" || Array.isArray(stroke)) return { ok: false, errors: { strokes: "Each stroke must be an object." } };
    for (const key of Object.keys(stroke)) {
      if (!ALLOWED_STROKE_KEYS.has(key)) return { ok: false, errors: { strokes: `Unknown stroke attribute: ${key}.` } };
    }
    if (!Array.isArray(stroke.points) || stroke.points.length === 0) return { ok: false, errors: { strokes: "Each stroke needs points." } };
    const points = [];
    for (const p of stroke.points) {
      if (!Array.isArray(p) || p.length !== 2) return { ok: false, errors: { strokes: "Points must be [x,y] pairs." } };
      const [x, y] = p;
      if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, errors: { strokes: "Coordinates must be finite numbers." } };
      if (x < 0 || x > 1 || y < 0 || y > 1) return { ok: false, errors: { strokes: "Coordinates must be normalized to [0,1]." } };
      points.push([x, y]);
    }
    pointCount += points.length;
    if (pointCount > lim.pointsMax) return { ok: false, errors: { strokes: `At most ${lim.pointsMax} points.` } };
    const out = { points: simplify(points) };
    if (stroke.color !== undefined) {
      if (typeof stroke.color !== "string" || !COLOR_RE.test(stroke.color)) return { ok: false, errors: { strokes: "Unsupported pen colour." } };
      out.color = stroke.color;
    }
    if (stroke.width !== undefined) {
      const w = Number(stroke.width);
      if (!Number.isFinite(w) || w < 1 || w > 10) return { ok: false, errors: { strokes: "Unsupported pen width." } };
      out.width = w;
    }
    strokes.push(out);
  }
  if (strokes.every((s) => s.points.length === 0)) return { ok: false, errors: { strokes: "The drawing is empty." } };
  const bytes = Buffer.byteLength(JSON.stringify(strokes), "utf8");
  if (bytes > lim.payloadKB * 1024) return { ok: false, errors: { strokes: `The drawing exceeds ${lim.payloadKB} KB.` } };
  return { ok: true, value: strokes };
}

export function submitDrawing(store, page, body, now) {
  if (!exposed(store, page, now)) return { ok: false, status: 404, message: "The chalkboard is not available." };
  const cfg = config(store, page.id);
  if (cfg.intakePaused) return { ok: false, status: 403, message: "The board is not accepting drawings right now." };
  const lim = limits(store);
  const list = recordsFor(store, page.id);
  if (list.filter((d) => d.status === "pending").length >= lim.pendingMax) {
    return { ok: false, status: 429, message: "The board is full right now. Try again later." };
  }
  const valid = validateDrawing(body, lim);
  if (!valid.ok) return { ok: false, status: 422, message: "That drawing could not be accepted.", errors: valid.errors };
  const description = typeof body.description === "string" ? body.description.trim().slice(0, 280) : "";
  const id = `draw_${Date.now().toString(36)}_${store.drawings.length}`;
  store.drawings.push({ id, publicId: null, pageId: page.id, strokes: valid.value, description, status: "pending", pinned: false, order: list.length, createdAt: now, moderatedAt: null });
  return { ok: true, id, status: "pending", submittedAt: now, note: "Your drawing is waiting for the owner to look at it." };
}

function galleryFor(store, pageId) {
  return recordsFor(store, pageId)
    .filter((d) => d.status === "kept")
    .sort((a, b) => (b.pinned - a.pinned) || (a.order - b.order) || a.createdAt.localeCompare(b.createdAt));
}

export function publicView(store, page, now) {
  if (!exposed(store, page, now)) return null;
  const cfg = config(store, page.id);
  const gallery = galleryFor(store, page.id).slice(0, cfg.gallerySize || 20);
  return {
    title: cfg.title || "Chalkboard",
    theme: cfg.theme || "dark",
    acceptNew: !cfg.intakePaused,
    gallery: gallery.map((d) => ({ id: d.publicId || d.id, strokes: d.strokes, description: d.description, pinned: d.pinned })),
  };
}

export function ownerView(store, page, now) {
  const cfg = config(store, page.id);
  const list = recordsFor(store, page.id);
  const pending = list.filter((d) => d.status === "pending").sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return {
    counts: counts(store, page.id),
    config: cfg,
    gallerySize: cfg.gallerySize || 20,
    pending: pending.map((d) => ({ id: d.id, strokes: d.strokes, description: d.description, createdAt: d.createdAt })),
    kept: galleryFor(store, page.id).map((d) => ({ id: d.id, strokes: d.strokes, description: d.description, pinned: d.pinned })),
  };
}

function findRecord(store, pageId, recordId) {
  return store.drawings.find((d) => d.pageId === pageId && (d.id === recordId || d.publicId === recordId));
}

export function moderate(store, page, recordId, action, now) {
  const rec = findRecord(store, page.id, recordId);
  if (!rec) return { ok: false, status: 404, message: "Drawing not found." };
  const lim = limits(store);
  if (action === "keep") {
    if (rec.status === "kept") return { ok: true, id: rec.id, status: "kept", pinned: rec.pinned, message: "Already kept." };
    rec.status = "kept";
    rec.publicId = rec.publicId || `d_${Math.random().toString(36).slice(2, 10)}`;
    rec.moderatedAt = now;
    return { ok: true, id: rec.id, status: "kept", pinned: rec.pinned, message: "Kept. It is now public." };
  }
  if (action === "reject") {
    rec.status = "rejected";
    rec.pinned = false;
    rec.moderatedAt = now;
    return { ok: true, id: rec.id, status: "rejected", message: "Rejected and hidden." };
  }
  if (action === "pin" || action === "unpin") {
    if (rec.status !== "kept") return { ok: false, status: 409, message: "Only a kept drawing can be pinned." };
    const want = action === "pin";
    if (want === rec.pinned) return { ok: true, id: rec.id, status: "kept", pinned: rec.pinned, message: want ? "Already pinned." : "Already unpinned." };
    if (want) {
      const pinnedCount = recordsFor(store, page.id).filter((d) => d.status === "kept" && d.pinned).length;
      if (pinnedCount >= lim.pinnedMax) return { ok: false, status: 409, message: `You can pin at most ${lim.pinnedMax} drawings.` };
    }
    rec.pinned = want;
    rec.moderatedAt = now;
    return { ok: true, id: rec.id, status: "kept", pinned: rec.pinned, message: want ? "Pinned." : "Unpinned." };
  }
  return { ok: false, status: 422, message: "Unknown action." };
}

export function deleteRecord(store, page, recordId) {
  const rec = findRecord(store, page.id, recordId);
  if (!rec) return { ok: false, status: 404, message: "Drawing not found." };
  store.drawings = store.drawings.filter((d) => d !== rec);
  return { ok: true, id: rec.id, message: "Deleted. It is gone from current and historical public reads." };
}

export function adminAction(store, recordId, action, actorId, reason, now) {
  const rec = store.drawings.find((d) => d.id === recordId || d.publicId === recordId);
  if (!rec) return { ok: false, status: 404, message: "Drawing not found." };
  if (!reason || !String(reason).trim()) return { ok: false, status: 422, message: "A reason is required." };
  if (action === "remove" || action === "delete") {
    store.drawings = store.drawings.filter((d) => d !== rec);
    return { ok: true, id: rec.id, message: `Removed by ${actorId}.` };
  }
  if (action === "keep") {
    rec.status = "kept";
    rec.publicId = rec.publicId || `d_${Math.random().toString(36).slice(2, 10)}`;
    rec.moderatedAt = now;
    return { ok: true, id: rec.id, message: "Kept." };
  }
  if (action === "reject") {
    rec.status = "rejected";
    rec.pinned = false;
    rec.moderatedAt = now;
    return { ok: true, id: rec.id, message: "Rejected." };
  }
  return { ok: false, status: 422, message: "Unknown action." };
}

export function adminContent(store) {
  const byPage = {};
  for (const d of store.drawings) {
    byPage[d.pageId] = byPage[d.pageId] || { pending: 0, kept: 0, pinned: 0 };
    if (d.status === "pending") byPage[d.pageId].pending += 1;
    if (d.status === "kept") byPage[d.pageId].kept += 1;
    if (d.status === "kept" && d.pinned) byPage[d.pageId].pinned += 1;
  }
  return { totals: { drawings: store.drawings.length }, pages: byPage };
}
