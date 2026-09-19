import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { allFeatures, getFeature } from "./registry.js";
import { getStore, saveStore, newId, resetStore } from "./store.js";
import {
  evaluateFeature,
  validateConfig,
  pageProfile,
  REASONS,
} from "./policy.js";
import {
  authMiddleware,
  requireAuth,
  requireRole,
  isOwnerOrAdmin,
  isAdmin,
  publicUser,
  loginByHandle,
  destroySession,
} from "./auth.js";
import * as ask from "./content/ask_anything.js";
import * as draw from "./content/daily_draw.js";
import * as capsule from "./content/time_capsule.js";
import * as archive from "./content/archive.js";
import * as moon from "./content/moon.js";
import * as guestbook from "./content/guestbook.js";
import * as neighbours from "./content/neighbours.js";
import * as alive from "./content/alive.js";
import * as secret from "./content/secret_word.js";
import * as chalkboard from "./content/chalkboard.js";
import * as tally from "./content/tally.js";
import { flipCard, pageBlocks, setPlacements, nightState, nightOnlyBlocks } from "./content/blocks.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Controllable server clock (see spec: "inject a controllable server clock").
// Routes and policy use this single time source; tests swap it via setServerClock.
let serverClock = () => new Date();
export function setServerClock(fn) {
  serverClock = typeof fn === "function" ? fn : () => new Date();
}

const LIMITS = {
  displayName: { min: 1, max: 40 },
  bio: { min: 0, max: 160 },
  linkLabel: { min: 1, max: 30 },
};

function isValidHttpsUrl(raw) {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && url.hostname.length > 0;
  } catch {
    return false;
  }
}

function validateProfile(body) {
  const errors = {};
  const isString = (v) => typeof v === "string";
  const link = body && typeof body === "object" && body.link;

  const displayName = isString(body && body.displayName) ? body.displayName.trim() : undefined;
  const bio = isString(body && body.bio) ? body.bio.trim() : undefined;
  const linkLabel = link && isString(link.label) ? link.label.trim() : undefined;
  const linkUrl = link && isString(link.url) ? link.url.trim() : undefined;

  if (!isString(body && body.displayName)) {
    errors.displayName = "Display name must be a string.";
  } else if (displayName.length < LIMITS.displayName.min || displayName.length > LIMITS.displayName.max) {
    errors.displayName = `Display name must be ${LIMITS.displayName.min}-${LIMITS.displayName.max} characters.`;
  }

  if (!isString(body && body.bio)) {
    errors.bio = "Bio must be a string.";
  } else if (bio.length > LIMITS.bio.max) {
    errors.bio = `Bio must be ${LIMITS.bio.max} characters or fewer.`;
  }

  if (!link || typeof link !== "object") {
    errors.linkLabel = "Link label must be a string.";
    errors.linkUrl = "Link URL must be a valid absolute https:// URL with a hostname.";
  } else {
    if (!isString(link.label)) {
      errors.linkLabel = "Link label must be a string.";
    } else if (linkLabel.length < LIMITS.linkLabel.min || linkLabel.length > LIMITS.linkLabel.max) {
      errors.linkLabel = `Link label must be ${LIMITS.linkLabel.min}-${LIMITS.linkLabel.max} characters.`;
    }

    if (!isString(link.url)) {
      errors.linkUrl = "Link URL must be a string.";
    } else if (!isValidHttpsUrl(linkUrl)) {
      errors.linkUrl = "Link URL must be a valid absolute https:// URL with a hostname.";
    }
  }

  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, value: { displayName, bio, link: { label: linkLabel, url: linkUrl } } };
}

function reportAudit(store, { actor, scope, feature, action, before, after, reason }) {
  store.audit.push({
    id: newId("audit"),
    actor,
    scope,
    feature: feature || null,
    action,
    before,
    after,
    reason: reason || "",
    time: serverClock().toISOString(),
  });
}

function getPage(store, pageId) {
  return store.pages[pageId] || null;
}

function pageBySlug(store, slug) {
  return Object.values(store.pages).find((p) => p.slug === slug) || null;
}

function ensurePageFeature(store, pageId, featureKey) {
  const key = `${pageId}:${featureKey}`;
  if (!store.pageFeatures[key]) {
    store.pageFeatures[key] = {
      pageId,
      featureKey,
      ownerEnabled: false,
      draft: null,
      published: null,
      version: 1,
      updatedAt: new Date().toISOString(),
    };
  }
  return store.pageFeatures[key];
}

function featureCard(store, pageId, featureKey, now) {
  const def = getFeature(featureKey);
  const ev = evaluateFeature(store, pageId, featureKey, now);
  const pf = store.pageFeatures[`${pageId}:${featureKey}`];
  return {
    key: def.key,
    name: def.name,
    category: def.category,
    tier: def.tier,
    parentKey: def.parentKey || null,
    requiresConfig: def.requiresConfig,
    requestedEnabled: ev.requestedEnabled,
    effectiveEnabled: ev.effectiveEnabled,
    reasonCode: ev.reasonCode,
    canEdit: !!ev.canEdit,
    configVersion: pf ? pf.version : null,
    publishedAt: pf && pf.published ? pf.updatedAt : null,
  };
}

function ownerPreview(store, pageId, now) {
  const page = getPage(store, pageId);
  if (!page) return null;
  return {
    profile: pageProfile(store, pageId),
    features: allFeatures().map((f) => ({
      ...featureCard(store, pageId, f.key, now),
      draft: store.pageFeatures[`${pageId}:${f.key}`].draft,
      published: store.pageFeatures[`${pageId}:${f.key}`].published,
    })),
    serverNow: now,
    policyVersion: store.policyVersion,
  };
}

function publicFeatures(store, page, now) {
  const result = [];
  for (const f of allFeatures()) {
    const ev = evaluateFeature(store, page.id, f.key, now);
    if (!ev.effectiveEnabled) continue;
    result.push({ key: f.key, name: f.name, present: true });
  }
  return {
    profile: pageProfile(store, page.id),
    features: result,
    card: flipCard(store, page, now),
    night: nightState(store, page, now),
    draw: draw.publicView(store, page, now),
    capsule: capsule.publicView(store, page, now),
    moon: moon.publicView(store, page, now),
    guestbook: guestbook.publicView(store, page, now),
    neighbours: neighbours.publicView(store, page, now),
    alive: alive.publicView(store, page, now),
    secret_word: secret.publicView(store, page, now),
    chalkboard: chalkboard.publicView(store, page, now),
    tally: tally.publicView(store, page, now),
    serverNow: now,
    policyVersion: store.policyVersion,
  };
}

