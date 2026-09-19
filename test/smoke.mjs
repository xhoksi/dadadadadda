import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const appJs = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

const HJSON = { "Content-Type": "application/json" };
const KEYS = [
  "ask_anything", "other_side", "night_shift", "daily_draw", "time_capsule",
  "archive", "moon", "guestbook", "neighbours", "alive", "alive_presence",
  "alive_clock", "alive_hits", "secret_word", "chalkboard", "tally",
];

// Minimal fake of the new authenticated API used by the editor.
function makeFakeServer(initialProfile) {
  let profile = structuredClone(initialProfile);
  let featureEnabled = new Map();
  for (const key of KEYS) featureEnabled.set(key, false);
  const token = "demo-token";
  let switches = 0;
  let profileSaves = 0;
  return {
    get switches() {
      return switches;
    },
    get profileSaves() {
      return profileSaves;
    },
    get profile() {
      return profile;
    },
    enabled(key) {
      return featureEnabled.get(key);
    },
    async handle(method, path, bodyRaw) {
      if (method === "POST" && path === "/api/auth/login") {
        return new Response(JSON.stringify({ token, user: { id: "u_nova", handle: "nova", role: "owner", roleLabel: "Profile owner", plan: "lifetime" } }), { status: 200, headers: HJSON });
      }
      if (method === "GET" && path === "/api/me") {
        return new Response(JSON.stringify({ user: { id: "u_nova", handle: "nova", role: "owner", plan: "lifetime" }, pages: [{ id: "p1", slug: "nova", ownerId: "u_nova", profile }] }), { status: 200, headers: HJSON });
      }
      if (method === "GET" && path === "/api/me/pages/p1/features") {
        const features = KEYS.map((key) => ({
          key,
          name: key,
          category: "x",
          tier: "free",
          parentKey: null,
          requiresConfig: false,
          requestedEnabled: featureEnabled.get(key),
          effectiveEnabled: featureEnabled.get(key),
          reasonCode: featureEnabled.get(key) ? "enabled" : "owner_off",
          canEdit: true,
          configVersion: 1,
          publishedAt: null,
        }));
        return new Response(JSON.stringify({ pageId: "p1", features }), { status: 200, headers: HJSON });
      }
      const featureMatch = path.match(/^\/api\/me\/pages\/p1\/features\/([^/]+)$/);
      if (method === "PATCH" && featureMatch) {
        let body = JSON.parse(bodyRaw);
        featureEnabled.set(featureMatch[1], body.ownerEnabled);
        switches++;
        return new Response(
          JSON.stringify({
            key: featureMatch[1], name: featureMatch[1], requestedEnabled: body.ownerEnabled,
            effectiveEnabled: body.ownerEnabled, reasonCode: body.ownerEnabled ? "enabled" : "owner_off",
            configVersion: 2, canEdit: true,
            message: "Saved. The switch is live policy; content stays a draft until published.",
          }),
          { status: 200, headers: HJSON }
        );
      }
      if (method === "PATCH" && path === "/api/me/pages/p1/profile") {
        let body;
        try {
          body = JSON.parse(bodyRaw);
        } catch {
          return new Response(JSON.stringify({ message: "Malformed JSON", errors: {} }), { status: 400, headers: HJSON });
        }
        const errors = {};
        const isStr = (v) => typeof v === "string";
        const link = body && typeof body === "object" ? body.link : undefined;
        const dn = isStr(body && body.displayName) ? body.displayName.trim() : undefined;
        const bio = isStr(body && body.bio) ? body.bio.trim() : undefined;
        const ll = link && isStr(link.label) ? link.label.trim() : undefined;
        const lu = link && isStr(link.url) ? link.url.trim() : undefined;

        if (!isStr(body && body.displayName)) errors.displayName = "Display name must be a string.";
        else if (dn.length < 1 || dn.length > 40) errors.displayName = "Display name must be 1-40 characters.";
        if (!isStr(body && body.bio)) errors.bio = "Bio must be a string.";
        else if (bio.length > 160) errors.bio = "Bio must be 160 characters or fewer.";
        if (!link || typeof link !== "object") {
          errors.linkLabel = "Link label must be a string.";
          errors.linkUrl = "Link URL must be a valid absolute https:// URL with a hostname.";
        } else {
          if (!isStr(link.label)) errors.linkLabel = "Link label must be a string.";
          else if (ll.length < 1 || ll.length > 30) errors.linkLabel = "Link label must be 1-30 characters.";
          if (!isStr(link.url)) errors.linkUrl = "Link URL must be a string.";
          else {
            let ok = false;
            try {
              const u = new URL(lu);
              ok = u.protocol === "https:" && u.hostname.length > 0;
            } catch {}
            if (!ok) errors.linkUrl = "Link URL must be a valid absolute https:// URL with a hostname.";
          }
        }
        if (Object.keys(errors).length > 0) {
          return new Response(JSON.stringify({ message: "Invalid profile. Nothing was saved.", errors }), { status: 400, headers: HJSON });
        }
        profile = { displayName: dn, bio, link: { label: ll, url: lu } };
        profileSaves++;
        return new Response(JSON.stringify(profile), { status: 200, headers: HJSON });
      }
      return new Response("not found", { status: 404 });
    },
  };
}

