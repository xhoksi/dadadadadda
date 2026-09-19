const slug = decodeURIComponent(location.pathname.split("/").pop());

const el = {
  avatar: document.getElementById("avatar"),
  name: document.getElementById("name"),
  bio: document.getElementById("bio"),
  linkWrap: document.getElementById("link-wrap"),
  night: document.getElementById("night-note"),
  featureLabels: document.getElementById("feature-labels"),
  foot: document.getElementById("foot"),
  moonWrap: document.getElementById("moon-wrap"),
  drawCard: document.getElementById("draw-card"),
  drawLine: document.getElementById("draw-line"),
  capsuleCard: document.getElementById("capsule-card"),
  capsuleLabel: document.getElementById("capsule-label"),
  capsuleSealed: document.getElementById("capsule-sealed"),
  capsuleCount: document.getElementById("capsule-count"),
  capsuleBody: document.getElementById("capsule-body"),
  historyCard: document.getElementById("history-card"),
  historySelect: document.getElementById("history-select"),
  historyView: document.getElementById("history-view"),
  neighboursCard: document.getElementById("neighbours-card"),
  neighboursList: document.getElementById("neighbours-list"),
  guestbook: document.getElementById("guestbook"),
  guestbookHeading: document.getElementById("guestbook-heading"),
  guestbookPrompt: document.getElementById("guestbook-prompt"),
  guestbookEntries: document.getElementById("guestbook-entries"),
  guestbookForm: document.getElementById("guestbook-form"),
  guestbookName: document.getElementById("guestbook-name"),
  guestbookMessage: document.getElementById("guestbook-message"),
  guestbookStatus: document.getElementById("guestbook-status"),
  guestbookSubmit: document.getElementById("guestbook-submit"),
  alive: document.getElementById("alive"),
  alivePresence: document.getElementById("alive-presence"),
  alivePresenceCount: document.getElementById("alive-presence-count"),
  aliveClock: document.getElementById("alive-clock"),
  aliveClockTime: document.getElementById("alive-clock-time"),
  aliveClockLabel: document.getElementById("alive-clock-label"),
  aliveHits: document.getElementById("alive-hits"),
  aliveHitsCount: document.getElementById("alive-hits-count"),
  secretCard: document.getElementById("secret-card"),
  secretForm: document.getElementById("secret-form"),
  secretInput: document.getElementById("secret-input"),
  secretStatus: document.getElementById("secret-status"),
  secretReveal: document.getElementById("secret-reveal"),
};

const faces = {
  card: document.getElementById("card"),
  inner: document.getElementById("flip-inner"),
  front: document.getElementById("face-front"),
  back: document.getElementById("face-back"),
  frontBlocks: document.getElementById("front-blocks"),
  backBlocks: document.getElementById("back-blocks"),
  backNote: document.getElementById("back-note"),
  backLinkWrap: document.getElementById("back-link-wrap"),
  corner: document.getElementById("flip-corner"),
  backToFront: document.getElementById("back-to-front"),
  flipped: false,
};

const FEATURE_ITEM_LABEL = {
  moon: "The moon",
  ask_anything: "Ask me a question",
  other_side: "One more side",
  night_shift: "Night hours",
  daily_draw: "Today's draw",
  time_capsule: "A sealed capsule",
  archive: "History",
  guestbook: "Sign the guestbook",
  neighbours: "Neighbours",
  alive: "Alive",
  secret_word: "A secret word",
  chalkboard: "A little drawing",
  tally: "Vote",
};

