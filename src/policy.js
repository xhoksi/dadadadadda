import { getFeature, defaultConfig } from "./registry.js";

export const REASONS = {
  ENABLED: "enabled",
  OWNER_OFF: "owner_off",
  GLOBAL_OFF: "global_off",
  PLAN_LOCKED: "plan_locked",
  ROLLOUT_EXCLUDED: "rollout_excluded",
  CONFIGURATION_INCOMPLETE: "configuration_incomplete",
  SUSPENDED: "suspended",
  RESTRICTED: "restricted",
  UNKNOWN: "unknown",
};

function cohortOf(id) {
  let h = 0;
  for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 100;
}

function isGrantActive(grant, target, now) {
  return !!grant && grant.targetId === target && grant.kind === "grant" && (!grant.expiry || grant.expiry > now);
}

function activeRestriction(store, targetId, featureKey, now) {
  return store.grants.find(
    (g) =>
      g.targetId === targetId &&
      g.featureKey === featureKey &&
      g.kind === "restrict" &&
      (!g.expiry || g.expiry > now)
  );
}

function validateFieldValue(desc, value) {
  if (desc.type === "boolean") {
    if (typeof value !== "boolean") return "must be a boolean";
    return null;
  }
  if (desc.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) return "must be a number";
    if (desc.min != null && value < desc.min) return `must be at least ${desc.min}`;
    if (desc.max != null && value > desc.max) return `must be at most ${desc.max}`;
    return null;
  }
  if (desc.type === "string") {
    if (typeof value !== "string") return "must be a string";
    if (desc.pattern && value !== "" && !new RegExp(desc.pattern).test(value)) return `must match ${desc.pattern}`;
    if (desc.max != null && value.length > desc.max) return `must be ${desc.max} characters or fewer`;
    if (desc.min != null && value.length < desc.min) return `must be ${desc.min} characters or more`;
    return null;
  }
  if (desc.type === "enum") {
    if (!desc.values.includes(value)) return `must be one of: ${desc.values.join(", ")}`;
    return null;
  }
  if (desc.type === "array") {
    if (!Array.isArray(value)) return "must be an array";
    if (desc.minItems != null && value.length < desc.minItems) return `must contain at least ${desc.minItems} items`;
    if (desc.maxItems != null && value.length > desc.maxItems) return `must contain at most ${desc.maxItems} items`;
    for (const item of value) {
      if (desc.items === "string") {
        if (typeof item !== "string") return "items must be strings";
        if (desc.max != null && item.length > desc.max) return `items must be ${desc.max} characters or fewer`;
      }
    }
    return null;
  }
  return null;
}

// Validates and normalizes a draft config. Unknown keys are rejected;
// missing keys keep the previous value or fall back to the feature default.
export function validateConfig(featureKey, config, previous) {
  const def = getFeature(featureKey);
  if (!def) return { ok: false, errors: { _: "Unknown feature." } };
  if (config == null || typeof config !== "object" || Array.isArray(config)) {
    return { ok: false, errors: { _: "Config must be an object." } };
  }
  const allowed = new Set(Object.keys(def.fields));
  const errors = {};
  for (const key of Object.keys(config)) {
    if (!allowed.has(key)) errors[key] = "Unknown field.";
  }
  const next = {};
  for (const [name, desc] of Object.entries(def.fields)) {
    const has = Object.prototype.hasOwnProperty.call(config, name);
    const value = has ? config[name] : previous && previous[name] !== undefined ? previous[name] : desc.default;
    if (!has && value === undefined && desc.required) {
      errors[name] = "This field is required.";
      continue;
    }
    const err = validateFieldValue(desc, value);
    if (err) {
      errors[name] = err;
      continue;
    }
    next[name] = value;
  }
  if (typeof def.validate === "function") {
    const cross = def.validate(next);
    if (cross && typeof cross === "object" && !Array.isArray(cross)) {
      for (const [k, v] of Object.entries(cross)) if (v && !errors[k]) errors[k] = v;
    }
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, value: next };
}

// Evaluate the effective access for a feature on one page. The public path
// and the owner path share this single evaluator (one policy service).
export function evaluateFeature(store, pageId, featureKey, now) {
  const st = store;
  const def = getFeature(featureKey);
  if (!def) {
    return { requestedEnabled: false, effectiveEnabled: false, reasonCode: REASONS.UNKNOWN, policyVersion: st.policyVersion };
  }
  const page = st.pages[pageId];
  const pageF = st.pageFeatures[`${pageId}:${featureKey}`];
  const owner = page ? st.users[page.ownerId] : null;
  const policy = st.features[featureKey];
  if (!page || !owner || !pageF || !policy) {
    return { requestedEnabled: false, effectiveEnabled: false, reasonCode: REASONS.UNKNOWN, policyVersion: st.policyVersion };
  }
  const requestedEnabled = !!pageF.ownerEnabled;
  const policyVersion = st.policyVersion;
  const configVersion = (pageF.published && pageF.version) || null;

  const fail = (reasonCode) => ({
    requestedEnabled,
    effectiveEnabled: false,
    reasonCode,
    policyVersion,
    configVersion,
    canEdit: false,
  });

  if (!policy.globalEnabled && !def.parentKey) return fail(REASONS.GLOBAL_OFF);
  if (owner.suspended) return fail(REASONS.SUSPENDED);

  const grant = st.grants.find((g) => g.targetId === page.ownerId && g.featureKey === featureKey && isGrantActive(g, page.ownerId, now));

  if (def.parentKey) {
    const parent = evaluateFeature(store, pageId, def.parentKey, now);
    if (!parent.effectiveEnabled) {
      return { requestedEnabled, effectiveEnabled: false, reasonCode: parent.reasonCode, policyVersion, configVersion, canEdit: parent.canEdit };
    }
  }

  if (!policy.globalEnabled) return fail(REASONS.GLOBAL_OFF);

  if (activeRestriction(store, page.ownerId, featureKey, now)) return fail(REASONS.RESTRICTED);

  const planOk = policy.eligiblePlans.includes(owner.plan) || !!grant;
  if (!planOk) return fail(REASONS.PLAN_LOCKED);

  if (!grant && cohortOf(page.ownerId) >= (policy.rolloutPercent ?? 100)) return fail(REASONS.ROLLOUT_EXCLUDED);

  const canEdit = true;

  if (!requestedEnabled) {
    return { requestedEnabled, effectiveEnabled: false, reasonCode: REASONS.OWNER_OFF, policyVersion, configVersion, canEdit };
  }

  if (def.requiresConfig && !pageF.published) {
    return { requestedEnabled, effectiveEnabled: false, reasonCode: REASONS.CONFIGURATION_INCOMPLETE, policyVersion, configVersion, canEdit };
  }

  return {
    requestedEnabled,
    effectiveEnabled: true,
    reasonCode: REASONS.ENABLED,
    policyVersion,
    configVersion,
    canEdit,
    parentReason: def.parentKey ? evaluateFeature(store, pageId, def.parentKey, now).reasonCode : undefined,
  };
}

export function pageProfile(store, pageId) {
  const page = store.pages[pageId];
  if (!page) return null;
  return structuredClone(page.profile);
}

export function defaultConfigForFeature(featureKey) {
  return defaultConfig(featureKey);
}