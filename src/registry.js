// Misa feature registry. Single source of truth for the 13 feature groups,
// tier mapping, defaults, limits and validated configurable fields.
// "alive" child widgets are real registry entries with a parentKey.

export const TIERS = {
  free: "free",
  lifetime: "lifetime",
  free_plus_lifetime: "free + lifetime",
};

const LIMITS = {
  ask_anything: { questionMax: 500, answerMax: 2000 },
  daily_draw: { cardsMax: 12, cardMaxChars: 160 },
  time_capsule: { bodyMax: 5000, activeMax: 1 },
  archive: { revisionsMax: 12 },
  guestbook: { nameMax: 40, messageMax: 200, visibleMax: 20 },
  neighbours: { slotsMax: 5 },
  chalkboard: { strokesMax: 100, pointsMax: 10000, payloadKB: 100, pendingMax: 100, keptMax: 50, pinnedMax: 3 },
  tally: { questionMax: 200, optionMax: 80, optionsMin: 2, optionsMax: 4 },
  secret_word: { phraseMin: 4, phraseMax: 64, labelMax: 80, urlMax: 2048 },
};

function field({ type, default: def, required = false, min, max, values, items, maxItems, pattern }) {
  return { type, default: def, required, min, max, values, items, maxItems, pattern };
}