function drawIndex(seed, pageId, day, len) {
  const s = `${seed}|${pageId}|${day}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0) % len;
}

let memSeed = null;

function renderDraw(data) {
  const d = data.draw;
  const enabled = data.features.some((f) => f.key === "daily_draw");
  if (!enabled || !d || !d.cards || d.cards.length === 0) {
    el.drawCard.hidden = true;
    return;
  }
  let seed = null;
  let stored = null;
  try {
    stored = JSON.parse(localStorage.getItem(`misa_draw:${d.pageId}:seed`) || "null");
  } catch {
    stored = null;
  }
  if (stored && stored.seed && stored.day === d.day) {
    seed = stored.seed;
  } else {
    seed = Math.floor(Date.now()).toString(36) + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    try {
      localStorage.setItem(`misa_draw:${d.pageId}:seed`, JSON.stringify({ seed, day: d.day }));
    } catch {
      memSeed = seed;
    }
  }
  if (!seed) seed = memSeed;
  const idx = drawIndex(seed, d.pageId, d.day, d.cards.length);
  el.drawCard.hidden = false;
  el.drawLine.textContent = d.cards[idx];
  el.drawLine.classList.toggle("hand", d.style !== "type");
}

let capsuleTick = null;
let capsulePoll = null;

function formatCountdown(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return `${d}d ${pad(h)}h ${pad(m)}m ${pad(s)}s`;
}

function startCountdown(releaseAt, serverNow) {
  if (capsuleTick) clearInterval(capsuleTick);
  const skew = Date.parse(serverNow) - Date.now();
  const tick = () => {
    const left = Date.parse(releaseAt) - (Date.now() + skew);
    if (left <= 0) {
      el.capsuleCount.textContent = "Opening…";
      clearInterval(capsuleTick);
      capsuleTick = null;
      return;
    }
    el.capsuleCount.textContent = `Opens in ${formatCountdown(left)}`;
  };
  tick();
  capsuleTick = setInterval(tick, 1000);
}

async function loadCapsule() {
  try {
    const res = await fetch(`/api/pages/${encodeURIComponent(slug)}/capsule`, { headers: { Accept: "application/json" } });
    if (!res.ok) {
      el.capsuleCard.hidden = true;
      return;
    }
    const c = await res.json();
    el.capsuleCard.hidden = false;
    el.capsuleLabel.textContent = c.label || "A sealed message";
    if (c.state === "open") {
      if (capsuleTick) clearInterval(capsuleTick);
      if (capsulePoll) clearTimeout(capsulePoll);
      capsuleTick = null;
      capsulePoll = null;
      el.capsuleSealed.hidden = true;
      el.capsuleBody.hidden = false;
      el.capsuleBody.textContent = c.body || "";
      return;
    }
    // Sealed: the countdown is cosmetic; only the server decides when to open.
    el.capsuleSealed.hidden = false;
    el.capsuleBody.hidden = true;
    startCountdown(c.releaseAt, c.serverNow);
    if (capsulePoll) clearTimeout(capsulePoll);
    capsulePoll = setTimeout(loadCapsule, 20000);
  } catch {}
}

function renderCapsule(data) {
  const enabled = data.features.some((f) => f.key === "time_capsule");
  if (!enabled) {
    el.capsuleCard.hidden = true;
    if (capsuleTick) clearInterval(capsuleTick);
    if (capsulePoll) clearTimeout(capsulePoll);
    return;
  }
  loadCapsule();
}

async function loadHistoryEntry(revs, rid) {
  el.historyView.textContent = "";
  let snap;
  if (!rid) {
    const fresh = await (await fetch(`/api/pages/${encodeURIComponent(slug)}`, { headers: { Accept: "application/json" } })).json();
    snap = { profile: fresh.profile, features: fresh.features, historical: false, label: "Today" };
  } else {
    const res = await fetch(`/api/pages/${encodeURIComponent(slug)}/history/${encodeURIComponent(rid)}`, { headers: { Accept: "application/json" } });
    if (!res.ok) return;
    snap = await res.json();
  }
  const note = document.createElement("p");
  note.className = "history-note";
  note.textContent = snap.historical ? `Historical version · ${snap.label}` : "Current version";
  el.historyView.appendChild(note);
  const name = document.createElement("p");
  name.className = "history-name";
  name.textContent = snap.profile.displayName || "";
  el.historyView.appendChild(name);
  const bio = document.createElement("p");
  bio.className = "history-bio";
  bio.textContent = snap.profile.bio || "";
  el.historyView.appendChild(bio);
  const ul = document.createElement("ul");
  ul.className = "feature-labels";
  for (const f of snap.features) {
    if (f.parentKey) continue;
    const li = document.createElement("li");
    li.textContent = FEATURE_ITEM_LABEL[f.key] || f.name;
    ul.appendChild(li);
  }
  el.historyView.appendChild(ul);
}

async function renderHistory(data) {
  const enabled = data.features.some((f) => f.key === "archive");
  if (!enabled) {
    el.historyCard.hidden = true;
    return;
  }
  try {
    const res = await fetch(`/api/pages/${encodeURIComponent(slug)}/history`, { headers: { Accept: "application/json" } });
    if (!res.ok) {
      el.historyCard.hidden = true;
      return;
    }
    const history = await res.json();
    el.historyCard.hidden = false;
    el.historySelect.textContent = "";
    const make = (val, label) => {
      const o = document.createElement("option");
      o.value = val;
      o.textContent = label;
      return o;
    };
    el.historySelect.appendChild(make("", "Current"));
    for (const r of history.revisions) el.historySelect.appendChild(make(r.id, r.label));
    el.historySelect.onchange = () => loadHistoryEntry(history.revisions, el.historySelect.value);
    loadHistoryEntry(history.revisions, "");
  } catch {
    el.historyCard.hidden = true;
  }
}

const SVG_NS = "http://www.w3.org/2000/svg";

function renderMoon(data) {
  el.moonWrap.textContent = "";
  const m = data.moon;
  if (!m) return;
  const wrap = document.createElement("div");
  wrap.className = `moon moon-${m.corner || "top-right"}`;
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", m.svg.viewBox);
  svg.setAttribute("width", m.svg.width);
  svg.setAttribute("height", m.svg.height);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", m.phase.label);
  const disc = document.createElementNS(SVG_NS, "circle");
  disc.setAttribute("cx", "50");
  disc.setAttribute("cy", "50");
  disc.setAttribute("r", "46");
  disc.setAttribute("fill", m.svg.dark);
  const lit = document.createElementNS(SVG_NS, "path");
  lit.setAttribute("d", m.svg.path);
  lit.setAttribute("fill", m.svg.color);
  svg.appendChild(disc);
  svg.appendChild(lit);
  wrap.appendChild(svg);
  if (m.showLabel) {
    const label = document.createElement("span");
    label.className = "moon-label";
    label.textContent = m.phase.label;
    wrap.appendChild(label);
  }
  el.moonWrap.appendChild(wrap);
}

function renderNeighbours(data) {
  const n = data.neighbours;
  if (!n) {
    el.neighboursCard.hidden = true;
    return;
  }
  el.neighboursCard.hidden = false;
  el.neighboursList.textContent = "";
  if (n.entries.length === 0) {
    const none = document.createElement("p");
    none.className = "neighbour-none";
    none.textContent = "No mutual neighbours yet.";
    el.neighboursList.appendChild(none);
    return;
  }
  for (const entry of n.entries) {
    const chip = document.createElement("a");
    chip.className = "neighbour-chip";
    chip.href = `/p/${encodeURIComponent(entry.slug)}`;
    if (entry.color) chip.style.setProperty("--chip-color", entry.color);
    const dot = document.createElement("span");
    dot.className = "neighbour-dot";
    dot.setAttribute("aria-hidden", "true");
    const name = document.createElement("span");
    name.textContent = entry.handle || entry.slug;
    chip.appendChild(dot);
    chip.appendChild(name);
    el.neighboursList.appendChild(chip);
  }
}

function renderGuestbook(data) {
  const gb = data.guestbook;
  if (!gb) {
    el.guestbook.hidden = true;
    return;
  }
  el.guestbook.hidden = false;
  el.guestbookHeading.textContent = gb.config.heading || "Guestbook";
  el.guestbookPrompt.textContent = gb.config.prompt || "";
  el.guestbookForm.hidden = !gb.acceptNew;
  el.guestbookName.maxLength = gb.config.nameMax || 40;
  el.guestbookMessage.maxLength = gb.config.messageMax || 200;
  el.guestbookEntries.textContent = "";
  if (gb.entries.length === 0) {
    const none = document.createElement("p");
    none.className = "guest-none";
    none.textContent = "No approved entries yet.";
    el.guestbookEntries.appendChild(none);
  }
  for (const entry of gb.entries) {
    const box = document.createElement("div");
    box.className = "guest-entry";
    const name = document.createElement("p");
    name.className = "guest-name";
    name.textContent = entry.pinned ? `★ ${entry.displayName}` : entry.displayName;
    const message = document.createElement("p");
    message.className = `guest-message ${gb.config.handwriting === "handwritten" ? "hand" : "type"}`;
    message.textContent = entry.message;
    box.appendChild(name);
    box.appendChild(message);
    el.guestbookEntries.appendChild(box);
  }
}

function setGuestbookStatus(text, tone) {
  el.guestbookStatus.textContent = text;
  el.guestbookStatus.hidden = !text;
  el.guestbookStatus.dataset.tone = tone || "";
}

el.guestbookForm.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const displayName = el.guestbookName.value.trim();
  const message = el.guestbookMessage.value.trim();
  if (!displayName || !message) return;
  setGuestbookStatus("Signing…", "pending");
  el.guestbookSubmit.disabled = true;
  try {
    const res = await fetch(`/api/pages/${encodeURIComponent(slug)}/guestbook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName, message }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const first = data.errors ? Object.values(data.errors)[0] : null;
      setGuestbookStatus(first || data.message || "Your entry could not be saved.", "error");
      return;
    }
    el.guestbookName.value = "";
    el.guestbookMessage.value = "";
    setGuestbookStatus(data.note, "success");
  } catch {
    setGuestbookStatus("Could not reach the server. Try again later.", "error");
  } finally {
    el.guestbookSubmit.disabled = false;
  }
});

