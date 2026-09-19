import { allFeatures, getFeature } from "../registry.js";
import { evaluateFeature } from "../policy.js";
import { nightActive, nextBoundaryUtc, localMinutes, toHHMM } from "../schedule.js";

const BUILTIN_BLOCKS = [{ id: "link", label: "Link" }];

export function ensurePlacements(store, pageId) {
  if (!store.placements[pageId]) store.placements[pageId] = [];
  return store.placements[pageId];
}

// Available placeable blocks for a page at a moment in time: the builtin link
// card plus every enabled feature widget (other_side itself excluded).
export function availableBlocks(store, page, now) {
  const ids = [];
  for (const b of BUILTIN_BLOCKS) ids.push(b.id);
  for (const f of allFeatures()) {
    if (f.widget === false) continue;
    if (evaluateFeature(store, page.id, f.key, now).effectiveEnabled) ids.push(f.key);
  }
  return ids;
}

function blockLabel(store, page, id, now) {
  if (id === "link") return "Link";
  const def = getFeature(id);
  if (def) return def.name;
  return String(id);
}

// Which block ids are night-only (night_shift active) and currently outside the
// night window. Those blocks must be absent from the public page entirely.
// Which block ids are night-only (night_shift active) and currently outside the
// night window. When the feature is disabled or inaccessible every night-only
// block is hidden too (spec: "hide all Night only blocks whenever this feature
// is disabled or inaccessible"); only unmarking a block (Always visible) shows
// it outside the schedule.
export function nightHiddenBlocks(store, page, now) {
  const nf = store.pageFeatures[`${page.id}:night_shift`];
  if (!nf || !nf.published) return new Set();
  const cfg = nf.published;
  if (!evaluateFeature(store, page.id, "night_shift", now).effectiveEnabled) return new Set(cfg.blocks || []);
  if (nightActive(cfg.timezone, cfg.start, cfg.end, now)) return new Set();
  return new Set(cfg.blocks || []);
}

// Which block ids are currently marked "Night only" in the night_shift published
// config, regardless of whether the window is active or the feature enabled.
export function nightOnlyBlocks(store, page) {
  const nf = store.pageFeatures[`${page.id}:night_shift`];
  return new Set(((nf && nf.published) || {}).blocks || []);
}

// Public + owner night signal. Returns null when night_shift is not effective or
// has no published config; never leaks the window while disabled.
export function nightState(store, page, now) {
  const nf = store.pageFeatures[`${page.id}:night_shift`];
  if (!nf || !nf.published) return null;
  if (!evaluateFeature(store, page.id, "night_shift", now).effectiveEnabled) return null;
  const cfg = nf.published;
  const active = nightActive(cfg.timezone, cfg.start, cfg.end, now);
  const next = nextBoundaryUtc(cfg.timezone, cfg.start, cfg.end, now);
  return {
    active,
    timezone: cfg.timezone,
    localTime: toHHMM(localMinutes(cfg.timezone, now)),
    message: active ? (cfg.message || "") : "",
    next: next ? { label: next.label, at: next.at } : null,
  };
}

// Full block list with resolved side + order. Front keeps a canonical order;
// the back uses the owner's placement order.
export function pageBlocks(store, page, now) {
  const placements = ensurePlacements(store, page.id);
  const placeById = new Map(placements.map((p) => [p.id, p]));
  const hidden = nightHiddenBlocks(store, page, now);

  const ids = availableBlocks(store, page, now);
  const front = [];
  const back = [];
  let canonical = 0;
  for (const id of ids) {
    const placement = placeById.get(id);
    const side = placement && placement.side ? placement.side : "front";
    const block = {
      id,
      label: blockLabel(store, page, id, now),
      kind: id === "link" ? "builtin" : "widget",
      side,
      nightHidden: hidden.has(id),
    };
    if (side === "back") {
      back.push(block);
    } else {
      front.push({ ...block, order: canonical++ });
    }
  }
  // Back order follows the placement array; unlisted blocks appended by type.
  const placedBackIds = placements.map((p) => p.id);
  back.sort((a, b) => {
    const ia = placedBackIds.indexOf(a.id);
    const ib = placedBackIds.indexOf(b.id);
    if (ia === -1 && ib === -1) return a.id.localeCompare(b.id);
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });
  back.forEach((b, i) => (b.order = i));
  return { front, back, hidden: [...hidden] };
}

export function setPlacements(store, page, entries, now) {
  const ids = availableBlocks(store, page, now);
  const allowed = new Set(ids);
  if (!Array.isArray(entries)) return { ok: false, status: 422, message: "blocks must be an array of { id, side } entries." };
  const seen = new Set();
  for (const e of entries) {
    if (!e || typeof e !== "object" || typeof e.id !== "string" || !allowed.has(e.id)) {
      return { ok: false, status: 422, message: `Unknown or unavailable block: ${e && e.id}` };
    }
    if (typeof e.side !== "string" || !["front", "back"].includes(e.side)) {
      return { ok: false, status: 422, message: "side must be 'front' or 'back'." };
    }
    if (seen.has(e.id)) return { ok: false, status: 422, message: `Duplicate block: ${e.id}` };
    seen.add(e.id);
  }
  ensurePlacements(store, page.id);
  store.placements[page.id] = entries.map((e) => ({ id: e.id, side: e.side }));
  return { ok: true, message: "Block layout saved." };
}

export function flipCard(store, page, now) {
  const ev = evaluateFeature(store, page.id, "other_side", now);
  const osConfig = store.pageFeatures[`${page.id}:other_side`].published || null;
  const visible = (arr) => arr.filter((b) => !b.nightHidden).map((b) => ({ id: b.id, label: b.label, kind: b.kind }));
  const { front, back } = pageBlocks(store, page, now);
  if (!ev.effectiveEnabled || !osConfig) {
    return {
      flippable: false,
      front: visible(front),
    };
  }
  return {
    flippable: true,
    cornerLabel: osConfig.cornerLabel || "Flip",
    animation: osConfig.animation || "fold",
    note: osConfig.backNote || "",
    front: visible(front),
    back: visible(back),
  };
}