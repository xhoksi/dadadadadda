# misa.lol — mini profile editor (full-stack trial)

A small standalone editor for one fictional profile and one external link.
Plain HTML/CSS/JS on the frontend, one Express server on the backend with an
in-memory profile store.

## Run it

- Runtime: **Node.js >= 18** (developed and verified on **v24.21.0**).
- npm is used only for the single server dependency (`express`).

```sh
npm install
npm start        # http://localhost:3000  (PORT env var overrides the port)
```

Optional automated tests (jsdom smoke tests of the frontend):

```sh
npm test
```

## What it does

- Loads the profile from `GET /api/profile` and fills a 4-field form
  (display name, bio, link label, link URL).
- Live preview card beside the form updates as you type. All text is
  rendered as plain text. A valid `https://` URL becomes a clickable link;
  anything invalid is shown as plain text and is never linked.
- **Save** disables the button while pending, shows "Saving…", and only
  shows success after the server confirms with `200`. A failed save keeps
  every form entry and displays per-field server errors.
- Refreshing the page re-fetches from the server (no browser-only storage).
- Responsive single-column layout under 720px; full keyboard support
  (labels, focus rings, `role="status"` announcements).

## API contract

| Request | Behavior |
|---|---|
| `GET /api/profile` | `200` with the current profile. |
| `PUT /api/profile` | Validates the complete profile, saves it, `200` with the saved (trimmed) profile. |
| invalid update | `400`, profile left unchanged. |

Error response shape (chosen and documented here):

```json
{
  "message": "Invalid profile. Nothing was saved.",
  "errors": {
    "displayName": "Display name must be 1-40 characters.",
    "bio": "Bio must be 160 characters or fewer.",
    "linkLabel": "Link label must be 1-30 characters.",
    "linkUrl": "Link URL must be a valid absolute https:// URL with a hostname."
  }
}
```

Only failing fields appear under `errors`. Malformed JSON is also a `400`:

```json
{ "message": "Malformed JSON in request body.", "errors": {} }
```

Server-enforced rules (all four values must be strings; values are trimmed
before length checks and before saving):

- Display name: 1–40 characters after trimming.
- Bio: 0–160 characters after trimming (empty allowed).
- Link label: 1–30 characters after trimming.
- Link URL: a valid absolute `https://` URL with a hostname, checked with the
  standard `URL` API. `http:`, `javascript:`, `data:`, relative paths, and
  malformed URLs are rejected. Note: JavaScript's string length counts UTF-16
  code units; `smoke` simply uses `.length` throughout.

## Verification results (run against the live server)

**1. Successful save followed by a browser refresh**

```
PUT /api/profile  -> 200  {"displayName":"Nova Starlight","bio":"First save, then refresh, then a rejected update.","link":{"label":"My website","url":"https://example.com"}}
GET /api/profile  -> 200  same profile       (this is what the refreshed page loads)
```

**2. Invalid request sent directly to the API leaves the stored profile unchanged**

```
PUT /api/profile with link.url = "http://evil.com"  ->  400
GET /api/profile                                     ->  200, still the saved profile above
```

Additional direct-API checks that returned `400` with the stored profile
unchanged after each: missing `bio`, `displayName` as a number, 41-char name,
161-char bio, 31-char label, `http:`, `javascript:`, `data:`, `not a url`,
`https://` (malformed), `/about` (relative), malformed JSON body, and a
literal `null` body.

Frontend smoke tests (`npm test`, jsdom): pre-filled on load, live preview,
invalid URL never renders an `<a>`, pending/disabled state, success only
after server confirms, failed save preserves entries and shows server errors,
and a successful retry after a fix — **5/5 passing**.

"Browser refresh" above is reproduced at the HTTP level (a page load does a
fresh `GET /api/profile`); the same behavior was also exercised inside jsdom.

## Time spent, what works, what doesn't

- **Time:** roughly 75 minutes including setup, two passes of verification,
  and this README.
- **Works:** full save/load round trip, live preview with strict link rules,
  server-side validation for every rule in the brief (including malformed
  JSON), pending/success/failure states, keyboard + narrow-screen layout.
- **Not done (by design, out of scope):** auth, multiple users/links,
  uploads, real profile URL, persistent storage (spec allows in-memory),
  deployment.

## Tradeoffs and next steps

- **Tradeoff:** in-memory storage + vanilla frontend. This is the simplest
  setup that still satisfies "refreshing loads from the backend", and it
  makes the save flow trivially traceable. The cost is zero durability — a
  server restart resets to the starting profile.
- **First production improvement:** persist the profile in a real store
  (SQLite/Postgres) so data survives restarts, and keep validation on the
  server exactly as-is (move it to one shared function/module) so the
  frontend and backend can never drift. After that I'd add prettier URL
  handling (punycode display, trailing-slash normalization) and a stricter
  hostname check (a bare `https://site` currently passes because it has a
  hostname — a production site would likely require a dot-separated domain).

## Origin

- Started from **zero-dependency-ish vanilla HTML/CSS/JS + Express** (a
  deliberate choice over a React/Vite starter: no build step, one process,
  easiest to review and verify in the time budget).
- Used an **AI assistant** to scaffold and to double-check edge cases in the
  URL validator and the PowerShell/curl verification commands. The result was
  verified by running the test suite above, direct API calls, and reading the
  final code. No other starter, template, or UI library used.