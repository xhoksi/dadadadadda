const slug = decodeURIComponent(location.pathname.split("/").pop());

const el = {
  avatar: document.getElementById("avatar"),
  name: document.getElementById("name"),
  bio: document.getElementById("bio"),
  linkWrap: document.getElementById("link-wrap"),
  featureLabels: document.getElementById("feature-labels"),
  foot: document.getElementById("foot"),
  moonWrap: document.getElementById("moon-wrap"),
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

function renderSymbol(data) {
  el.moonWrap.textContent = "";
  if (data.features.some((f) => f.key === "moon")) {
    const badge = document.createElement("span");
    badge.className = "moon-badge";
    badge.textContent = "☾ The moon";
    el.moonWrap.appendChild(badge);
  }
}

async function load() {
  try {
    const res = await fetch(`/api/pages/${encodeURIComponent(slug)}`, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`page not found (${res.status})`);
    const data = await res.json();
    const p = data.profile;

    el.name.textContent = p.displayName || "No display name";
    el.bio.textContent = p.bio || "No bio yet";
    el.avatar.textContent = p.displayName ? p.displayName[0].toUpperCase() : "?";

    el.linkWrap.textContent = "";
    if (p.link && p.link.label && p.link.url) {
      const a = document.createElement("a");
      a.className = "m-link";
      a.textContent = p.link.label;
      a.href = p.link.url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      el.linkWrap.appendChild(a);
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

    renderSymbol(data);

    if (data.features.some((f) => f.key === "ask_anything")) {
      loadAsk();
    }

    el.foot.textContent = `policy v${data.policyVersion} · server ${data.serverNow}`;
  } catch (err) {
    el.name.textContent = "Not found";
    el.bio.textContent = err.message;
  }
}

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