let aliveTokenMem = "";
function browserToken() {
  if (aliveTokenMem) return aliveTokenMem;
  try {
    const key = `misa-alive:${slug}`;
    let token = localStorage.getItem(key);
    if (!token) {
      token = (crypto && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`).replace(/[^a-z0-9-]/gi, "");
      localStorage.setItem(key, token);
    }
    aliveTokenMem = token;
  } catch {
    aliveTokenMem = `mem-${Date.now()}-${Math.random()}`.replace(/[^a-z0-9-]/gi, "");
  }
  return aliveTokenMem;
}

const aliveTimers = [];
function clearAliveTimers() {
  for (const t of aliveTimers.splice(0)) clearInterval(t);
}

function renderClock(node, cfg) {
  const opts = { timeZone: cfg.timezone, hour: "2-digit", minute: "2-digit", hour12: cfg.hourFormat === "12h" };
  try {
    node.textContent = new Intl.DateTimeFormat("en-GB", opts).format(new Date());
  } catch {
    node.textContent = new Intl.DateTimeFormat("en-GB", { ...opts, timeZone: "UTC" }).format(new Date());
  }
}

async function heartbeatPresence(cfg) {
  try {
    const res = await fetch(`/api/pages/${encodeURIComponent(slug)}/presence/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: browserToken(), visible: !document.hidden }),
    });
    if (!res.ok) throw new Error("unavailable");
    const data = await res.json();
    if (!data.excluded) el.alivePresenceCount.textContent = String(data.count);
  } catch {
    // A service outage must show Unavailable, not a fabricated zero.
    el.alivePresenceCount.textContent = "Unavailable";
  }
}

