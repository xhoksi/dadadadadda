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

function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s == null ? "" : String(s);
  return div.innerHTML;
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

    el.foot.textContent = `policy v${data.policyVersion} · server ${data.serverNow}`;
  } catch (err) {
    el.name.textContent = "Not found";
    el.bio.textContent = err.message;
  }
}

load();