const form = document.getElementById("profile-form");
const saveButton = document.getElementById("save-button");
const saveStatus = document.getElementById("save-status");
const featureList = document.getElementById("feature-list");
const demoUser = document.getElementById("demo-user");
const loginButton = document.getElementById("login-button");
const loginStatus = document.getElementById("login-status");

const fields = {
  displayName: document.getElementById("display-name"),
  bio: document.getElementById("bio"),
  linkLabel: document.getElementById("link-label"),
  linkUrl: document.getElementById("link-url"),
};

const errorEls = {
  displayName: document.getElementById("display-name-error"),
  bio: document.getElementById("bio-error"),
  linkLabel: document.getElementById("link-label-error"),
  linkUrl: document.getElementById("link-url-error"),
};

const previewAvatar = document.getElementById("preview-avatar");
const previewName = document.getElementById("preview-name");
const previewBio = document.getElementById("preview-bio");
const previewLinkWrap = document.getElementById("preview-link-wrap");

const FIELD_ORDERS = ["displayName", "bio", "linkLabel", "linkUrl"];

let token = localStorage.getItem("misa.token") || null;
let user = null;
let currentPage = null;
let featureState = new Map();

const TIER_LABEL = {
  free: "Free",
  lifetime: "Lifetime",
  "free + lifetime": "Free + Lifetime",
};

const REASON_LABEL = {
  enabled: "Enabled",
  owner_off: "Owner off",
  global_off: "Global off",
  plan_locked: "Plan locked",
  rollout_excluded: "Rollout excluded",
  configuration_incomplete: "Configuration incomplete",
  suspended: "Suspended",
  restricted: "Restricted by support",
  unknown: "Unknown feature",
};

async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(path, { ...opts, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

function setStatus(el, text, tone) {
  el.textContent = text;
  el.dataset.tone = tone || "";
}

function setLoginStatus(text, tone) {
  setStatus(loginStatus, text, tone);
}

function setFieldError(key, message) {
  errorEls[key].textContent = message;
  errorEls[key].hidden = !message;
  fields[key].setAttribute("aria-invalid", message ? "true" : "false");
}

function clearFieldErrors() {
  for (const key of FIELD_ORDERS) setFieldError(key, "");
}

function showServerErrors(errors) {
  clearFieldErrors();
  for (const key of FIELD_ORDERS) {
    if (errors[key]) setFieldError(key, errors[key]);
  }
}

function currentValues() {
  return {
    displayName: fields.displayName.value,
    bio: fields.bio.value,
    link: {
      label: fields.linkLabel.value,
      url: fields.linkUrl.value,
    },
  };
}

function isValidHttpsUrl(raw) {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && url.hostname.length > 0;
  } catch {
    return false;
  }
}

function updatePreview() {
  const name = fields.displayName.value.trim();
  const bio = fields.bio.value.trim();
  const label = fields.linkLabel.value.trim();
  const url = fields.linkUrl.value.trim();

  previewName.textContent = name || "No display name";
  previewBio.textContent = bio || "No bio yet";
  previewAvatar.textContent = name ? name[0].toUpperCase() : "N";

  previewLinkWrap.textContent = "";
  const hasUrl = url.length > 0;

  if (label && hasUrl && isValidHttpsUrl(url)) {
    const a = document.createElement("a");
    a.className = "preview-anchor";
    a.textContent = label;
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    previewLinkWrap.appendChild(a);
  } else if (label || hasUrl) {
    const span = document.createElement("span");
    span.className = "preview-anchor preview-anchor-invalid";
    span.textContent = label || url;
    previewLinkWrap.appendChild(span);
  } else {
    const span = document.createElement("span");
    span.className = "preview-anchor preview-anchor-empty";
    span.textContent = "No link yet";
    previewLinkWrap.appendChild(span);
  }
}

function setSaveBusy(busy) {
  saveButton.disabled = busy;
  saveButton.textContent = busy ? "Saving…" : "Save";
}

function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s == null ? "" : String(s);
  return div.innerHTML;
}