export const FEATURES = [
  {
    key: "ask_anything", name: "Ask me anything", category: "interaction", tier: TIERS.free,
    eligiblePlans: ["free", "lifetime"], defaultEnabled: false, requiresConfig: false,
    limits: LIMITS.ask_anything,
    description: "A visitor sends a private question; only an intentionally published Q&A becomes public.",
    fields: {
      acceptNew: field({ type: "boolean", default: true, required: true }),
      prompt: field({ type: "string", default: "Ask me anything", max: 200 }),
      lengthCap: field({ type: "number", default: 500, min: 1, max: 500 }),
      anonymousLabel: field({ type: "boolean", default: false }),
      handwriting: field({ type: "enum", default: "handwritten", values: ["handwritten", "type"] }),
    },
  },
  {
    key: "other_side", name: "The other side", category: "cards", tier: TIERS.lifetime,
    eligiblePlans: ["lifetime"], defaultEnabled: false, requiresConfig: false,
    limits: { backNoteMax: 500 },
    description: "Flip the profile card to a handwritten note and blocks assigned to the back.",
    fields: {
      backNote: field({ type: "string", default: "", max: 500 }),
      cornerLabel: field({ type: "string", default: "Flip", max: 30 }),
      animation: field({ type: "enum", default: "fold", values: ["fold", "roll", "fade"] }),
    },
  },
  {
    key: "night_shift", name: "The night shift", category: "scheduled", tier: TIERS.lifetime,
    eligiblePlans: ["lifetime"], defaultEnabled: false, requiresConfig: true,
    limits: { messageMax: 200 },
    description: "Selected blocks appear only during the owner's chosen local night hours.",
    fields: {
      timezone: field({ type: "string", default: "UTC", required: true, pattern: "^[a-zA-Z_]+(/[a-zA-Z_+-]+)*$" }),
      start: field({ type: "string", default: "23:00", required: true, pattern: "^([01]\\d|2[0-3]):[0-5]\\d$" }),
      end: field({ type: "string", default: "05:00", required: true, pattern: "^([01]\\d|2[0-3]):[0-5]\\d$" }),
      message: field({ type: "string", default: "", max: 200 }),
      blocks: field({ type: "array", default: [], items: "string", maxItems: 50 }),
    },
  },
  {
    key: "daily_draw", name: "The draw", category: "scheduled", tier: TIERS.lifetime,
    eligiblePlans: ["lifetime"], defaultEnabled: false, requiresConfig: true,
    limits: LIMITS.daily_draw,
    description: "A deck of up to 12 lines; each browser keeps one card for the owner-local day.",
    fields: {
      cards: field({ type: "array", default: [], items: "string", maxItems: 12, max: 160 }),
      style: field({ type: "enum", default: "handwritten", values: ["handwritten", "type"] }),
    },
  },
  {
    key: "time_capsule", name: "Time capsule", category: "scheduled", tier: TIERS.lifetime,
    eligiblePlans: ["lifetime"], defaultEnabled: false, requiresConfig: true,
    limits: LIMITS.time_capsule,
    description: "A message held on the server and revealed on a chosen date.",
    fields: {
      label: field({ type: "string", default: "", max: 120 }),
      body: field({ type: "string", default: "", max: 5000 }),
      releaseDate: field({ type: "string", default: "", required: true }),
      releaseTime: field({ type: "string", default: "00:00", pattern: "^([01]\\d|2[0-3]):[0-5]\\d$" }),
      timezone: field({ type: "string", default: "UTC", required: true }),
    },
  },
  {
    key: "archive", name: "The archive", category: "history", tier: TIERS.free,
    eligiblePlans: ["free", "lifetime"], defaultEnabled: false, requiresConfig: false,
    limits: LIMITS.archive,
    description: "Keeps the last 12 replaced page versions with a public browsing switch.",
    fields: {
      publicBrowsing: field({ type: "boolean", default: false }),
    },
  },
  {
    key: "moon", name: "The moon", category: "display", tier: TIERS.free,
    eligiblePlans: ["free", "lifetime"], defaultEnabled: false, requiresConfig: false,
    limits: {},
    description: "A calculated lunar phase drawn as an SVG vector with a text label.",
    fields: {
      corner: field({ type: "enum", default: "top-right", values: ["top-left", "top-right", "bottom-left", "bottom-right"] }),
      size: field({ type: "enum", default: "small", values: ["small", "medium", "large"] }),
      color: field({ type: "string", default: "#c22b35", pattern: "^#[0-9a-fA-F]{6}$" }),
      showLabel: field({ type: "boolean", default: true }),
      hemisphere: field({ type: "enum", default: "north", values: ["north", "south"] }),
    },
  },
  {
    key: "guestbook", name: "Guestbook", category: "interaction", tier: TIERS.free,
    eligiblePlans: ["free", "lifetime"], defaultEnabled: false, requiresConfig: false,
    limits: LIMITS.guestbook,
    description: "Visitor display-name and message entries held in a private moderation queue.",
    fields: {
      heading: field({ type: "string", default: "Guestbook", max: 120 }),
      prompt: field({ type: "string", default: "Sign the guestbook", max: 200 }),
      intakePaused: field({ type: "boolean", default: false }),
      pinning: field({ type: "boolean", default: false }),
      handwriting: field({ type: "enum", default: "handwritten", values: ["handwritten", "type"] }),
    },
  },
  {
    key: "neighbours", name: "Neighbours", category: "network", tier: TIERS.free,
    eligiblePlans: ["free", "lifetime"], defaultEnabled: false, requiresConfig: true,
    limits: LIMITS.neighbours,
    description: "A mutual network of up to five pages; a neighbour appears only if both nominate each other.",
    fields: {
      nominations: field({ type: "array", default: [], items: "string", maxItems: 5 }),
    },
  },
  {
    key: "alive", name: "Alive", category: "presence", tier: TIERS.free_plus_lifetime,
    eligiblePlans: ["free", "lifetime"], defaultEnabled: false, requiresConfig: false,
    limits: { heartbeatSec: 20, leaseSec: 60, hitWindowMin: 30 },
    description: "A group of three small widgets: presence, owner clock and a retro hit counter.",
    fields: {
      timezone: field({ type: "string", default: "UTC" }),
      locationLabel: field({ type: "string", default: "", max: 80 }),
      hourFormat: field({ type: "enum", default: "12h", values: ["12h", "24h"] }),
    },
  },
  {
    key: "alive_presence", name: "Presence", category: "presence", tier: TIERS.free,
    parentKey: "alive", eligiblePlans: ["free", "lifetime"], defaultEnabled: true, requiresConfig: false,
    limits: {},
    description: "A compact approximate live-visitor count using expiring leases.",
    fields: {},
  },
  {
    key: "alive_clock", name: "Clock", category: "presence", tier: TIERS.free,
    parentKey: "alive", eligiblePlans: ["free", "lifetime"], defaultEnabled: true, requiresConfig: false,
    limits: {},
    description: "A clock showing current time in the owner's chosen IANA timezone.",
    fields: {},
  },
  {
    key: "alive_hits", name: "Hit counter", category: "presence", tier: TIERS.free_plus_lifetime,
    parentKey: "alive", eligiblePlans: ["free", "lifetime"], defaultEnabled: true, requiresConfig: false,
    limits: {},
    description: "A retro hit counter on qualified visits with an atomic persistent total.",
    fields: {
      counterStyle: field({ type: "enum", default: "odometer", values: ["odometer", "lcd", "split-flap"] }),
    },
  },
  {
    key: "secret_word", name: "Secret word", category: "secret", tier: TIERS.lifetime,
    eligiblePlans: ["lifetime"], defaultEnabled: false, requiresConfig: true,
    limits: LIMITS.secret_word,
    description: "A visitor-entered phrase reveals an otherwise absent link; neither is sent before a successful check.",
    fields: {
      phrase: field({ type: "string", default: "", pattern: "^.{4,64}$" }),
      url: field({ type: "string", default: "" }),
      label: field({ type: "string", default: "", max: 80 }),
    },
  },
  {
    key: "chalkboard", name: "A chalkboard", category: "interaction", tier: TIERS.free,
    eligiblePlans: ["free", "lifetime"], defaultEnabled: false, requiresConfig: false,
    limits: LIMITS.chalkboard,
    description: "Visitors draw normalized strokes; the owner keeps, rejects, pins or deletes them.",
    fields: {
      title: field({ type: "string", default: "Chalkboard", max: 120 }),
      theme: field({ type: "enum", default: "dark", values: ["dark", "light"] }),
      gallerySize: field({ type: "number", default: 20, min: 1, max: 50 }),
      intakePaused: field({ type: "boolean", default: false }),
    },
  },
  {
    key: "tally", name: "The tally", category: "interaction", tier: TIERS.free,
    eligiblePlans: ["free", "lifetime"], defaultEnabled: false, requiresConfig: true,
    limits: LIMITS.tally,
    description: "A compact anonymous poll with two to four answers shown as scratch tally marks.",
    fields: {
      question: field({ type: "string", default: "", max: 200 }),
      options: field({ type: "array", default: [], items: "string", minItems: 2, maxItems: 4, max: 80 }),
      visibility: field({ type: "enum", default: "after_vote", values: ["after_vote", "always", "after_close"] }),
      acceptVotes: field({ type: "boolean", default: true }),
    },
  },
];

const map = new Map();
for (const f of FEATURES) map.set(f.key, f);

export function getFeature(key) {
  return map.get(key);
}

export function allFeatures() {
  return FEATURES.map((f) => f);
}

export function isParentKey(key) {
  return FEATURES.some((f) => f.parentKey === key);
}

export function defaultConfig(featureKey) {
  const def = map.get(featureKey);
  if (!def) return null;
  const config = {};
  for (const [name, desc] of Object.entries(def.fields)) config[name] = desc.default;
  return config;
}

export function defaultPolicy(featureKey) {
  const def = map.get(featureKey);
  if (!def) return null;
  return {
    key: def.key,
    globalEnabled: true,
    eligiblePlans: [...def.eligiblePlans],
    rolloutPercent: 100,
    defaultEnabled: def.defaultEnabled,
    limits: { ...(def.limits || {}) },
    version: 1,
    updatedAt: null,
  };
}