export function createApp() {
  const app = express();
  app.use(express.json({ limit: "256kb" }));
  app.use(authMiddleware);

  const now = () => serverClock().toISOString();

  // ---------- auth ----------
  app.post("/api/auth/login", (req, res) => {
    const handle = req.body && typeof req.body.handle === "string" ? req.body.handle.trim().toLowerCase() : "";
    const result = loginByHandle(handle);
    if (!result) {
      res.status(401).json({ message: "Unknown demo handle." });
      return;
    }
    res.json({ token: result.token, user: publicUser(result.user) });
  });

  app.post("/api/auth/logout", requireAuth, (req, res) => {
    const header = req.headers.authorization || "";
    if (header.startsWith("Bearer ")) destroySession(header.slice(7));
    res.json({ ok: true });
  });

  app.get("/api/me", requireAuth, (req, res) => {
    const store = getStore();
    res.json({ user: publicUser(req.user), pages: userPages(store, req.user) });
  });

  // ---------- shared ----------
  function userPages(store, user) {
    return Object.values(store.pages)
      .filter((p) => isAdmin(user) || p.ownerId === user.id)
      .map((p) => ({
        id: p.id,
        slug: p.slug,
        ownerId: p.ownerId,
        timezone: p.timezone,
        profile: pageProfile(store, p.id),
      }));
  }

  // ---------- owner ----------
  app.get("/api/me/pages", requireAuth, (req, res) => {
    const store = getStore();
    res.json({ pages: userPages(store, req.user) });
  });

  app.get("/api/me/pages/:id/features", requireAuth, (req, res) => {
    const store = getStore();
    const page = getPage(store, req.params.id);
    if (!page) return res.status(404).json({ message: "Page not found." });
    if (!isOwnerOrAdmin(req.user, page)) return res.status(403).json({ message: "Not your page." });
    res.json({
      pageId: page.id,
      features: allFeatures().map((f) => featureCard(store, page.id, f.key, now())),
    });
  });

  app.get("/api/me/pages/:id/features/:key", requireAuth, (req, res) => {
    const store = getStore();
    const page = getPage(store, req.params.id);
    if (!page) return res.status(404).json({ message: "Page not found." });
    if (!isOwnerOrAdmin(req.user, page)) return res.status(403).json({ message: "Not your page." });
    const def = getFeature(req.params.key);
    if (!def) return res.status(404).json({ message: "Unknown feature." });
    const pf = ensurePageFeature(store, page.id, def.key);
    res.json({
      ...featureCard(store, page.id, def.key, now()),
      config: { draft: pf.draft, published: pf.published },
      fields: def.fields,
      version: pf.version,
      state: def.key === "night_shift" ? nightState(store, page, now()) : def.key === "daily_draw" ? draw.scheduleState(store, page, now()) : def.key === "time_capsule" ? capsule.capsuleState(store, page, now()) : def.key === "guestbook" ? { counts: guestbook.inbox(store, page.id).counts } : def.key === "neighbours" ? neighbours.slots(store, page.id) : def.key === "chalkboard" ? { counts: chalkboard.counts(store, page.id) } : def.key === "tally" ? tally.ownerView(store, page, now()) : null,
    });
  });

  app.patch("/api/me/pages/:id/features/:key", requireAuth, (req, res) => {
    const store = getStore();
    const page = getPage(store, req.params.id);
    if (!page) return res.status(404).json({ message: "Page not found." });
    if (!isOwnerOrAdmin(req.user, page)) return res.status(403).json({ message: "Not your page." });
    const def = getFeature(req.params.key);
    if (!def) return res.status(404).json({ message: "Unknown feature." });

    const pf = ensurePageFeature(store, page.id, def.key);
    const expectedVersion = req.body && req.body.expectedVersion;
    if (expectedVersion !== undefined && expectedVersion !== pf.version) {
      res.status(409).json({ message: "Stale edit. Reload the latest state and try again.", after: featureCard(store, page.id, def.key, now()) });
      return;
    }

    const before = structuredClone(pf);
    if (req.body && req.body.ownerEnabled !== undefined) {
      if (typeof req.body.ownerEnabled !== "boolean") {
        return res.status(422).json({ message: "ownerEnabled must be a boolean.", errors: { ownerEnabled: "must be a boolean" } });
      }
      pf.ownerEnabled = req.body.ownerEnabled;
    }
    if (req.body && req.body.config !== undefined) {
      let incoming = req.body.config;
      let phrase;
      if (def.key === "secret_word" && incoming && typeof incoming === "object" && !Array.isArray(incoming) && Object.prototype.hasOwnProperty.call(incoming, "phrase")) {
        phrase = incoming.phrase;
        incoming = { ...incoming };
        delete incoming.phrase;
      }
      const result = validateConfig(def.key, incoming, pf.draft);
      if (!result.ok) {
        return res.status(422).json({ message: "Invalid feature configuration. Nothing was saved.", errors: result.errors });
      }
      if (def.key === "secret_word" && result.value.url && !secret.safeDestination(result.value.url)) {
        return res.status(422).json({ message: "Invalid feature configuration. Nothing was saved.", errors: { url: "Only http and https destinations are allowed." } });
      }
      const previousUrl = (pf.published && pf.published.url) || (pf.draft && pf.draft.url) || "";
      pf.draft = result.value;
      if (def.key === "secret_word") {
        if (phrase !== undefined) {
          if (String(phrase).trim() === "") {
            secret.clearSecret(store, page);
          } else {
            const set = secret.setSecret(store, page, phrase, now());
            if (!set.ok) return res.status(set.status).json(set);
          }
        }
        if ((pf.draft.url || "") !== previousUrl) {
          pf.secretVersion = (pf.secretVersion || 0) + 1;
          secret.revokeGrants(store, page.id);
        }
      }
    }
    if (req.body && (req.body.ownerEnabled !== undefined || req.body.config !== undefined)) {
      pf.version += 1;
      pf.updatedAt = now();
      reportAudit(store, {
        actor: req.user.id,
        scope: "page",
        feature: def.key,
        action: "owner.update",
        before: { ownerEnabled: before.ownerEnabled, version: before.version },
        after: { ownerEnabled: pf.ownerEnabled, version: pf.version },
        reason: (req.body && req.body.reason) || "",
      });
      if (req.body.ownerEnabled !== undefined) archive.capture(store, page, req.user.id, now(), `feature switch ${def.key}`);
      saveStore();
    }
    res.json({ ...featureCard(store, page.id, def.key, now()), version: pf.version, message: "Saved. The switch is live policy; content stays a draft until published." });
  });

  app.post("/api/me/pages/:id/features/:key/publish", requireAuth, (req, res) => {
    const store = getStore();
    const page = getPage(store, req.params.id);
    if (!page) return res.status(404).json({ message: "Page not found." });
    if (!isOwnerOrAdmin(req.user, page)) return res.status(403).json({ message: "Not your page." });
    const def = getFeature(req.params.key);
    if (!def) return res.status(404).json({ message: "Unknown feature." });

    const pf = ensurePageFeature(store, page.id, def.key);
    const expectedVersion = req.body && req.body.expectedVersion;
    if (expectedVersion !== undefined && expectedVersion !== pf.version) {
      return res.status(409).json({ message: "Stale edit. Reload the latest state and try again." });
    }
    if (pf.draft == null) {
      return res.status(400).json({ message: "Nothing to publish. Save a draft first." });
    }
    const result = validateConfig(def.key, pf.draft, pf.draft);
    if (!result.ok) {
      return res.status(422).json({ message: "Draft does not validate. Nothing was published.", errors: result.errors });
    }
    const before = structuredClone(pf);
    if (def.key === "time_capsule") {
      const resolved = capsule.resolveReleaseUtc(result.value, page);
      if (!resolved) {
        return res.status(422).json({ message: "Could not resolve a release time from these settings.", errors: { releaseTime: "Could not resolve this date, time and timezone." } });
      }
      if (pf.published && pf.openedAt && resolved !== capsule.resolveReleaseUtc(pf.published, page)) {
        return res.status(409).json({ message: "A released capsule can't be re-sealed. Keep the same release time or leave this draft unpublished." });
      }
    }
    if (def.key === "tally") {
      const published = tally.publishPoll(store, page, result.value, now());
      if (!published.ok) return res.status(published.status).json(published);
      pf.published = {
        pollId: published.poll.id,
        question: published.poll.question,
        options: published.poll.options.map((o) => o.label),
        visibility: published.poll.visibility,
        acceptVotes: published.poll.acceptVotes,
      };
      pf.draft = null;
      pf.version += 1;
      pf.updatedAt = now();
      reportAudit(store, {
        actor: req.user.id,
        scope: "page",
        feature: def.key,
        action: "owner.publish_tally",
        before: { version: before.version },
        after: { pollId: published.poll.id, revision: published.poll.revision, version: pf.version },
        reason: (req.body && req.body.reason) || "",
      });
      archive.capture(store, page, req.user.id, now(), `publish ${def.key}`);
      saveStore();
      return res.json({ ...featureCard(store, page.id, def.key, now()), version: pf.version, message: published.message });
    }
    if (def.key === "daily_draw") {
      const drew = draw.publishDeck(store, page, result.value, now());
      if (!drew.ok) return res.status(drew.status).json(drew);
      pf.draft = null;
      reportAudit(store, {
        actor: req.user.id,
        scope: "page",
        feature: def.key,
        action: "owner.publish_draw",
        before: { version: before.version },
        after: { applied: drew.applied, version: pf.version },
        reason: (req.body && req.body.reason) || "",
      });
      archive.capture(store, page, req.user.id, now(), `publish ${def.key}`);
      saveStore();
      return res.json({ ...featureCard(store, page.id, def.key, now()), version: pf.version, message: drew.message });
    }
    if (def.key === "secret_word") {
      if (!secret.hasSecret(store, page.id)) {
        return res.status(422).json({ message: "Set a secret word before publishing.", errors: { phrase: "A secret word is required." } });
      }
      if (!secret.safeDestination(result.value.url)) {
        return res.status(422).json({ message: "Only http and https destinations are allowed.", errors: { url: "Only http and https destinations are allowed." } });
      }
      if (((pf.published && pf.published.url) || "") !== (result.value.url || "")) {
        pf.secretVersion = (pf.secretVersion || 0) + 1;
        secret.revokeGrants(store, page.id);
      }
    }
    pf.published = structuredClone(pf.draft);
    pf.version += 1;
    pf.updatedAt = now();
    reportAudit(store, {
      actor: req.user.id,
      scope: "page",
      feature: def.key,
      action: "owner.publish",
      before: { version: before.version },
      after: { version: pf.version },
      reason: (req.body && req.body.reason) || "",
    });
    archive.capture(store, page, req.user.id, now(), `publish ${def.key}`);
    saveStore();
    res.json({ ...featureCard(store, page.id, def.key, now()), version: pf.version, message: "Published. Drafts never enter public output; published state is now live content." });
  });

  app.post("/api/me/pages/:id/features/daily_draw/cancel", requireAuth, (req, res) => {
    const store = getStore();
    const page = getPage(store, req.params.id);
    if (!page) return res.status(404).json({ message: "Page not found." });
    if (!isOwnerOrAdmin(req.user, page)) return res.status(403).json({ message: "Not your page." });
    const result = draw.cancelPending(store, page);
    if (!result.ok) return res.status(result.status).json(result);
    reportAudit(store, {
      actor: req.user.id,
      scope: "page",
      feature: "daily_draw",
      action: "owner.cancel_revision",
      before: {},
      after: {},
      reason: (req.body && req.body.reason) || "",
    });
    saveStore();
    res.json({ ...result, state: draw.scheduleState(store, page, now()) });
  });

  app.post("/api/me/pages/:id/features/time_capsule/unpublish", requireAuth, (req, res) => {
    const store = getStore();
    const page = getPage(store, req.params.id);
    if (!page) return res.status(404).json({ message: "Page not found." });
    if (!isOwnerOrAdmin(req.user, page)) return res.status(403).json({ message: "Not your page." });
    const pf = ensurePageFeature(store, page.id, "time_capsule");
    const before = structuredClone(pf);
    pf.published = null;
    pf.version += 1;
    pf.updatedAt = now();
    reportAudit(store, {
      actor: req.user.id,
      scope: "page",
      feature: "time_capsule",
      action: "owner.unpublish",
      before: { version: before.version },
      after: { version: pf.version },
      reason: (req.body && req.body.reason) || "",
    });
    archive.capture(store, page, req.user.id, now(), "unpublish time_capsule");
    saveStore();
    res.json({
      ...featureCard(store, page.id, "time_capsule", now()),
      version: pf.version,
      state: capsule.capsuleState(store, page, now()),
      message: "Capsule unpublished. Future reads are hidden; a message already seen cannot be undone.",
    });
  });

  // ---------- owner: archive ----------
  function ownerArchiveCtx(req, res, needPage = true) {
    const store = getStore();
    const page = getPage(store, req.params.id);
    if (!page) {
      res.status(404).json({ message: "Page not found." });
      return null;
    }
    if (!isOwnerOrAdmin(req.user, page)) {
      res.status(403).json({ message: "Not your page." });
      return null;
    }
    return { store, page };
  }

  app.get("/api/me/pages/:id/archive", requireAuth, (req, res) => {
    const ctx = ownerArchiveCtx(req, res);
    if (!ctx) return;
    res.json({ ...archive.list(ctx.store, ctx.page), captureAllowed: archive.captureAllowed(ctx.store, ctx.page, now()) });
  });

  app.get("/api/me/pages/:id/archive/:rid", requireAuth, (req, res) => {
    const ctx = ownerArchiveCtx(req, res);
    if (!ctx) return;
    const rev = archive.getRevision(ctx.store, ctx.page, req.params.rid);
    if (!rev) return res.status(404).json({ message: "Revision not found." });
    res.json(rev);
  });

  app.post("/api/me/pages/:id/archive/:rid/restore", requireAuth, (req, res) => {
    const ctx = ownerArchiveCtx(req, res);
    if (!ctx) return;
    const result = archive.restore(ctx.store, ctx.page, req.params.rid, req.user.id, now(), req.body || {});
    if (!result.ok) return res.status(result.status).json(result);
    reportAudit(ctx.store, {
      actor: req.user.id,
      scope: "page",
      feature: "archive",
      action: "owner.restore",
      before: {},
      after: { restored: result.restored, archivedPreRestore: result.archivedPreRestore },
      reason: (req.body && req.body.reason) || "",
    });
    saveStore();
    res.json({ ...result, archive: archive.list(ctx.store, ctx.page) });
  });

  app.delete("/api/me/pages/:id/archive/:rid", requireAuth, (req, res) => {
    const ctx = ownerArchiveCtx(req, res);
    if (!ctx) return;
    const result = archive.remove(ctx.store, ctx.page, req.params.rid);
    if (!result.ok) return res.status(result.status).json(result);
    saveStore();
    res.json({ ...result, archive: archive.list(ctx.store, ctx.page) });
  });

  app.patch("/api/me/pages/:id/profile", requireAuth, (req, res) => {
    const store = getStore();
    const page = getPage(store, req.params.id);
    if (!page) return res.status(404).json({ message: "Page not found." });
    if (!isOwnerOrAdmin(req.user, page)) return res.status(403).json({ message: "Not your page." });
    const result = validateProfile(req.body);
    if (!result.ok) {
      return res.status(400).json({ message: "Invalid profile. Nothing was saved.", errors: result.errors });
    }
    const before = structuredClone(page.profile);
    page.profile = result.value;
    reportAudit(store, { actor: req.user.id, scope: "page", feature: "profile", action: "owner.update", before, after: structuredClone(page.profile), reason: "" });
    archive.capture(store, page, req.user.id, now(), "profile");
    saveStore();
    res.json(pageProfile(store, page.id));
  });

  app.get("/api/me/pages/:id/preview", requireAuth, (req, res) => {
    const store = getStore();
    const page = getPage(store, req.params.id);
    if (!page) return res.status(404).json({ message: "Page not found." });
    if (!isOwnerOrAdmin(req.user, page)) return res.status(403).json({ message: "Not your page." });
    const preview = ownerPreview(store, page.id, now());
    res.setHeader("Cache-Control", "no-store");
    res.json(preview);
  });

  // ---------- owner: ask me anything content ----------
  function ownerAskCtx(req, res) {
    const store = getStore();
    const page = getPage(store, req.params.id);
    if (!page) {
      res.status(404).json({ message: "Page not found." });
      return null;
    }
    if (!isOwnerOrAdmin(req.user, page)) {
      res.status(403).json({ message: "Not your page." });
      return null;
    }
    return { store, page };
  }

  app.get("/api/me/pages/:id/features/ask_anything/inbox", requireAuth, (req, res) => {
    const ctx = ownerAskCtx(req, res);
    if (!ctx) return;
    res.json({ feature: "ask_anything", pageId: ctx.page.id, ...ask.inbox(ctx.store, ctx.page.id) });
  });

  app.post("/api/me/pages/:id/features/ask_anything/records/:recordId/draft", requireAuth, (req, res) => {
    const ctx = ownerAskCtx(req, res);
    if (!ctx) return;
    const result = ask.saveDraft(ctx.store, ctx.page, req.params.recordId, req.body || {}, now());
    if (!result.ok) return res.status(result.status).json(result);
    saveStore();
    res.json(result);
  });

  app.post("/api/me/pages/:id/features/ask_anything/records/:recordId/publish", requireAuth, (req, res) => {
    const ctx = ownerAskCtx(req, res);
    if (!ctx) return;
    const result = ask.publishAnswer(ctx.store, ctx.page, req.params.recordId, req.body || {}, now());
    if (!result.ok) return res.status(result.status).json(result);
    saveStore();
    res.json(result);
  });

  app.post("/api/me/pages/:id/features/ask_anything/records/:recordId/unpublish", requireAuth, (req, res) => {
    const ctx = ownerAskCtx(req, res);
    if (!ctx) return;
    const result = ask.unpublish(ctx.store, ctx.page, req.params.recordId, req.body || {}, now());
    if (!result.ok) return res.status(result.status).json(result);
    saveStore();
    res.json(result);
  });

  app.post("/api/me/pages/:id/features/ask_anything/records/:recordId/reject", requireAuth, (req, res) => {
    const ctx = ownerAskCtx(req, res);
    if (!ctx) return;
    const result = ask.reject(ctx.store, ctx.page, req.params.recordId, req.body || {}, now());
    if (!result.ok) return res.status(result.status).json(result);
    saveStore();
    res.json(result);
  });

  app.post("/api/me/pages/:id/features/ask_anything/records/:recordId/restore", requireAuth, (req, res) => {
    const ctx = ownerAskCtx(req, res);
    if (!ctx) return;
    const result = ask.restoreDraft(ctx.store, ctx.page, req.params.recordId, req.body || {}, now());
    if (!result.ok) return res.status(result.status).json(result);
    saveStore();
    res.json(result);
  });

  app.delete("/api/me/pages/:id/features/ask_anything/records/:recordId", requireAuth, (req, res) => {
    const ctx = ownerAskCtx(req, res);
    if (!ctx) return;
    const result = ask.remove(ctx.store, ctx.page, req.params.recordId, now());
    if (!result.ok) return res.status(result.status).json(result);
    saveStore();
    res.json(result);
  });

  app.post("/api/me/pages/:id/features/ask_anything/reorder", requireAuth, (req, res) => {
    const ctx = ownerAskCtx(req, res);
    if (!ctx) return;
    const order = req.body && req.body.order;
    const result = ask.reorder(ctx.store, ctx.page, order, now());
    if (!result.ok) return res.status(result.status).json(result);
    saveStore();
    res.json(result);
  });

  // ---------- owner: guestbook moderation ----------
  function ownerGuestbookCtx(req, res) {
    return ownerAskCtx(req, res);
  }

  app.get("/api/me/pages/:id/features/guestbook/inbox", requireAuth, (req, res) => {
    const ctx = ownerGuestbookCtx(req, res);
    if (!ctx) return;
    res.json({
      feature: "guestbook",
      pageId: ctx.page.id,
      config: guestbook.publishedConfig(ctx.store, ctx.page.id),
      intakeOpen: guestbook.intakeOpen(ctx.store, ctx.page, now()),
      ...guestbook.inbox(ctx.store, ctx.page.id, { status: req.query.status, page: req.query.page, pageSize: req.query.pageSize }),
    });
  });

  app.post("/api/me/pages/:id/features/guestbook/records/:recordId/:action", requireAuth, (req, res) => {
    const ctx = ownerGuestbookCtx(req, res);
    if (!ctx) return;
    const result = guestbook.moderate(ctx.store, ctx.page, req.params.recordId, req.params.action, req.body || {}, now());
    if (!result.ok) return res.status(result.status).json(result);
    saveStore();
    res.json({ ...result, inbox: guestbook.inbox(ctx.store, ctx.page.id, {}) });
  });

  app.delete("/api/me/pages/:id/features/guestbook/records/:recordId", requireAuth, (req, res) => {
    const ctx = ownerGuestbookCtx(req, res);
    if (!ctx) return;
    const result = guestbook.deleteEntry(ctx.store, ctx.page, req.params.recordId, now());
    if (!result.ok) return res.status(result.status).json(result);
    saveStore();
    res.json({ ...result, inbox: guestbook.inbox(ctx.store, ctx.page.id, {}) });
  });

  app.post("/api/me/pages/:id/features/guestbook/reorder", requireAuth, (req, res) => {
    const ctx = ownerGuestbookCtx(req, res);
    if (!ctx) return;
    const result = guestbook.reorder(ctx.store, ctx.page, req.body && req.body.order, now());
    if (!result.ok) return res.status(result.status).json(result);
    saveStore();
    res.json(result);
  });

  // ---------- owner: chalkboard ----------
  app.get("/api/me/pages/:id/features/chalkboard/board", requireAuth, (req, res) => {
    const ctx = ownerArchiveCtx(req, res);
    if (!ctx) return;
    res.json(chalkboard.ownerView(ctx.store, ctx.page, now()));
  });

  app.post("/api/me/pages/:id/features/chalkboard/records/:recordId/:action", requireAuth, (req, res) => {
    const ctx = ownerArchiveCtx(req, res);
    if (!ctx) return;
    const result = chalkboard.moderate(ctx.store, ctx.page, req.params.recordId, req.params.action, now());
    if (!result.ok) return res.status(result.status).json(result);
    saveStore();
    res.json({ ...result, board: chalkboard.ownerView(ctx.store, ctx.page, now()) });
  });

  app.delete("/api/me/pages/:id/features/chalkboard/records/:recordId", requireAuth, (req, res) => {
    const ctx = ownerArchiveCtx(req, res);
    if (!ctx) return;
    const result = chalkboard.deleteRecord(ctx.store, ctx.page, req.params.recordId);
    if (!result.ok) return res.status(result.status).json(result);
    saveStore();
    res.json({ ...result, board: chalkboard.ownerView(ctx.store, ctx.page, now()) });
  });

  // ---------- owner: tally ----------
  function ownerTallyCtx(req, res) {
    const ctx = ownerArchiveCtx(req, res);
    if (!ctx) return null;
    return ctx;
  }

  app.post("/api/me/pages/:id/features/tally/close", requireAuth, (req, res) => {
    const ctx = ownerTallyCtx(req, res);
    if (!ctx) return;
    const result = tally.closePoll(ctx.store, ctx.page, now());
    if (!result.ok) return res.status(result.status).json(result);
    saveStore();
    res.json({ ...result, view: tally.ownerView(ctx.store, ctx.page, now()) });
  });

  app.post("/api/me/pages/:id/features/tally/reopen", requireAuth, (req, res) => {
    const ctx = ownerTallyCtx(req, res);
    if (!ctx) return;
    const result = tally.reopenPoll(ctx.store, ctx.page, now());
    if (!result.ok) return res.status(result.status).json(result);
    saveStore();
    res.json({ ...result, view: tally.ownerView(ctx.store, ctx.page, now()) });
  });

  app.post("/api/me/pages/:id/features/tally/reset", requireAuth, (req, res) => {
    const ctx = ownerTallyCtx(req, res);
    if (!ctx) return;
    const result = tally.resetPoll(ctx.store, ctx.page, now());
    if (!result.ok) return res.status(result.status).json(result);
    saveStore();
    res.json({ ...result, view: tally.ownerView(ctx.store, ctx.page, now()) });
  });

  // ---------- owner: neighbours ----------
  app.get("/api/me/pages/:id/neighbours", requireAuth, (req, res) => {
    const ctx = ownerArchiveCtx(req, res);
    if (!ctx) return;
    res.json(neighbours.ownerView(ctx.store, ctx.page, now()));
  });

  app.post("/api/me/pages/:id/neighbours", requireAuth, (req, res) => {
    const ctx = ownerArchiveCtx(req, res);
    if (!ctx) return;
    if (!evaluateFeature(ctx.store, ctx.page.id, "neighbours", now()).effectiveEnabled) {
      return res.status(409).json({ message: "Enable Neighbours before nominating pages." });
    }
    const result = neighbours.nominate(ctx.store, ctx.page, req.body || {}, now());
    if (!result.ok) return res.status(result.status).json(result);
    saveStore();
    res.status(201).json({ ...result, state: neighbours.ownerView(ctx.store, ctx.page, now()) });
  });

  app.delete("/api/me/pages/:id/neighbours/:toPageId", requireAuth, (req, res) => {
    const ctx = ownerArchiveCtx(req, res);
    if (!ctx) return;
    const result = neighbours.remove(ctx.store, ctx.page, req.params.toPageId, now());
    if (!result.ok) return res.status(result.status).json(result);
    saveStore();
    res.json({ ...result, state: neighbours.ownerView(ctx.store, ctx.page, now()) });
  });

  app.post("/api/me/pages/:id/neighbours/reorder", requireAuth, (req, res) => {
    const ctx = ownerArchiveCtx(req, res);
    if (!ctx) return;
    const result = neighbours.reorder(ctx.store, ctx.page, req.body && req.body.order, now());
    if (!result.ok) return res.status(result.status).json(result);
    saveStore();
    res.json({ ...result, state: neighbours.ownerView(ctx.store, ctx.page, now()) });
  });

  // ---------- owner: block layout (front/back placement) ----------
  app.get("/api/me/pages/:id/blocks", requireAuth, (req, res) => {
    const store = getStore();
    const page = getPage(store, req.params.id);
    if (!page) return res.status(404).json({ message: "Page not found." });
    if (!isOwnerOrAdmin(req.user, page)) return res.status(403).json({ message: "Not your page." });
    const blocks = pageBlocks(store, page, now());
    res.json({
      pageId: page.id,
      available: blocks.front.concat(blocks.back).map((b) => b.id),
      front: blocks.front,
      back: blocks.back,
      nightHidden: blocks.hidden,
      nightOnly: [...nightOnlyBlocks(store, page)],
      night: nightState(store, page, now()),
      flippable: evaluateFeature(store, page.id, "other_side", now()).effectiveEnabled,
    });
  });

  app.patch("/api/me/pages/:id/blocks", requireAuth, (req, res) => {
    const store = getStore();
    const page = getPage(store, req.params.id);
    if (!page) return res.status(404).json({ message: "Page not found." });
    if (!isOwnerOrAdmin(req.user, page)) return res.status(403).json({ message: "Not your page." });
    const entries = req.body && req.body.blocks;
    const result = setPlacements(store, page, entries, now());
    if (!result.ok) return res.status(result.status).json(result);
    reportAudit(store, {
      actor: req.user.id,
      scope: "page",
      feature: "other_side",
      action: "owner.placements",
      before: {},
      after: { blocks: store.placements[page.id] },
      reason: "",
    });
    archive.capture(store, page, req.user.id, now(), "block layout");
    saveStore();
    res.json({ ...result, blocks: pageBlocks(store, page, now()) });
  });

  // ---------- public ----------
  app.get("/api/pages/:slug/features", (req, res) => {
    const store = getStore();
    const page = pageBySlug(store, req.params.slug);
    if (!page) return res.status(404).json({ message: "Page not found." });
    res.json(publicFeatures(store, page, now()));
  });

  app.get("/api/pages/:slug", (req, res) => {
    const store = getStore();
    const page = pageBySlug(store, req.params.slug);
    if (!page) return res.status(404).json({ message: "Page not found." });
    res.json(publicFeatures(store, page, now()));
  });

  // ---------- public: ask me anything ----------
  app.get("/api/pages/:slug/ask", (req, res) => {
    const store = getStore();
    const page = pageBySlug(store, req.params.slug);
    if (!page) return res.status(404).json({ message: "Page not found." });
    if (!ask.isExposed(store, page, now())) return res.status(404).json({ message: "Not available." });
    res.json({ pageId: page.id, ...ask.publicView(store, page, now()) });
  });

  app.post("/api/pages/:slug/ask", (req, res) => {
    const store = getStore();
    const page = pageBySlug(store, req.params.slug);
    if (!page) return res.status(404).json({ message: "Page not found." });
    const forwarded = (req.headers["x-forwarded-for"] || "").toString().split(",")[0].trim();
    const ip = forwarded || req.socket?.remoteAddress || "local";
    const result = ask.submitQuestion(store, page, req.body, ip, now());
    if (!result.ok) return res.status(result.status).json(result);
    saveStore();
    res.status(201).json({ id: result.record.id, submittedAt: result.record.submittedAt, note: result.note });
  });

  // ---------- public: guestbook ----------
  app.get("/api/pages/:slug/guestbook", (req, res) => {
    const store = getStore();
    const page = pageBySlug(store, req.params.slug);
    if (!page) return res.status(404).json({ message: "Page not found." });
    const view = guestbook.publicView(store, page, now(), { page: req.query.page, pageSize: req.query.pageSize });
    if (!view) return res.status(404).json({ message: "Not available." });
    res.setHeader("Cache-Control", "no-store");
    res.json({ pageId: page.id, ...view });
  });

  app.get("/api/pages/:slug/guestbook/:entryId", (req, res) => {
    const store = getStore();
    const page = pageBySlug(store, req.params.slug);
    if (!page) return res.status(404).json({ message: "Page not found." });
    const entry = guestbook.publicEntry(store, page, req.params.entryId, now());
    if (!entry) return res.status(404).json({ message: "Not found." });
    res.setHeader("Cache-Control", "no-store");
    res.json(entry);
  });

  app.post("/api/pages/:slug/guestbook", (req, res) => {
    const store = getStore();
    const page = pageBySlug(store, req.params.slug);
    if (!page) return res.status(404).json({ message: "Page not found." });
    const forwarded = (req.headers["x-forwarded-for"] || "").toString().split(",")[0].trim();
    const ip = forwarded || req.socket?.remoteAddress || "local";
    const result = guestbook.submitEntry(store, page, req.body, ip, now());
    if (!result.ok) {
      if (result.retryAfterSec) res.setHeader("Retry-After", String(result.retryAfterSec));
      return res.status(result.status).json(result);
    }
    saveStore();
    res.status(201).json({ id: result.record.id, status: result.record.status, submittedAt: result.record.submittedAt, note: result.note });
  });

  // ---------- public: alive ----------
  function aliveCtx(req, res) {
    const store = getStore();
    const page = pageBySlug(store, req.params.slug);
    if (!page) {
      res.status(404).json({ message: "Page not found." });
      return null;
    }
    const excluded = isOwnerOrAdmin(req.user, page) || alive.isBot(req.headers["user-agent"]);
    return { store, page, excluded };
  }

  app.post("/api/pages/:slug/presence/heartbeat", (req, res) => {
    const ctx = aliveCtx(req, res);
    if (!ctx) return;
    const result = alive.heartbeat(ctx.store, ctx.page, req.body, { excluded: ctx.excluded }, now());
    if (!result.ok) return res.status(result.status).json(result);
    saveStore();
    res.json(result);
  });

  app.get("/api/pages/:slug/presence", (req, res) => {
    const ctx = aliveCtx(req, res);
    if (!ctx) return;
    if (!alive.childExposed(ctx.store, ctx.page, "alive_presence", now())) {
      return res.status(404).json({ message: "Presence is not available." });
    }
    res.setHeader("Cache-Control", "no-store");
    res.json({ count: alive.presenceCount(ctx.store, ctx.page, now()), ...alive.publicView(ctx.store, ctx.page, now()).presence });
  });

  app.post("/api/pages/:slug/hits", (req, res) => {
    const ctx = aliveCtx(req, res);
    if (!ctx) return;
    const result = alive.recordHit(ctx.store, ctx.page, req.body, { excluded: ctx.excluded }, now());
    if (!result.ok) return res.status(result.status).json(result);
    if (result.incremented) saveStore();
    res.json(result);
  });

  // ---------- public: secret word ----------
  app.post("/api/pages/:slug/secret", (req, res) => {
    const store = getStore();
    const page = pageBySlug(store, req.params.slug);
    if (!page) return res.status(404).json({ message: "Page not found." });
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    const result = secret.attemptUnlock(store, page, req.body && req.body.phrase, ip, now());
    res.setHeader("Cache-Control", "no-store");
    if (!result.ok) {
      if (result.retryAfterSec) res.setHeader("Retry-After", String(result.retryAfterSec));
      return res.status(result.status).json(result);
    }
    saveStore();
    res.json(result);
  });

  app.get("/api/pages/:slug/secret/grant/:grantId", (req, res) => {
    const store = getStore();
    const page = pageBySlug(store, req.params.slug);
    if (!page) return res.status(404).json({ message: "Page not found." });
    const resolved = secret.resolveGrant(store, page, req.params.grantId, now());
    if (!resolved) return res.status(410).json({ message: "This unlock has expired. Enter the word again." });
    res.setHeader("Cache-Control", "no-store");
    res.json(resolved);
  });

  // ---------- public: chalkboard ----------
  app.post("/api/pages/:slug/drawings", (req, res) => {
    const store = getStore();
    const page = pageBySlug(store, req.params.slug);
    if (!page) return res.status(404).json({ message: "Page not found." });
    const result = chalkboard.submitDrawing(store, page, req.body, now());
    if (!result.ok) return res.status(result.status).json(result);
    saveStore();
    res.status(201).json(result);
  });

  // ---------- public: tally ----------
  app.post("/api/pages/:slug/polls/:pollId/votes", (req, res) => {
    const store = getStore();
    const page = pageBySlug(store, req.params.slug);
    if (!page) return res.status(404).json({ message: "Page not found." });
    const result = tally.castVote(store, page, req.params.pollId, req.body, now());
    if (!result.ok) return res.status(result.status).json(result);
    saveStore();
    res.json(result);
  });

  // ---------- public: time capsule ----------
  app.get("/api/pages/:slug/capsule", (req, res) => {
    const store = getStore();
    const page = pageBySlug(store, req.params.slug);
    if (!page) return res.status(404).json({ message: "Page not found." });
    const before = store.pageFeatures[`${page.id}:time_capsule`];
    const openedBefore = before && before.openedAt;
    const view = capsule.publicView(store, page, now());
    if (!view) return res.status(404).json({ message: "Not available." });
    if (!openedBefore && before && before.openedAt) saveStore();
    res.setHeader("Cache-Control", "no-store");
    res.json(view);
  });

  // ---------- public: archive history ----------
  app.get("/api/pages/:slug/history", (req, res) => {
    const store = getStore();
    const page = pageBySlug(store, req.params.slug);
    if (!page) return res.status(404).json({ message: "Page not found." });
    const view = archive.publicList(store, page, now());
    if (!view) return res.status(404).json({ message: "Not available." });
    res.setHeader("Cache-Control", "no-store");
    res.json(view);
  });

  app.get("/api/pages/:slug/history/:rid", (req, res) => {
    const store = getStore();
    const page = pageBySlug(store, req.params.slug);
    if (!page) return res.status(404).json({ message: "Page not found." });
    const view = archive.publicGet(store, page, req.params.rid, now());
    if (!view) return res.status(404).json({ message: "Not available." });
    res.setHeader("Cache-Control", "no-store");
    res.json(view);
  });

  // ---------- admin: feature catalogue ----------
  app.get("/api/admin/features", requireRole("platform_admin"), (req, res) => {
    const store = getStore();
    const _now = now();
    const rows = allFeatures().map((f) => {
      const policy = store.features[f.key];
      const active = evaluateFeatureCounts(store, f.key, _now);
      const lastAudit = [...store.audit].reverse().find((a) => a.feature === f.key);
      return {
        key: f.key,
        name: f.name,
        category: f.category,
        tier: f.tier,
        parentKey: f.parentKey || null,
        globalEnabled: policy.globalEnabled,
        allowedPlans: [...policy.eligiblePlans],
        defaultEnabled: policy.defaultEnabled,
        rolloutPercent: policy.rolloutPercent,
        enabledProfileCount: active.enabled,
        configuredProfileCount: active.configured,
        rolloutStatus: policy.rolloutPercent >= 100 ? "full" : "staged",
        health: "ok",
        lastChange: lastAudit ? { actor: lastAudit.actor, time: lastAudit.time, action: lastAudit.action } : null,
        version: policy.version,
      };
    });
    res.json({ policyVersion: store.policyVersion, rows });
  });

  app.get("/api/admin/features/:key", requireRole("platform_admin"), (req, res) => {
    const store = getStore();
    const def = getFeature(req.params.key);
    if (!def) return res.status(404).json({ message: "Unknown feature." });
    const policy = store.features[def.key];
    const _now = now();
    const counts = evaluateFeatureCounts(store, def.key, _now);
    res.json({
      key: def.key,
      name: def.name,
      description: def.description,
      category: def.category,
      tier: def.tier,
      parentKey: def.parentKey || null,
      fields: def.fields,
      limits: def.limits,
      policy: {
        globalEnabled: policy.globalEnabled,
        allowedPlans: [...policy.eligiblePlans],
        defaultEnabled: policy.defaultEnabled,
        rolloutPercent: policy.rolloutPercent,
        version: policy.version,
      },
      activity: {
        configuredProfiles: counts.configured,
        enabledProfiles: counts.enabled,
        pendingSubmissions: 0,
        aggregateErrors: 0,
      },
      recentChanges: [...store.audit].reverse().filter((a) => a.feature === def.key).slice(0, 10),
    });
  });

  app.patch("/api/admin/features/:key", requireRole("platform_admin"), (req, res) => {
    const store = getStore();
    const def = getFeature(req.params.key);
    if (!def) return res.status(404).json({ message: "Unknown feature." });
    const policy = store.features[def.key];
    const body = req.body || {};
    const before = structuredClone(policy);

    if (body.globalEnabled !== undefined) {
      if (typeof body.globalEnabled !== "boolean") return res.status(422).json({ message: "globalEnabled must be a boolean." });
      policy.globalEnabled = body.globalEnabled;
    }
    if (body.allowedPlans !== undefined) {
      if (!Array.isArray(body.allowedPlans) || body.allowedPlans.length === 0) {
        return res.status(422).json({ message: "allowedPlans must be a non-empty array." });
      }
      for (const plan of body.allowedPlans) {
        if (!["free", "lifetime"].includes(plan)) return res.status(422).json({ message: `Unknown plan: ${plan}` });
      }
      policy.eligiblePlans = [...new Set(body.allowedPlans)];
    }
    if (body.rolloutPercent !== undefined) {
      if (typeof body.rolloutPercent !== "number" || body.rolloutPercent < 0 || body.rolloutPercent > 100) {
        return res.status(422).json({ message: "rolloutPercent must be 0-100." });
      }
      policy.rolloutPercent = body.rolloutPercent;
    }
    if (body.defaultEnabled !== undefined) {
      if (typeof body.defaultEnabled !== "boolean") return res.status(422).json({ message: "defaultEnabled must be a boolean." });
      policy.defaultEnabled = body.defaultEnabled;
    }
    if (body.limits !== undefined && typeof body.limits === "object") {
      policy.limits = { ...policy.limits, ...body.limits };
    }

    policy.version += 1;
    store.policyVersion += 1;
    policy.updatedAt = now();
    reportAudit(store, {
      actor: req.user.id,
      scope: "policy",
      feature: def.key,
      action: "admin.policy",
      before: { globalEnabled: before.globalEnabled, eligiblePlans: before.eligiblePlans, rolloutPercent: before.rolloutPercent },
      after: { globalEnabled: policy.globalEnabled, eligiblePlans: policy.eligiblePlans, rolloutPercent: policy.rolloutPercent },
      reason: (body.reason || "") + " (defaults retained; per-page config untouched)",
    });
    saveStore();
    res.json({ key: def.key, policy, message: "Policy saved. Global off always wins and keeps saved content." });
  });

  function evaluateFeatureCounts(store, featureKey, _now) {
    let configured = 0;
    let enabled = 0;
    for (const page of Object.values(store.pages)) {
      const pf = store.pageFeatures[`${page.id}:${featureKey}`];
      if (pf && pf.published) configured += 1;
      if (evaluateFeature(store, page.id, featureKey, _now).effectiveEnabled) enabled += 1;
    }
    return { configured, enabled };
  }

  // ---------- admin: users ----------
  app.get("/api/admin/users", requireRole("platform_admin"), (req, res) => {
    const store = getStore();
    const users = Object.values(store.users).map((u) => {
      const pages = Object.values(store.pages).filter((p) => p.ownerId === u.id);
      return {
        id: u.id,
        handle: u.handle,
        role: u.role,
        roleLabel: publicUser(u).roleLabel,
        plan: u.plan,
        suspended: u.suspended,
        pageCount: pages.length,
      };
    });
    res.json({ users });
  });

  app.get("/api/admin/users/:userId", requireRole("platform_admin"), (req, res) => {
    const store = getStore();
    const user = store.users[req.params.userId];
    if (!user) return res.status(404).json({ message: "User not found." });
    const _now = now();
    const pages = Object.values(store.pages)
      .filter((p) => p.ownerId === user.id)
      .map((p) => ({
        id: p.id,
        slug: p.slug,
        features: allFeatures().map((f) => {
          const ev = evaluateFeature(store, p.id, f.key, _now);
          return {
            key: f.key,
            name: f.name,
            parentKey: f.parentKey || null,
            requestedEnabled: ev.requestedEnabled,
            effectiveEnabled: ev.effectiveEnabled,
            reasonCode: ev.reasonCode,
          };
        }),
      }));
    res.json({ user: publicUser(user), suspended: user.suspended, pages, grants: store.grants.filter((g) => g.targetId === user.id) });
  });

  app.patch("/api/admin/users/:userId/features/:key/override", requireRole("platform_admin", "moderator"), (req, res) => {
    const store = getStore();
    const user = store.users[req.params.userId];
    if (!user) return res.status(404).json({ message: "User not found." });
    const def = getFeature(req.params.key);
    if (!def) return res.status(404).json({ message: "Unknown feature." });
    const body = req.body || {};
    const kind = body.kind;
    if (kind !== "grant" && kind !== "restrict") {
      return res.status(422).json({ message: "kind must be 'grant' or 'restrict'." });
    }
    if (!body.reason || typeof body.reason !== "string" || body.reason.trim().length === 0) {
      return res.status(422).json({ message: "A reason is required for overrides." });
    }
    let expiry = null;
    if (body.expiry) {
      const t = Date.parse(body.expiry);
      if (Number.isNaN(t)) return res.status(422).json({ message: "expiry must be a valid ISO time." });
      expiry = new Date(t).toISOString();
    }
    const grant = {
      id: newId("grant"),
      targetId: user.id,
      targetKey: "user",
      featureKey: def.key,
      kind,
      reason: body.reason.trim(),
      expiry,
      createdBy: req.user.id,
      createdAt: now(),
    };
    store.grants.push(grant);
    reportAudit(store, {
      actor: req.user.id,
      scope: "user",
      feature: def.key,
      action: kind === "grant" ? "admin.grant" : "admin.restrict",
      before: {},
      after: { target: user.id, kind, expiry },
      reason: body.reason.trim(),
    });
    saveStore();
    res.json({ grant, message: kind === "grant" ? "Entitlement grant applied." : "Restriction applied. It cannot bypass a hard global disable or suspension." });
  });

  // ---------- admin: public content moderation ----------
  app.get("/api/admin/features/ask_anything/content", requireRole("platform_admin"), (req, res) => {
    res.json({ content: ask.adminContent(getStore()) });
  });

  app.get("/api/admin/features/guestbook/content", requireRole("platform_admin"), (req, res) => {
    res.json({ content: guestbook.adminContent(getStore()) });
  });

  app.get("/api/admin/features/chalkboard/content", requireRole("platform_admin"), (req, res) => {
    res.json({ content: chalkboard.adminContent(getStore()) });
  });

  app.get("/api/admin/features/tally/content", requireRole("platform_admin"), (req, res) => {
    res.json({ content: tally.adminContent(getStore()) });
  });

  app.post("/api/admin/features/alive_hits/correct", requireRole("platform_admin", "moderator"), (req, res) => {
    const store = getStore();
    const body = req.body || {};
    const page = getPage(store, body.pageId);
    if (!page) return res.status(404).json({ message: "Page not found." });
    const result = alive.correctHits(store, page.id, body.count, req.user.id, body.reason, now());
    if (!result.ok) return res.status(result.status).json(result);
    saveStore();
    res.json(result);
  });

  app.post("/api/admin/features/:key/content/:recordId/action", requireRole("platform_admin", "moderator"), (req, res) => {
    const store = getStore();
    const def = getFeature(req.params.key);
    if (!def || (def.key !== "ask_anything" && def.key !== "guestbook" && def.key !== "chalkboard")) return res.status(404).json({ message: "Unknown feature." });
    const body = req.body || {};
    const result = def.key === "guestbook"
      ? guestbook.adminAction(store, req.params.recordId, body.action, req.user.id, body.reason, now())
      : def.key === "chalkboard"
        ? chalkboard.adminAction(store, req.params.recordId, body.action, req.user.id, body.reason, now())
        : ask.adminAction(store, req.params.recordId, body.action, req.user.id, body.reason, now());
    if (!result.ok) return res.status(result.status).json(result);
    saveStore();
    res.json(result);
  });

  // ---------- admin: audit ----------
  app.get("/api/admin/audit", requireRole("platform_admin"), (req, res) => {
    const store = getStore();
    res.json({ audit: [...store.audit].reverse().slice(0, 200) });
  });

  // ---------- dev helper: reset demo data ----------
  app.post("/api/dev/reset", (_req, res) => {
    ask.resetIntakeRate();
    guestbook.resetIntakeRate();
    secret.resetAttempts();
    resetStore();
    saveStore();
    res.json({ ok: true });
  });

  app.use(express.static(path.join(__dirname, "..", "public")));

  app.get("/p/:slug", (_req, res) => {
    res.sendFile(path.join(__dirname, "..", "public", "page.html"));
  });

  app.use((err, _req, res, _next) => {
    if (err instanceof SyntaxError && err.status === 400 && "body" in err) {
      res.status(400).json({ message: "Malformed JSON in request body.", errors: {} });
      return;
    }
    console.error(err);
    res.status(500).json({ message: "Internal server error.", errors: {} });
  });

  return app;
}

export { REASONS };