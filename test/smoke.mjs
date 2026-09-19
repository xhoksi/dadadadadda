import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const appJs = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

const HJSON = { "Content-Type": "application/json" };

// Miniature of the server's rules so the test can exercise real 200/400
// round-trips. Kept purposely close to server.js validateProfile().
function makeFakeServer(initial) {
  let profile = structuredClone(initial);
  let saves = 0;
  return {
    get saves() {
      return saves;
    },
    get profile() {
      return profile;
    },
    async handle(method, path, bodyRaw) {
      if (path === "/api/profile" && method === "GET") {
        return new Response(JSON.stringify(profile), { status: 200, headers: HJSON });
      }
      if (path === "/api/profile" && method === "PUT") {
        let body;
        try {
          body = JSON.parse(bodyRaw);
        } catch {
          return new Response(JSON.stringify({ message: "Malformed JSON", errors: {} }), {
            status: 400,
            headers: HJSON,
          });
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
          return new Response(JSON.stringify({ message: "Invalid profile. Nothing was saved.", errors }), {
            status: 400,
            headers: HJSON,
          });
        }
        profile = { displayName: dn, bio, link: { label: ll, url: lu } };
        saves++;
        return new Response(JSON.stringify(profile), { status: 200, headers: HJSON });
      }
      return new Response("not found", { status: 404 });
    },
  };
}

function boot(initial) {
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "http://localhost/" });
  const fake = makeFakeServer(initial);
  dom.window.fetch = async (input, opts = {}) => {
    const url = new URL(input.toString(), "http://localhost");
    return fake.handle(opts.method || "GET", url.pathname, opts.body || null);
  };
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

test("loads profile from backend and fills the form", async () => {
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

test("preview updates live; invalid URL is never a clickable link", async () => {
  const { dom } = boot({
    displayName: "Nova",
    bio: "b",
    link: { label: "My website", url: "https://example.com" },
  });
  await tick();

  typeInto(dom, "display-name", "   Nana   ");
  typeInto(dom, "bio", "new bio");
  assert.equal(byId(dom, "preview-name").textContent, "Nana");
  assert.equal(byId(dom, "preview-bio").textContent, "new bio");
  assert.equal(byId(dom, "preview-avatar").textContent, "N");

  typeInto(dom, "link-url", "https://example.com");
  typeInto(dom, "link-label", "My website");
  let anchor = byId(dom, "preview-link-wrap").querySelector("a");
  assert.ok(anchor, "valid URL renders an anchor");
  assert.equal(anchor.getAttribute("href"), "https://example.com");

  // An invalid URL with a label must render as plain text, not a link.
  typeInto(dom, "link-url", "javascript:alert(1)");
  anchor = byId(dom, "preview-link-wrap").querySelector("a");
  const invalid = byId(dom, "preview-link-wrap").querySelector(".preview-anchor-invalid");
  assert.equal(anchor, null, "invalid URL must not produce an <a>");
  assert.ok(invalid, "invalid URL renders a non-clickable element");
  assert.equal(invalid.textContent, "My website");

  typeInto(dom, "link-url", "http://example.com");
  assert.equal(byId(dom, "preview-link-wrap").querySelector("a"), null, "http: URL must not produce an <a>");
});

test("save shows pending state, disables the button, and succeeds only after server confirms", async () => {
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

  // Pending state is applied synchronously by the submit handler.
  assert.equal(byId(dom, "save-button").disabled, true, "button disabled while pending");
  assert.equal(byId(dom, "save-button").textContent, "Saving…");

  await tick();
  assert.equal(byId(dom, "save-button").disabled, false, "button re-enabled after save");
  assert.equal(byId(dom, "save-status").textContent, "Saved — the server confirmed your profile.");
  assert.equal(byId(dom, "save-status").dataset.tone, "success");
  assert.equal(fake.profile.displayName, "Nova Renee");
  assert.equal(fake.profile.bio, "longer bio");
  assert.equal(fake.saves, 1);
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
  // Form entries must be preserved so the user can correct them.
  assert.equal(byId(dom, "display-name").value, "Keep Me");
  assert.equal(byId(dom, "bio").value, "keep this too");
  assert.equal(byId(dom, "link-url").value, "http://insecure.example.com");
});

test("subsequent valid save after a fix succeeds", async () => {
  const { dom, fake } = boot({
    displayName: "Nova",
    bio: "b",
    link: { label: "My website", url: "https://example.com" },
  });
  await tick();

  typeInto(dom, "link-url", "http://insecure.example.com");
  submit(dom);
  await tick();
  assert.equal(byId(dom, "save-status").dataset.tone, "error");

  typeInto(dom, "link-url", "https://secure.example.com");
  submit(dom);
  await tick();
  assert.equal(fake.profile.link.url, "https://secure.example.com");
  assert.equal(byId(dom, "save-status").dataset.tone, "success");
});