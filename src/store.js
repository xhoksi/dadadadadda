import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { allFeatures, defaultPolicy } from "./registry.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DATA_FILE = path.join(__dirname, "..", "data", "store.json");

let seq = 1;
let store = null;
let dataFile = DEFAULT_DATA_FILE;

function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${seq++}`;
}

function seed() {
  const users = {
    u_admin: { id: "u_admin", handle: "admin", role: "platform_admin", plan: "lifetime", suspended: false },
    u_mod: { id: "u_mod", handle: "mod", role: "moderator", plan: "lifetime", suspended: false },
    u_nova: { id: "u_nova", handle: "nova", role: "owner", plan: "lifetime", suspended: false },
    u_luna: { id: "u_luna", handle: "luna", role: "owner", plan: "free", suspended: false },
  };
  const now = new Date().toISOString();
  const pages = {
    p1: {
      id: "p1",
      slug: "nova",
      ownerId: "u_nova",
      timezone: "Europe/Berlin",
      profile: { displayName: "Nova", bio: "Music, late nights, and things I make.", link: { label: "My website", url: "https://example.com" } },
    },
    p2: {
      id: "p2",
      slug: "luna",
      ownerId: "u_luna",
      timezone: "America/New_York",
      profile: { displayName: "Luna", bio: "Daylight observer.", link: { label: "Luna labs", url: "https://example.org" } },
    },
  };
  const features = {};
  for (const f of allFeatures()) features[f.key] = defaultPolicy(f.key);
  const pageFeatures = {};
  for (const page of Object.values(pages)) {
    for (const f of allFeatures()) {
      pageFeatures[`${page.id}:${f.key}`] = {
        pageId: page.id,
        featureKey: f.key,
        ownerEnabled: false,
        draft: null,
        published: null,
        version: 1,
        updatedAt: now,
      };
    }
  }
  return {
    policyVersion: 1,
    users,
    pages,
    features,
    pageFeatures,
    grants: [],
    askAnything: [],
    guestbook: [],
    neighbourEdges: [],
    presenceLeases: [],
    hits: {},
    hitDedup: {},
    secretGrants: [],
    placements: {},
    drawSchedules: {},
    pageArchive: {},
    audit: [
      {
        id: newId("audit"),
        actor: "u_admin",
        scope: "system",
        feature: "moon",
        action: "policy.seed",
        before: {},
        after: { globalEnabled: true },
        reason: "Initial policy seeded for demo.",
        time: now,
      },
    ],
  };
}

function load() {
  if (store) return store;
  try {
    const raw = fs.readFileSync(dataFile, "utf8");
    store = JSON.parse(raw);
    if (!Array.isArray(store.askAnything)) store.askAnything = [];
    if (!Array.isArray(store.guestbook)) store.guestbook = [];
    if (!Array.isArray(store.neighbourEdges)) store.neighbourEdges = [];
    if (!Array.isArray(store.presenceLeases)) store.presenceLeases = [];
    if (!store.hits || typeof store.hits !== "object") store.hits = {};
    if (!store.hitDedup || typeof store.hitDedup !== "object") store.hitDedup = {};
    if (!Array.isArray(store.secretGrants)) store.secretGrants = [];
    if (!store.placements || typeof store.placements !== "object") store.placements = {};
    if (!store.drawSchedules || typeof store.drawSchedules !== "object") store.drawSchedules = {};
    if (!store.pageArchive || typeof store.pageArchive !== "object") store.pageArchive = {};
  } catch {
    store = seed();
    persist();
  }
  return store;
}

function persist() {
  fs.mkdirSync(path.dirname(dataFile), { recursive: true });
  const tmp = `${dataFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), "utf8");
  fs.renameSync(tmp, dataFile);
}

export function configureStore(file) {
  dataFile = file;
}

export function resetStore() {
  store = seed();
}

export function getStore() {
  return load();
}

export function saveStore() {
  persist();
}

export { newId };