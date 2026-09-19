// Secret word: a visitor-entered phrase reveals an otherwise absent link. The
// phrase is stored only as a salted slow verifier; the destination lives in a
// private record and is returned only after a fresh, rate-limited server check.

import crypto from "node:crypto";
import { evaluateFeature } from "../policy.js";
import { getFeature } from "../registry.js";

const attempts = new Map();

export function resetAttempts() {
  attempts.clear();
}

function limits(store) {
  const policy = store.features.secret_word;
  return { ...getFeature("secret_word").limits, ...(policy && policy.limits) };
}

function pfFor(store, pageId) {
  return store.pageFeatures[`${pageId}:secret_word`] || null;
}

// Documented matching: trim, Unicode NFKC normalization, case-insensitive.
// Internal spaces remain significant.
export function normalizePhrase(value) {
  return String(value == null ? "" : value).normalize("NFKC").trim().toLowerCase();
}

export function hashPhrase(phrase, salt) {
  return crypto.scryptSync(normalizePhrase(phrase), salt, 64).toString("hex");
}

export function hasSecret(store, pageId) {
  const pf = pfFor(store, pageId);
  return !!(pf && pf.secret && pf.secret.hash && pf.secret.salt);
}

export function revokeGrants(store, pageId) {
  store.secretGrants = (store.secretGrants || []).filter((g) => g.pageId !== pageId);
}

export function setSecret(store, page, phrase, now) {
  const lim = limits(store);
  const norm = normalizePhrase(phrase);
  if (norm.length < lim.phraseMin || norm.length > lim.phraseMax) {
    return { ok: false, status: 422, message: `The word must be between ${lim.phraseMin} and ${lim.phraseMax} characters.` };
  }
  const pf = pfFor(store, page.id);
  if (!pf) return { ok: false, status: 404, message: "Feature not found." };
  const salt = crypto.randomBytes(16).toString("hex");
  pf.secret = { salt, hash: hashPhrase(phrase, salt) };
  pf.secretVersion = (pf.secretVersion || 0) + 1;
  revokeGrants(store, page.id);
  return { ok: true, version: pf.secretVersion };
}

export function clearSecret(store, page) {
  const pf = pfFor(store, page.id);
  if (!pf) return { ok: true };
  delete pf.secret;
  pf.secretVersion = (pf.secretVersion || 0) + 1;
  revokeGrants(store, page.id);
  return { ok: true };
}

// Accept only safe destination schemes; reject script:/data: URLs.
export function safeDestination(url) {
  if (typeof url !== "string" || url.trim().length === 0) return null;
  try {
    const u = new URL(url.trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.toString();
  } catch {
    return null;
  }
}

function checkAttempt(store, ip, now) {
  const lim = limits(store);
  const t = Date.parse(now);
  const arr = (attempts.get(ip) || []).filter((ts) => t - ts < lim.attemptWindowMs);
  if (arr.length >= lim.attemptMax) {
    attempts.set(ip, arr);
    const retryAfterMs = lim.attemptWindowMs - (t - arr[0]);
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil(retryAfterMs / 1000)), retryAfterMs };
  }
  return { ok: true };
}

function recordAttempt(ip, now) {
  const arr = attempts.get(ip) || [];
  arr.push(Date.parse(now));
  attempts.set(ip, arr);
}

export function enabled(store, page, now) {
  return evaluateFeature(store, page.id, "secret_word", now).effectiveEnabled;
}

// Public output never carries the phrase or the destination URL — only the
// fact that a hidden link exists, plus its label and placement.
export function publicView(store, page, now) {
  if (!enabled(store, page, now)) return null;
  if (!hasSecret(store, page.id)) return null;
  const pf = pfFor(store, page.id);
  const cfg = pf.published || {};
  if (!safeDestination(cfg.url)) return null;
  return { label: cfg.label || "A hidden link", placement: cfg.placement || "card" };
}

export function attemptUnlock(store, page, phrase, ip, now) {
  if (!enabled(store, page, now)) return { ok: false, status: 404, message: "Not found." };
  const pf = pfFor(store, page.id);
  if (!pf || !pf.secret) return { ok: false, status: 404, message: "Not found." };
  // Rate-limit before the expensive verifier.
  const rate = checkAttempt(store, ip, now);
  if (!rate.ok) {
    return { ok: false, status: 429, message: "Too many attempts. Try again later.", retryAfterSec: rate.retryAfterSec };
  }
  const candidate = Buffer.from(hashPhrase(phrase, pf.secret.salt), "hex");
  const expected = Buffer.from(pf.secret.hash, "hex");
  const match = candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
  if (!match) {
    recordAttempt(ip, now);
    return { ok: false, status: 401, message: "That word doesn't match." };
  }
  const cfg = pf.published || {};
  const url = safeDestination(cfg.url);
  if (!url) return { ok: false, status: 404, message: "Not found." };
  const grant = {
    id: `grant_${crypto.randomBytes(8).toString("hex")}`,
    pageId: page.id,
    version: pf.secretVersion || 0,
    createdAt: now,
    expiresAt: new Date(Date.parse(now) + 5 * 60 * 1000).toISOString(),
  };
  store.secretGrants = store.secretGrants || [];
  store.secretGrants.push(grant);
  return { ok: true, url, label: cfg.label || "A hidden link", grant: grant.id, expiresAt: grant.expiresAt, note: "Matching is trim, NFKC and case-insensitive." };
}

export function resolveGrant(store, page, grantId, now) {
  if (!enabled(store, page, now)) return null;
  const pf = pfFor(store, page.id);
  const grant = (store.secretGrants || []).find((g) => g.id === grantId && g.pageId === page.id);
  if (!grant) return null;
  if (Date.parse(grant.expiresAt) <= Date.parse(now)) return null;
  if (grant.version !== (pf.secretVersion || 0)) return null;
  const url = safeDestination((pf.published || {}).url);
  if (!url) return null;
  return { url, label: (pf.published || {}).label || "A hidden link" };
}