function qualifyHit(cfg) {
  if (document.hidden) return;
  const started = Date.now();
  const check = async () => {
    if (document.hidden) return;
    const visibleMs = Date.now() - started;
    if (visibleMs < (cfg.dwellSec || 5) * 1000) {
      setTimeout(check, (cfg.dwellSec || 5) * 1000 - visibleMs + 100);
      return;
    }
    try {
      const res = await fetch(`/api/pages/${encodeURIComponent(slug)}/hits`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: browserToken(), visibleMs }),
      });
      if (!res.ok) return;
      const data = await res.json();
      if (data.count !== undefined) el.aliveHitsCount.textContent = String(data.count);
    } catch {}
  };
  setTimeout(check, (cfg.dwellSec || 5) * 1000 + 100);
}

function renderAlive(data) {
  clearAliveTimers();
  const a = data.alive;
  if (!a) {
    el.alive.hidden = true;
    return;
  }
  el.alive.hidden = false;

  el.alivePresence.hidden = !a.presence || !a.presence.available;
  if (a.presence && a.presence.available) {
    el.alivePresenceCount.textContent = String(a.presence.count);
    heartbeatPresence(a.presence);
    aliveTimers.push(setInterval(() => {
      if (!document.hidden) heartbeatPresence(a.presence);
    }, (a.presence.heartbeatSec || 20) * 1000));
  }

  el.aliveClock.hidden = !a.clock;
  if (a.clock) {
    renderClock(el.aliveClockTime, a.clock);
    el.aliveClockLabel.textContent = a.clock.locationLabel || "";
    const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const period = reduce ? 60000 : 1000;
    aliveTimers.push(setInterval(() => renderClock(el.aliveClockTime, a.clock), period));
  }

  el.aliveHits.hidden = !a.hits;
  if (a.hits) {
    el.aliveHitsCount.textContent = String(a.hits.count);
    el.aliveHits.className = `alive-widget alive-hits style-${a.hits.style}`;
    qualifyHit(a.hits);
  }
}

function isEditable(target) {
  if (!target) return false;
  const tag = (target.tagName || "").toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (target.isContentEditable) return true;
  return false;
}

let secretBuffer = "";
let secretDebounce = null;