function renderFeatures() {
  const featureIds = [...featureState.keys()];
  featureIds.sort((a, b) => {
    const fa = featureState.get(a);
    const fb = featureState.get(b);
    if (!!fa.parentKey !== !!fb.parentKey) return fa.parentKey ? 1 : -1;
    return a.localeCompare(b);
  });

  featureList.textContent = "";
  for (const key of featureIds) {
    const f = featureState.get(key);
    const card = document.createElement("div");
    card.className = "feature-row";
    card.id = `feature-card-${key}`;

    const indent = f.parentKey ? ' class="feature-child"' : "";
    const reason = REASON_LABEL[f.reasonCode] || f.reasonCode;
    const extra = f.effectiveEnabled ? "" : ` — ${reason}`;
    const badge = f.requiresConfig ? " <span class='badge-config'>config</span>" : "";

    card.innerHTML =
      `<div${indent}>
        <div class="feature-title">${escapeHtml(f.name)}${badge}<span class="tier">${TIER_LABEL[f.tier] || f.tier}</span></div>
        <div class="feature-state">${f.effectiveEnabled ? "On" : "Off"}${escapeHtml(extra)}</div>
      </div>
      <button class="switch ${f.requestedEnabled ? "on" : ""}" role="switch" aria-checked="${f.requestedEnabled}" data-key="${escapeHtml(key)}" ${f.canEdit ? "" : "disabled title=\"Not editable\""}>${f.requestedEnabled ? "On" : "Off"}</button>`;

    const toggle = card.querySelector(".switch");
    toggle.addEventListener("click", () => {
      const next = !f.requestedEnabled;
      doToggleFeature(key, next, toggle, f);
    });
    featureList.appendChild(card);
  }
}

async function loadFeatures() {
  const { res, data } = await api(`/api/me/pages/${currentPage.id}/features`);
  if (!res.ok) {
    setLoginStatus(data.message || "Could not load features.", "error");
    return;
  }
  featureState = new Map(data.features.map((f) => [f.key, f]));
  renderFeatures();
}

async function doToggleFeature(key, next, button, f) {
  button.disabled = true;
  const { res, data } = await api(`/api/me/pages/${currentPage.id}/features/${key}`, {
    method: "PATCH",
    body: { ownerEnabled: next, expectedVersion: f.configVersion || f.version },
  });
  if (!res.ok) {
    button.disabled = false;
    setLoginStatus(data.message || "Could not save the feature switch.", "error");
    loadFeatures();
    return;
  }
  button.disabled = false;
  featureState.set(key, { ...f, ...data });
  renderFeatures();
  setLoginStatus(data.message || "Saved.", "success");
}

async function loadProfile() {
  if (!currentPage) return;
  const p = currentPage.profile;
  fields.displayName.value = p.displayName;
  fields.bio.value = p.bio;
  fields.linkLabel.value = p.link.label;
  fields.linkUrl.value = p.link.url;
  clearFieldErrors();
  updatePreview();
}

async function saveProfile() {
  const { res, data } = await api(`/api/me/pages/${currentPage.id}/profile`, {
    method: "PATCH",
    body: currentValues(),
  });
  if (!res.ok) {
    showServerErrors(data.errors || {});
    setStatus(saveStatus, data.message || "Save failed. Your entries were kept so you can fix them.", "error");
    return;
  }
  clearFieldErrors();
  currentPage.profile = data;
  setStatus(saveStatus, "Saved — the server confirmed your profile.", "success");
}

async function afterLogin() {
  const { res, data } = await api("/api/me");
  if (!res.ok) {
    setLoginStatus("Session expired. Log in again.", "error");
    localStorage.removeItem("misa.token");
    token = null;
    return;
  }
  user = data.user;
  const myPages = data.pages.filter((p) => p.ownerId === user.id || user.role === "platform_admin");
  if (myPages.length === 0) {
    setLoginStatus("No pages to manage.", "error");
    return;
  }
  currentPage = myPages[0];
  form.hidden = user.role === "platform_admin" || user.role === "moderator";
  document.querySelector(".features-card").hidden = form.hidden;
  setLoginStatus(`Logged in as ${user.handle} (${user.roleLabel}).`, "success");
  await loadProfile();
  if (!form.hidden) await loadFeatures();
}

async function login() {
  const handle = demoUser.value;
  const { res, data } = await api("/api/auth/login", { method: "POST", body: { handle } });
  if (!res.ok) {
    setLoginStatus(data.message || "Login failed.", "error");
    return;
  }
  token = data.token;
  user = data.user;
  localStorage.setItem("misa.token", token);
  await afterLogin();
}

loginButton.addEventListener("click", login);
form.addEventListener("input", updatePreview);
form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (saveButton.disabled || !currentPage) return;
  clearFieldErrors();
  setSaveBusy(true);
  setStatus(saveStatus, "Saving…", "pending");
  saveProfile().finally(() => setSaveBusy(false));
});

(async () => {
  if (token) {
    await afterLogin();
  } else {
    setLoginStatus("Log in to manage the profile.", "pending");
  }
})();