import { evaluateFeature } from "../policy.js";
import { resolveWall, parseHHMM, parseOffset } from "../schedule.js";

// The time capsule: a private message revealed on a chosen date. The body lives
// only in the published config and leaves the server strictly through the
// public capsule endpoint once the release time has passed. Release is decided
// on every read against the live policy and the server clock; no scheduled job
// is ever involved. A capsule that has already opened once can never be
// re-sealed, so republishing always shows the same open state.

function recOf(store, page) {
  return store.pageFeatures[`${page.id}:time_capsule`];
}

// Recompute the absolute UTC release instant from the owner's wall-clock
// choices (DST-accurate; the config hook already rejected gap/ambiguous times).
export function resolveReleaseUtc(cfg, page) {
  if (!cfg || !cfg.releaseDate) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(cfg.releaseDate);
  if (!m) return null;
  const minutes = parseHHMM(cfg.releaseTime || "00:00");
  if (minutes === null) return null;
  const override = parseOffset(cfg.releaseOffset || "");
  const resolved = resolveWall(
    cfg.timezone || "UTC",
    { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) },
    minutes,
    override
  );
  return resolved.ok ? new Date(resolved.utcISO).toISOString() : null;
}

export function capsuleState(store, page, nowIso) {
  const rec = recOf(store, page);
  const published = rec && rec.published ? rec.published : null;
  const ev = evaluateFeature(store, page.id, "time_capsule", nowIso);
  const nowMs = Date.parse(nowIso);
  const releaseAt = published ? resolveReleaseUtc(published, page) : null;
  const open = ev.effectiveEnabled && !!releaseAt && nowMs >= Date.parse(releaseAt);
  if (open && rec && !rec.openedAt) {
    rec.openedAt = nowIso;
  }
  return {
    effectiveEnabled: ev.effectiveEnabled,
    published: !!published,
    open,
    releaseAt,
    label: published && published.label ? published.label : "",
    body: open && published ? (published.body || "") : null,
    timezone: published ? published.timezone || "UTC" : null,
    releaseTime: published ? published.releaseTime || "00:00" : null,
    releaseOffset: published ? published.releaseOffset || "" : "",
    openedAt: rec && rec.openedAt ? rec.openedAt : null,
  };
}

// Public capsule payload. Sealed: only an identifier, the safe label and the
// times; the body never leaves the server before release. Open: the body.
export function publicView(store, page, nowIso) {
  const st = capsuleState(store, page, nowIso);
  if (!st.effectiveEnabled || !st.published) return null;
  const base = {
    id: "capsule:" + page.id,
    state: st.open ? "open" : "sealed",
    releaseAt: st.releaseAt,
    serverNow: nowIso,
  };
  if (st.open) {
    base.label = st.label;
    base.body = st.body;
  } else {
    base.label = st.label || "A sealed message";
  }
  return base;
}