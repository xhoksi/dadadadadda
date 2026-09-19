import { evaluateFeature } from "../policy.js";
import { localDate } from "../schedule.js";

// The daily draw: a deck of up to 12 lines where each browser keeps one line
// for the owner-local day. Selection happens only in the visitor's browser from
// a locally persisted random seed; the server never sees or assigns an index.
//
// Deck revisions follow the owner-local calendar: a change published after the
// deck already went live that day takes effect at the next owner-local midnight
// (a "pending" revision that can be cancelled). Day-scoped promotions happen
// lazily on read.

const MAX_CARDS = 12;
const MAX_CHAR = 160;

export function isExposed(store, page, now) {
  return evaluateFeature(store, page.id, "daily_draw", now).effectiveEnabled;
}

function pf(store, page) {
  return store.pageFeatures[`${page.id}:daily_draw`];
}

function nextLocalDate(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

// Promote a due pending revision into the active deck (idempotent, called on
// read so a day rollover never needs a timer).
function ensureApplied(store, page, now) {
  const entry = store.drawSchedules[page.id];
  const today = localDate(page.timezone, now);
  if (entry && entry.appliesOn <= today) {
    const rec = pf(store, page);
    rec.published = { cards: entry.cards, style: entry.style };
    rec.version = entry.version;
    rec.updatedAt = new Date(now instanceof Date ? now : new Date(now)).toISOString();
    delete store.drawSchedules[page.id];
    return true;
  }
  return false;
}

export function activeDeck(store, page, now) {
  const rec = pf(store, page);
  if (!rec) return null;
  ensureApplied(store, page, now);
  return rec.published ? { cards: rec.published.cards, style: rec.published.style || "handwritten" } : null;
}

export function scheduleState(store, page, now) {
  ensureApplied(store, page, now);
  const active = activeDeck(store, page, now);
  const entry = store.drawSchedules[page.id] || null;
  return {
    localDate: localDate(page.timezone, now),
    active: active
      ? { cards: active.cards, style: active.style, count: active.cards.length }
      : null,
    pending: entry ? { cards: entry.cards, style: entry.style, appliesOn: entry.appliesOn, count: entry.cards.length } : null,
  };
}

// Publish the validated draft deck. First-ever publish applies at once; any
// later change applies at the next owner-local midnight as a cancellable
// pending revision.
export function publishDeck(store, page, draft, now) {
  const rec = pf(store, page);
  ensureApplied(store, page, now);
  const today = localDate(page.timezone, now);
  const cards = draft.cards;
  const style = draft.style || "handwritten";
  if (!cards || cards.length === 0) return { ok: false, status: 422, message: "A deck needs at least one card." };
  if (cards.length > MAX_CARDS) return { ok: false, status: 422, message: `A deck can have at most ${MAX_CARDS} cards.` };
  for (const c of cards) if (typeof c !== "string" || !c.trim() || c.trim().length > MAX_CHAR) {
    return { ok: false, status: 422, message: `Each card must be 1-${MAX_CHAR} characters.` };
  }
  const clean = cards.map((c) => c.trim());

  if (!rec.published) {
    rec.published = { cards: clean, style };
    rec.version += 1;
    rec.updatedAt = new Date(now instanceof Date ? now : new Date(now)).toISOString();
    store.drawSchedules[page.id] = null;
    delete store.drawSchedules[page.id];
    return { ok: true, applied: "now", message: "Deck is live." };
  }

  store.drawSchedules[page.id] = { cards: clean, style, version: rec.version + 1, appliesOn: nextLocalDate(today) };
  return { ok: true, applied: "next_midnight", message: `Deck applies at the next midnight (${nextLocalDate(today)}).` };
}

export function cancelPending(store, page) {
  if (!store.drawSchedules[page.id]) return { ok: false, status: 404, message: "No scheduled revision to cancel." };
  delete store.drawSchedules[page.id];
  return { ok: true, message: "Scheduled revision cancelled; the active deck stays." };
}

// Public payload for the visitor's browser: the deck is public by design, the
// seed and chosen index never leave the browser.
export function publicView(store, page, now) {
  if (!isExposed(store, page, now)) return null;
  const active = activeDeck(store, page, now);
  if (!active || !active.cards || active.cards.length === 0) return null;
  return {
    present: true,
    pageId: page.id,
    day: localDate(page.timezone, now),
    cards: active.cards,
    style: active.style,
  };
}