function revealSecret(data) {
  el.secretReveal.textContent = "";
  const a = document.createElement("a");
  a.className = "m-link";
  a.textContent = data.label || "A hidden link";
  a.href = data.url;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  el.secretReveal.appendChild(a);
  el.secretReveal.hidden = false;
  el.secretStatus.hidden = true;
  el.secretForm.hidden = true;
}

function setSecretStatus(text) {
  el.secretStatus.textContent = text;
  el.secretStatus.hidden = !text;
}

async function attemptSecret(phrase) {
  if (!phrase || !String(phrase).trim()) return;
  try {
    const res = await fetch(`/api/pages/${encodeURIComponent(slug)}/secret`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phrase }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setSecretStatus(data.message || "That word doesn't match.");
      return;
    }
    revealSecret(data);
  } catch {
    setSecretStatus("Could not reach the server. Try again later.");
  }
}

function secretKeydown(e) {
  if (el.secretCard.hidden) return;
  if (e.isComposing) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (isEditable(e.target)) return;
  if (e.key === "Backspace") {
    secretBuffer = secretBuffer.slice(0, -1);
    return;
  }
  // Only printable single characters enter the transient buffer.
  if (typeof e.key !== "string" || e.key.length !== 1) return;
  secretBuffer = (secretBuffer + e.key).slice(-64);
  clearTimeout(secretDebounce);
  secretDebounce = setTimeout(() => {
    const phrase = secretBuffer;
    secretBuffer = "";
    attemptSecret(phrase);
  }, 800);
}

function renderSecret(data) {
  document.removeEventListener("keydown", secretKeydown);
  secretBuffer = "";
  clearTimeout(secretDebounce);
  const s = data.secret_word;
  if (!s) {
    el.secretCard.hidden = true;
    return;
  }
  el.secretCard.hidden = false;
  el.secretCard.className = `m-card secret-card placement-${s.placement || "card"}`;
  el.secretForm.hidden = false;
  el.secretReveal.hidden = true;
  el.secretReveal.textContent = "";
  el.secretStatus.hidden = true;
  document.addEventListener("keydown", secretKeydown);
}

el.secretForm.addEventListener("submit", (ev) => {
  ev.preventDefault();
  const phrase = el.secretInput.value;
  el.secretInput.value = "";
  attemptSecret(phrase);
});

async function load() {
  try {
    const res = await fetch(`/api/pages/${encodeURIComponent(slug)}`, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`page not found (${res.status})`);
    const data = await res.json();
    const p = data.profile;

    el.name.textContent = p.displayName || "No display name";
    el.bio.textContent = p.bio || "No bio yet";
    el.avatar.textContent = p.displayName ? p.displayName[0].toUpperCase() : "?";

    if (data.night && data.night.active && data.night.message) {
      el.night.hidden = false;
      el.night.textContent = data.night.message;
    } else {
      el.night.hidden = true;
    }

    const card = data.card || { flippable: false, front: [] };
    const linkOnFront = card.front.some((b) => b.id === "link");
    const linkOnBack = card.flippable && card.back.some((b) => b.id === "link");

    el.linkWrap.textContent = "";
    faces.backLinkWrap.textContent = "";
    if (linkOnFront && p.link && p.link.label && p.link.url) {
      const a = document.createElement("a");
      a.className = "m-link";
      a.textContent = p.link.label;
      a.href = p.link.url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      el.linkWrap.appendChild(a);
    }
    if (linkOnBack && p.link && p.link.label && p.link.url) {
      const a = document.createElement("a");
      a.className = "m-link";
      a.textContent = p.link.label;
      a.href = p.link.url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      faces.backLinkWrap.appendChild(a);
    }

    renderChips(card.front, faces.frontBlocks);
    if (card.flippable) {
      faces.backNote.hidden = false;
      faces.backNote.textContent = card.note || "—";
      renderChips(card.back, faces.backBlocks);
      faces.corner.hidden = false;
      faces.corner.textContent = card.cornerLabel || "Flip";
      faces.inner.classList.remove("anim-fold", "anim-roll", "anim-fade");
      faces.inner.classList.add(`anim-${card.animation || "fold"}`);
    } else {
      faces.backNote.hidden = true;
      faces.back.hidden = true;
    }

    el.featureLabels.textContent = "";
    if (data.features.length === 0) {
      const li = document.createElement("li");
      li.textContent = "Nothing enabled yet.";
      el.featureLabels.appendChild(li);
    }
    for (const f of data.features) {
      if (f.parentKey) continue;
      const li = document.createElement("li");
      li.textContent = FEATURE_ITEM_LABEL[f.key] || f.name;
      el.featureLabels.appendChild(li);
    }

    renderMoon(data);
    renderDraw(data);
    renderCapsule(data);
    renderHistory(data);
    renderNeighbours(data);
    renderGuestbook(data);
    renderAlive(data);
    renderSecret(data);

    if (data.features.some((f) => f.key === "ask_anything")) {
      loadAsk();
    }

    el.foot.textContent = `policy v${data.policyVersion} · server ${data.serverNow}`;
  } catch (err) {
    el.name.textContent = "Not found";
    el.bio.textContent = err.message;
  }
}

