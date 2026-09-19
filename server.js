import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const initialProfile = {
  displayName: "Nova",
  bio: "Music, late nights, and things I make.",
  link: {
    label: "My website",
    url: "https://example.com",
  },
};

let profile = structuredClone(initialProfile);

const LIMITS = {
  displayName: { min: 1, max: 40 },
  bio: { min: 0, max: 160 },
  linkLabel: { min: 1, max: 30 },
};

/**
 * A valid link URL is an absolute https:// URL with a hostname.
 * Rejects malformed URLs and every other scheme (http:, javascript:,
 * data:, ftp:, relative paths, plain text, ...).
 */
function isValidHttpsUrl(raw) {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && url.hostname.length > 0;
  } catch {
    return false;
  }
}

/**
 * Validates a candidate profile. All values must be strings and are
 * trimmed before length checks and before saving. Returns either
 * { ok: true, value } with the trimmed profile, or { ok: false, errors }
 * with per-field messages. Two rules are enforced on top: the body must
 * be an object and the "link" object must be present.
 */
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

const app = express();
app.use(express.json());

app.get("/api/profile", (_req, res) => {
  res.json(profile);
});

app.put("/api/profile", (req, res) => {
  const result = validateProfile(req.body);
  if (!result.ok) {
    res.status(400).json({ message: "Invalid profile. Nothing was saved.", errors: result.errors });
    return;
  }
  profile = result.value;
  res.json(profile);
});

app.use(express.static(path.join(__dirname, "public")));

// Malformed JSON bodies (and other body-parser errors) must surface as
// a 400 invalid request, never a server crash.
app.use((err, _req, res, _next) => {
  if (err instanceof SyntaxError && err.status === 400 && "body" in err) {
    res.status(400).json({ message: "Malformed JSON in request body.", errors: {} });
    return;
  }
  console.error(err);
  res.status(500).json({ message: "Internal server error.", errors: {} });
});

app.listen(PORT, () => {
  console.log(`misa.lol editor running at http://localhost:${PORT}`);
});