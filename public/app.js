const form = document.getElementById("profile-form");
const saveButton = document.getElementById("save-button");
const saveStatus = document.getElementById("save-status");

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

// Client-side mirror of the server rule, used only to keep the preview
// honest while typing. The server remains the source of truth on save.
function isValidHttpsUrl(raw) {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && url.hostname.length > 0;
  } catch {
    return false;
  }
}

function setStatus(text, tone) {
  saveStatus.textContent = text;
  saveStatus.dataset.tone = tone || "";
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
    else errorEls[key].hidden = true;
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
    span.textContent = label || url; // never clickable when the URL isn't valid
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

async function loadProfile() {
  try {
    const res = await fetch("/api/profile");
    if (!res.ok) throw new Error(`server returned ${res.status}`);
    const p = await res.json();
    fields.displayName.value = p.displayName;
    fields.bio.value = p.bio;
    fields.linkLabel.value = p.link.label;
    fields.linkUrl.value = p.link.url;
    clearFieldErrors();
    updatePreview();
  } catch (err) {
    saveButton.disabled = true;
    setStatus(`Could not load profile from the server (${err.message}). Refresh to retry.`, "error");
  }
}

async function saveProfile() {
  try {
    const res = await fetch("/api/profile", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(currentValues()),
    });
    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      showServerErrors(data.errors || {});
      setStatus(data.message || "Save failed. Your entries were kept so you can fix them.", "error");
      return;
    }
    clearFieldErrors();
    // Success is only shown after the server confirms with 200.
    setStatus("Saved — the server confirmed your profile.", "success");
  } catch (err) {
    setStatus(`Could not reach the server. Your entries were kept. (${err.message})`, "error");
  }
}

form.addEventListener("input", updatePreview);
form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (saveButton.disabled) return; // prevent repeated submissions
  clearFieldErrors();
  setSaveBusy(true);
  setStatus("Saving…", "pending");
  saveProfile().finally(() => setSaveBusy(false));
});

loadProfile();