function renderChips(list, container) {
  container.textContent = "";
  for (const b of list) {
    if (b.id === "link") continue;
    const li = document.createElement("li");
    li.className = "block-chip";
    li.textContent = b.label;
    container.appendChild(li);
  }
}

function setFlipped(flipped, moveFocus) {
  faces.flipped = flipped;
  faces.card.classList.toggle("flipped", flipped);
  faces.back.hidden = !flipped;
  faces.front.setAttribute("aria-hidden", flipped ? "true" : "false");
  faces.back.setAttribute("aria-hidden", flipped ? "false" : "true");
  faces.front.tabIndex = flipped ? -1 : 0;
  faces.back.tabIndex = flipped ? 0 : -1;
  if (moveFocus) {
    (flipped ? faces.backToFront : faces.corner).focus();
  }
}

faces.corner.addEventListener("click", () => setFlipped(true, true));
faces.backToFront.addEventListener("click", () => setFlipped(false, true));
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && faces.flipped) setFlipped(false, true);
});

const askEl = {
  wrap: document.getElementById("ask-anything"),
  prompt: document.getElementById("ask-prompt"),
  published: document.getElementById("ask-published"),
  form: document.getElementById("ask-form"),
  question: document.getElementById("ask-question"),
  contact: document.getElementById("ask-contact"),
  status: document.getElementById("ask-status"),
  submit: document.getElementById("ask-submit"),
};

function setAskStatus(text, tone) {
  askEl.status.textContent = text;
  askEl.status.hidden = !text;
  askEl.status.dataset.tone = tone || "";
}

async function loadAsk() {
  try {
    const res = await fetch(`/api/pages/${encodeURIComponent(slug)}/ask`, { headers: { Accept: "application/json" } });
    if (!res.ok) return;
    const data = await res.json();
    askEl.wrap.hidden = false;
    askEl.prompt.textContent = data.config.prompt || "";
    askEl.question.maxLength = data.config.lengthCap || 500;
    askEl.form.hidden = !data.config.acceptNew;
    if (!data.config.acceptNew) {
      setAskStatus("Questions are pausing for now. Published answers remain visible.", "muted");
    }
    askEl.published.textContent = "";
    if (data.published.length === 0) {
      const p = document.createElement("p");
      p.className = "ask-none";
      p.textContent = "No published questions yet.";
      askEl.published.appendChild(p);
    }
    for (const item of data.published) {
      const box = document.createElement("div");
      box.className = "ask-pair";
      const q = document.createElement("p");
      q.className = "ask-question";
      q.textContent = item.question;
      const a = document.createElement("p");
      a.className = `ask-answer ${data.config.handwriting === "handwritten" ? "hand" : "type"}`;
      a.textContent = item.answer;
      box.appendChild(q);
      box.appendChild(a);
      askEl.published.appendChild(box);
    }
  } catch {}
}

askEl.form.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const question = askEl.question.value.trim();
  if (!question) return;
  setAskStatus("Sending…", "pending");
  askEl.submit.disabled = true;
  try {
    const res = await fetch(`/api/pages/${encodeURIComponent(slug)}/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, contact: askEl.contact.value.trim() || undefined }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = data.errors && data.errors.question ? data.errors.question : data.message || "Message could not be sent.";
      setAskStatus(msg, "error");
      return;
    }
    askEl.question.value = "";
    askEl.contact.value = "";
    setAskStatus(data.note, "success");
  } catch {
    setAskStatus("Could not reach the server. Try again later.", "error");
  } finally {
    askEl.submit.disabled = false;
  }
});

load();

// The lunar phase is recomputed on load, at least hourly, and when the tab
// returns from the background. No runtime image or astronomy-service request.
setInterval(() => {
  if (!document.hidden) load();
}, 3600000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) load();
});