function boot(initial) {
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "http://localhost/", pretendToBeVisual: true });
  const fake = makeFakeServer(initial);
  dom.window.fetch = async (input, opts = {}) => {
    const url = new URL(input.toString(), "http://localhost");
    return fake.handle(opts.method || "GET", url.pathname, opts.body || null);
  };
  dom.window.localStorage.setItem("misa.token", "demo-token");
  dom.window.eval(appJs);
  return { dom, fake };
}

const byId = (dom, id) => dom.window.document.getElementById(id);
const typeInto = (dom, id, value) => {
  const el = byId(dom, id);
  el.value = value;
  el.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
};
const submit = (dom) =>
  byId(dom, "profile-form").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

test("logs in and loads profile from backend into the form", async () => {
  const { dom } = boot({
    displayName: "Nova",
    bio: "Music, late nights, and things I make.",
    link: { label: "My website", url: "https://example.com" },
  });
  await tick();
  assert.equal(byId(dom, "display-name").value, "Nova");
  assert.equal(byId(dom, "bio").value, "Music, late nights, and things I make.");
  assert.equal(byId(dom, "link-label").value, "My website");
  assert.equal(byId(dom, "link-url").value, "https://example.com");
  assert.equal(byId(dom, "preview-name").textContent, "Nova");
  assert.equal(byId(dom, "preview-bio").textContent, "Music, late nights, and things I make.");
});

test("feature cards render and toggling a switch sends the PATCH with expectedVersion", async () => {
  const { dom, fake } = boot({
    displayName: "Nova",
    bio: "b",
    link: { label: "My website", url: "https://example.com" },
  });
  await tick();

  const list = byId(dom, "feature-list");
  assert.ok(list.querySelector('[data-key="moon"]'), "moon card present");
  assert.equal(list.querySelector('[data-key="moon"]').classList.contains("on"), false);

  byId(dom, "feature-card-moon").querySelector(".switch").click();
  await tick();
  assert.equal(fake.switches, 1, "one PATCH sent");
  assert.equal(fake.enabled("moon"), true, "fake store updated");
  assert.equal(list.querySelector('[data-key="moon"]').classList.contains("on"), true, "switch reflects server state");
});

test("save shows pending state and succeeds only after server confirms", async () => {
  const { dom, fake } = boot({
    displayName: "Nova",
    bio: "b",
    link: { label: "My website", url: "https://example.com" },
  });
  await tick();

  typeInto(dom, "display-name", "Nova Renee");
  typeInto(dom, "bio", "longer bio");
  typeInto(dom, "link-label", "My site");
  typeInto(dom, "link-url", "https://example.com/");
  submit(dom);

  assert.equal(byId(dom, "save-button").disabled, true, "button disabled while pending");
  assert.equal(byId(dom, "save-button").textContent, "Saving…");

  await tick();
  assert.equal(byId(dom, "save-button").disabled, false, "button re-enabled after save");
  assert.equal(byId(dom, "save-status").textContent, "Saved — the server confirmed your profile.");
  assert.equal(byId(dom, "save-status").dataset.tone, "success");
  assert.equal(fake.profile.displayName, "Nova Renee");
  assert.equal(fake.profile.bio, "longer bio");
  assert.equal(fake.profileSaves, 1);
});

test("failed save keeps entries and surfaces server errors", async () => {
  const { dom, fake } = boot({
    displayName: "Nova",
    bio: "b",
    link: { label: "My website", url: "https://example.com" },
  });
  await tick();

  typeInto(dom, "display-name", "Keep Me");
  typeInto(dom, "bio", "keep this too");
  typeInto(dom, "link-label", "Bad link");
  typeInto(dom, "link-url", "http://insecure.example.com");
  submit(dom);
  await tick();

  assert.equal(fake.profile.displayName, "Nova", "rejected save must not change stored profile");
  const err = byId(dom, "link-url-error");
  assert.equal(err.hidden, false, "field error is visible");
  assert.match(err.textContent, /https:\/\//);
  assert.equal(byId(dom, "link-url").getAttribute("aria-invalid"), "true");
  assert.equal(byId(dom, "save-status").dataset.tone, "error");
  assert.equal(byId(dom, "display-name").value, "Keep Me");
  assert.equal(byId(dom, "bio").value, "keep this too");
  assert.equal(byId(dom, "link-url").value, "http://insecure.example.com");
});