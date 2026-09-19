const form = document.getElementById("profile-form");
const saveButton = document.getElementById("save-button");
const saveStatus = document.getElementById("save-status");
const featureList = document.getElementById("feature-list");
const demoUser = document.getElementById("demo-user");
const loginButton = document.getElementById("login-button");
const loginStatus = document.getElementById("login-status");
const askCard = document.getElementById("ask-card");
const askCardSub = document.getElementById("ask-card-sub");
const askManager = document.getElementById("ask-manager");
const blocksCard = document.getElementById("blocks-card");
const blocksCardSub = document.getElementById("blocks-card-sub");
const blocksManager = document.getElementById("blocks-manager");
const drawCard = document.getElementById("draw-card");
const drawCardSub = document.getElementById("draw-card-sub");
const drawManager = document.getElementById("draw-manager");

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
let askState = { box: null };
let blocksState = { front: [], back: [], nightHidden: [], nightOnly: [], night: null, flippable: false };

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
      <div class="feature-controls">
        <button class="switch ${f.requestedEnabled ? "on" : ""}" role="switch" aria-checked="${f.requestedEnabled}" data-key="${escapeHtml(key)}" ${f.canEdit ? "" : "disabled title=\"Not editable\""}>${f.requestedEnabled ? "On" : "Off"}</button>
        <button type="button" class="config-btn" data-config-key="${escapeHtml(key)}">Edit settings</button>
      </div>`;

    const toggle = card.querySelector(".switch");
    toggle.addEventListener("click", () => {
      const next = !f.requestedEnabled;
      doToggleFeature(key, next, toggle, f);
    });
    card.querySelector(".config-btn").addEventListener("click", () => openConfigEditor(key));
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

  const hasAsk = featureState.has("ask_anything");
  askCard.hidden = !hasAsk;
  if (hasAsk) loadAsk();

  const hasBlocks = featureState.has("other_side");
  blocksCard.hidden = !hasBlocks;
  if (hasBlocks) loadBlocks();

  const hasDraw = featureState.has("daily_draw");
  drawCard.hidden = !hasDraw;
  if (hasDraw) loadDraw();
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

// ---------- feature config editor (registry-driven) ----------
let configDetail = {};

function fieldControl(desc, name) {
  const wrap = document.createElement("div");
  wrap.className = "cfg-field";
  const label = document.createElement("label");
  label.className = "cfg-label";
  const text = document.createElement("span");
  text.textContent = desc.label || name;
  wrap.appendChild(label);
  if (desc.type === "boolean") {
    const box = document.createElement("input");
    box.type = "checkbox";
    label.appendChild(box);
    label.appendChild(text);
  } else {
    label.appendChild(text);
    let control;
    if (desc.type === "enum") {
      control = document.createElement("select");
      for (const v of desc.values) {
        const opt = document.createElement("option");
        opt.value = v;
        opt.textContent = v;
        control.appendChild(opt);
      }
    } else if (desc.type === "array") {
      control = document.createElement("textarea");
      control.rows = 3;
    } else if (desc.type === "string") {
      control = (desc.max || 120) > 120 ? document.createElement("textarea") : document.createElement("input");
      control.type = "text";
      if (desc.max) control.maxLength = desc.max;
    } else if (desc.type === "number") {
      control = document.createElement("input");
      control.type = "number";
      if (desc.min !== undefined) control.min = desc.min;
      if (desc.max !== undefined) control.max = desc.max;
    }
    control.className = "cfg-input";
    wrap.appendChild(control);
  }
  return { wrap, desc, input: desc.type === "boolean" ? wrap.querySelector("input") : wrap.querySelector(".cfg-input") };
}

function setConfigValue(control, desc, value) {
  if (value === undefined || value === null) value = desc.default;
  if (desc.type === "boolean") control.checked = !!value;
  else if (desc.type === "number") control.value = value == null ? "" : String(value);
  else if (desc.type === "array") control.value = Array.isArray(value) ? value.join("\n") : "";
  else control.value = String(value ?? "");
}

function collectConfig(controls) {
  const out = {};
  for (const [name, entry] of Object.entries(controls)) {
    const { control, desc } = entry;
    if (desc.type === "boolean") out[name] = control.checked;
    else if (desc.type === "number") out[name] = control.value === "" ? null : Number(control.value);
    else if (desc.type === "array") out[name] = control.value.split("\n").map((s) => s.trim()).filter(Boolean);
    else out[name] = control.value;
  }
  return out;
}

// ---------- time capsule panel (resolved instant, sealed preview, unpublish) ----------
function tzOffsetMinutes(tz, atMs) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" }).formatToParts(new Date(atMs));
    const raw = (parts.find((p) => p.type === "timeZoneName") || {}).value || "";
    const m = /GMT([+-])(\d{2}):(\d{2})/.exec(raw);
    if (!m) return 0;
    const mag = Number(m[2]) * 60 + Number(m[3]);
    return m[1] === "-" ? -mag : mag;
  } catch {
    return 0;
  }
}

function resolveWallClient(dateStr, timeStr, tz, offsetStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr || "")) return null;
  const minutes = /^([01]\d|2[0-3]):([0-5]\d)$/.test(timeStr || "") ? Number(timeStr.slice(0, 2)) * 60 + Number(timeStr.slice(3, 5)) : null;
  if (minutes === null) return null;
  const explicit = /^([+-])([01]\d|2[0-3]):([0-5]\d)$/.exec(offsetStr || "");
  const override = explicit ? (explicit[1] === "-" ? -1 : 1) * (Number(explicit[2]) * 60 + Number(explicit[3])) : null;
  const naive = Date.parse(`${dateStr}T00:00:00Z`) + minutes * 60000;
  if (Number.isNaN(naive)) return null;
  let utc = naive - (override != null ? override : tzOffsetMinutes(tz, naive)) * 60000;
  for (let i = 0; i < 3 && override == null; i++) {
    const next = naive - tzOffsetMinutes(tz, utc) * 60000;
    if (next === utc) break;
    utc = next;
  }
  return new Date(utc).toISOString();
}

function renderCapsulePanel(panel, controls, detail, refresh) {
  const box = document.createElement("div");
  box.className = "cfg-field capsule-panel";
  const title = document.createElement("h3");
  title.className = "ask-group";
  title.textContent = "Time capsule";
  box.appendChild(title);

  const resolved = document.createElement("p");
  resolved.className = "cfg-hint";
  box.appendChild(resolved);

  const seal = document.createElement("p");
  seal.className = "capsule-mock";
  box.appendChild(seal);

  const state = detail.state || {};
  const live = document.createElement("p");
  live.className = "cfg-hint";
  live.textContent = state.published
    ? `Live capsule: ${state.open ? "open since" : "sealed until"} ${state.releaseAt || "—"}${state.open ? "" : ` (${state.label || "no label"})`}.`
    : "No published capsule yet. A draft never leaves the server.";
  box.appendChild(live);

  const update = () => {
    const v = collectConfig(controls);
    const iso = resolveWallClient(v.releaseDate, v.releaseTime, v.timezone, v.releaseOffset);
    resolved.textContent = iso
      ? `Resolves to ${iso} UTC on the server. ${v.releaseTime === "00:00" || !v.releaseTime ? "Date-only picks 00:00 in the chosen timezone." : ""}`
      : "Enter a real date (YYYY-MM-DD) and HH:MM to see the resolved UTC time.";
    seal.textContent = `Preview sealed: ✉ ${v.label || "A sealed message"}`;
  };
  for (const n of ["releaseDate", "releaseTime", "timezone", "releaseOffset", "label"]) {
    if (controls[n]) controls[n].input.addEventListener("input", update);
    if (controls[n]) controls[n].input.addEventListener("change", update);
  }
  update();

  if (detail.config && detail.config.published) {
    const unpub = document.createElement("button");
    unpub.type = "button";
    unpub.className = "config-btn";
    unpub.textContent = "Unpublish capsule";
    unpub.addEventListener("click", async () => {
      const r = await api(`/api/me/pages/${currentPage.id}/features/time_capsule/unpublish`, { method: "POST", body: {} });
      live.textContent = r.data.message || (r.res.ok ? "Unpublished." : "Could not unpublish.");
      if (r.res.ok) refresh("Unpublished. Future reads are hidden.");
    });
    box.appendChild(unpub);
  }
  panel.appendChild(box);
}

async function openConfigEditor(key) {
  const card = document.getElementById(`feature-card-${key}`);
  let panel = card.querySelector(".config-panel");
  if (panel) {
    panel.hidden = !panel.hidden;
    return;
  }
  const { res, data } = await api(`/api/me/pages/${currentPage.id}/features/${key}`);
  if (!res.ok) {
    setLoginStatus(data.message || "Could not load feature settings.", "error");
    return;
  }
  configDetail[key] = data;
  panel = document.createElement("div");
  panel.className = "config-panel";
  const detail = data;
  const current = detail.config.draft || detail.config.published || {};
  const controls = {};
  for (const [name, desc] of Object.entries(detail.fields)) {
    const entry = fieldControl(desc, name);
    setConfigValue(entry.input, desc, current[name]);
    panel.appendChild(entry.wrap);
    controls[name] = entry;
  }
  const hint = document.createElement("p");
  hint.className = "cfg-hint";
  const draftState = detail.config.draft ? "(draft not published)" : detail.config.published ? "(live)" : "(not configured)";
  hint.textContent = `Save keeps a private draft; Publish makes it live config. Current: ${draftState}.`;
  panel.appendChild(hint);
  if (key === "time_capsule") renderCapsulePanel(panel, controls, detail, refresh);

  const actions = document.createElement("div");
  actions.className = "cfg-actions";
  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.textContent = "Save draft";
  const pubBtn = document.createElement("button");
  pubBtn.type = "button";
  pubBtn.textContent = "Publish";
  const cfgStatus = document.createElement("p");
  cfgStatus.className = "status";
  actions.appendChild(saveBtn);
  actions.appendChild(pubBtn);
  actions.appendChild(cfgStatus);
  panel.appendChild(actions);

  async function refresh(extra) {
    const { res: r2, data: d2 } = await api(`/api/me/pages/${currentPage.id}/features/${key}`);
    if (r2.ok) {
      configDetail[key] = d2;
      Object.assign(detail, d2);
    }
    setStatus(cfgStatus, extra || "Saved.", "success");
    loadFeatures();
  }

  saveBtn.addEventListener("click", async () => {
    const body = collectConfig(controls);
    for (const k of Object.keys(body)) {
      if (body[k] === null) delete body[k];
    }
    const r = await api(`/api/me/pages/${currentPage.id}/features/${key}`, {
      method: "PATCH",
      body: { config: body, expectedVersion: detail.version },
    });
    setStatus(cfgStatus, r.data.message || (r.res.ok ? "Draft saved." : "Save failed."), r.res.ok ? "success" : "error");
    if (r.res.ok) refresh();
  });

  pubBtn.addEventListener("click", async () => {
    const body = collectConfig(controls);
    for (const k of Object.keys(body)) {
      if (body[k] === null) delete body[k];
    }
    const saved = await api(`/api/me/pages/${currentPage.id}/features/${key}`, {
      method: "PATCH",
      body: { config: body, expectedVersion: detail.version },
    });
    if (!saved.res.ok) {
      setStatus(cfgStatus, saved.data.message || "Publish failed.", "error");
      return;
    }
    const r = await api(`/api/me/pages/${currentPage.id}/features/${key}/publish`, {
      method: "POST",
      body: { expectedVersion: saved.data.version },
    });
    setStatus(cfgStatus, r.data.message || (r.res.ok ? "Published." : "Publish failed."), r.res.ok ? "success" : "error");
    if (r.res.ok) refresh();
  });

  card.appendChild(panel);
}

// ---------- ask me anything inbox ----------
function iaTime(iso) {
  return new Date(iso).toLocaleString();
}

function askCardButton(label, act, rid, version, extra) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = label;
  btn.dataset.act = act;
  btn.dataset.rid = rid;
  if (version !== undefined) btn.dataset.version = version;
  btn.className = "ask-btn";
  if (extra) btn.className += ` ${extra}`;
  return btn;
}

function askRow(rec, kind) {
  const row = document.createElement("div");
  row.className = "ask-row";
  const head = document.createElement("div");
  head.className = "ask-row-head";
  const q = document.createElement("span");
  q.className = "ask-row-q";
  q.textContent = rec.question;
  const t = document.createElement("span");
  t.className = "ask-row-time";
  t.textContent = `asked ${iaTime(rec.submittedAt)}${rec.contact ? " · contact: " + rec.contact : ""}`;
  head.appendChild(q);
  head.appendChild(t);
  row.appendChild(head);

  if (kind === "published") {
    const a = document.createElement("p");
    a.className = "ask-row-a";
    a.textContent = rec.answer;
    row.appendChild(a);
    const ops = document.createElement("div");
    ops.className = "ask-ops";
    ops.appendChild(askCardButton("Up", "move-up", rec.id));
    ops.appendChild(askCardButton("Down", "move-down", rec.id));
    ops.appendChild(askCardButton("Unpublish", "unpublish", rec.id, rec.version));
    ops.appendChild(askCardButton("Delete", "delete", rec.id));
    row.appendChild(ops);
    return row;
  }

  const ta = document.createElement("textarea");
  ta.className = "ask-answer-input";
  ta.maxLength = 2000;
  ta.placeholder = "Write an answer draft…";
  if (kind === "draft") ta.value = rec.answer || "";
  row.appendChild(ta);
  const ops = document.createElement("div");
  ops.className = "ask-ops";
  ops.appendChild(askCardButton("Save draft", "draft", rec.id, rec.version));
  ops.appendChild(askCardButton("Answer & publish", "publish", rec.id, rec.version));
  if (kind === "pending") ops.appendChild(askCardButton("Reject", "reject", rec.id, rec.version));
  if (kind === "rejected") ops.appendChild(askCardButton("Back to drafts", "restore", rec.id, rec.version));
  ops.appendChild(askCardButton("Delete", "delete", rec.id));
  row.appendChild(ops);
  return row;
}

function renderAskManager(box) {
  askManager.textContent = "";
  askCardSub.textContent =
    `Inbox on /${currentPage.slug}. ${box.counts.pending} pending, ${box.counts.draft} drafts, ${box.counts.published} published, ${box.counts.rejected} rejected.`;
  for (const [type, label] of [["pending", "Pending"], ["draft", "Answer drafts"], ["published", "Published"], ["rejected", "Rejected"]]) {
    const items = box.statuses[type];
    const h = document.createElement("h3");
    h.className = "ask-group";
    h.textContent = `${label} (${items.length})`;
    askManager.appendChild(h);
    if (items.length === 0) {
      const none = document.createElement("p");
      none.className = "ask-none";
      none.textContent = "None.";
      askManager.appendChild(none);
      continue;
    }
    for (const rec of items) askManager.appendChild(askRow(rec, type));
  }
  const refresh = document.createElement("button");
  refresh.type = "button";
  refresh.className = "ask-btn";
  refresh.textContent = "Refresh";
  refresh.dataset.act = "refresh";
  askManager.appendChild(refresh);
}

async function loadAsk() {
  const { res, data } = await api(`/api/me/pages/${currentPage.id}/features/ask_anything/inbox`);
  if (!res.ok) {
    askCardSub.textContent = "Could not load the inbox.";
    return;
  }
  askState.box = data;
  renderAskManager(data);
}

async function postAskAction(act, btn) {
  const rid = btn.dataset.rid;
  const version = btn.dataset.version ? Number(btn.dataset.version) : undefined;
  const row = btn.closest(".ask-row");
  const answer = row ? row.querySelector(".ask-answer-input")?.value : "";
  let r;
  if (act === "draft") r = await api(`/api/me/pages/${currentPage.id}/features/ask_anything/records/${rid}/draft`, { method: "POST", body: { answer, expectedVersion: version } });
  else if (act === "publish") r = await api(`/api/me/pages/${currentPage.id}/features/ask_anything/records/${rid}/publish`, { method: "POST", body: { answer, expectedVersion: version } });
  else if (act === "unpublish") r = await api(`/api/me/pages/${currentPage.id}/features/ask_anything/records/${rid}/unpublish`, { method: "POST", body: { expectedVersion: version } });
  else if (act === "reject") r = await api(`/api/me/pages/${currentPage.id}/features/ask_anything/records/${rid}/reject`, { method: "POST", body: { expectedVersion: version } });
  else if (act === "restore") r = await api(`/api/me/pages/${currentPage.id}/features/ask_anything/records/${rid}/restore`, { method: "POST", body: { expectedVersion: version } });
  else if (act === "delete") r = await api(`/api/me/pages/${currentPage.id}/features/ask_anything/records/${rid}`, { method: "DELETE" });

  if (!r.res.ok) {
    askCardSub.textContent = r.data.message || "Action failed.";
    return;
  }
  if (act !== "move-up" && act !== "move-down") {
    askCardSub.textContent = r.data.message || "Done.";
    await loadAsk();
  }
}

function movePublished(btn, delta) {
  if (!askState.box) return;
  const pub = askState.box.statuses.published;
  const rid = btn.dataset.rid;
  const idx = pub.findIndex((r) => r.id === rid);
  const swap = idx + delta;
  if (idx === -1 || swap < 0 || swap >= pub.length) return;
  const ids = pub.map((r) => r.id);
  [ids[idx], ids[swap]] = [ids[swap], ids[idx]];
  api(`/api/me/pages/${currentPage.id}/features/ask_anything/reorder`, { method: "POST", body: { order: ids } }).then(({ res, data }) => {
    askCardSub.textContent = data.message || (res.ok ? "Order updated." : "Reorder failed.");
    if (res.ok) loadAsk();
  });
}

askManager.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const act = btn.dataset.act;
  if (act === "refresh") loadAsk();
  else if (act === "move-up") movePublished(btn, -1);
  else if (act === "move-down") movePublished(btn, 1);
  else postAskAction(act, btn);
});

// ---------- block layout manager ----------
function blockEntries() {
  const out = [];
  for (const b of blocksState.front) out.push({ id: b.id, side: "front" });
  for (const b of blocksState.back) out.push({ id: b.id, side: "back" });
  return out;
}

async function saveBlocks() {
  const { res, data } = await api(`/api/me/pages/${currentPage.id}/blocks`, {
    method: "PATCH",
    body: { blocks: blockEntries() },
  });
  if (!res.ok) {
    blocksCardSub.textContent = data.message || "Could not save the layout.";
    return;
  }
  blocksCardSub.textContent = data.message || "Layout saved.";
  await loadBlocks();
}

function renderBlocks() {
  blocksManager.textContent = "";
  const hiddenNow = blocksState.nightHidden.length ? ` Hidden now: ${blocksState.nightHidden.join(", ")}.` : "";
  const nightState =
    blocksState.night && (blocksState.night.active || blocksState.night.next)
      ? ` Night is ${blocksState.night.active ? "active" : "off"} in ${blocksState.night.timezone}; ${blocksState.night.next ? `next ${blocksState.night.next.label} ${new Date(blocksState.night.next.at).toISOString()}` : ""}.`
      : " Night only flags publish on the night_shift settings.";
  blocksCardSub.textContent =
    `Place blocks on the front or back of the card.${blocksState.flippable ? "" : " The flip is currently off; back assignments are kept."}${hiddenNow} Switching the feature off hides every Night only block; only moving a block back to Always visible brings it back outside the schedule.${nightState}`;

  for (const [type, label] of [["front", "Front"], ["back", "Back"]]) {
    const items = type === "front" ? blocksState.front : blocksState.back;
    const h = document.createElement("h3");
    h.className = "ask-group";
    h.textContent = `${label} (${items.length})`;
    blocksManager.appendChild(h);
    if (items.length === 0) {
      const none = document.createElement("p");
      none.className = "ask-none";
      none.textContent = "No blocks here.";
      blocksManager.appendChild(none);
      continue;
    }
    items.forEach((b, i) => {
      const row = document.createElement("div");
      row.className = "block-row";
      const name = document.createElement("span");
      name.className = "block-row-name";
      name.textContent = b.label;
      name.title = b.id;
      row.appendChild(name);
      const ops = document.createElement("div");
      ops.className = "ask-ops";
      const nightOnly = document.createElement("label");
      nightOnly.className = "night-only";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.dataset.act = "night";
      cb.dataset.rid = b.id;
      cb.checked = blocksState.nightOnly.includes(b.id);
      nightOnly.appendChild(cb);
      nightOnly.appendChild(document.createTextNode("Night only"));
      ops.appendChild(nightOnly);
      if (type === "back") {
        const up = askCardButton("Up", "b-up", b.id);
        const down = askCardButton("Down", "b-down", b.id);
        if (i === 0) up.disabled = true;
        if (i === items.length - 1) down.disabled = true;
        ops.appendChild(up);
        ops.appendChild(down);
        const toFront = askCardButton("Move to front", "b-front", b.id);
        ops.appendChild(toFront);
      } else {
        const toBack = askCardButton("Move to back", "b-back", b.id);
        ops.appendChild(toBack);
      }
      row.appendChild(ops);
      blocksManager.appendChild(row);
    });
  }
}

async function toggleNightOnly(id, mark) {
  const target = new Set(blocksState.nightOnly);
  if (mark) target.add(id);
  else target.delete(id);
  const { res, data } = await api(`/api/me/pages/${currentPage.id}/features/night_shift`, {
    method: "PATCH",
    body: { config: { blocks: [...target] } },
  });
  if (!res.ok) {
    blocksCardSub.textContent = (data && data.errors && (data.errors.end || data.errors._)) || (data && data.message) || "Could not change night-only flags.";
  }
  await loadBlocks();
}

async function loadBlocks() {
  const { res, data } = await api(`/api/me/pages/${currentPage.id}/blocks`);
  if (!res.ok) {
    blocksCardSub.textContent = data.message || "Could not load the card layout.";
    return;
  }
  blocksState = {
    front: data.front,
    back: data.back,
    nightHidden: data.nightHidden,
    nightOnly: data.nightOnly || [],
    night: data.night || null,
    flippable: data.flippable,
  };
  renderBlocks();
}

function blockAction(act, id) {
  const find = (arr) => arr.find((b) => b.id === id);
  if (act === "b-back") {
    const b = find(blocksState.front);
    if (!b) return;
    blocksState.front = blocksState.front.filter((x) => x.id !== id);
    blocksState.back.push(b);
  } else if (act === "b-front") {
    const b = find(blocksState.back);
    if (!b) return;
    blocksState.back = blocksState.back.filter((x) => x.id !== id);
    blocksState.front.push(b);
  } else if (act === "b-up" || act === "b-down") {
    const idx = blocksState.back.findIndex((x) => x.id === id);
    const swap = idx + (act === "b-up" ? -1 : 1);
    if (idx === -1 || swap < 0 || swap >= blocksState.back.length) return;
    const arr = [...blocksState.back];
    [arr[idx], arr[swap]] = [arr[swap], arr[idx]];
    blocksState.back = arr;
  } else {
    return;
  }
  saveBlocks();
}

blocksManager.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  blockAction(btn.dataset.act, btn.dataset.rid);
});

blocksManager.addEventListener("change", (e) => {
  const cb = e.target.closest("input[data-act='night']");
  if (!cb) return;
  toggleNightOnly(cb.dataset.rid, cb.checked);
});

// ---------- draw manager ----------
function deckList(title, deck) {
  const box = document.createElement("div");
  const h = document.createElement("h3");
  h.className = "ask-group";
  h.textContent = title;
  box.appendChild(h);
  if (!deck || !deck.cards || deck.cards.length === 0) {
    const p = document.createElement("p");
    p.className = "ask-none";
    p.textContent = deck ? "Empty deck." : "No deck yet.";
    box.appendChild(p);
    return box;
  }
  const ol = document.createElement("ol");
  ol.className = "draw-deck";
  deck.cards.forEach((line) => {
    const li = document.createElement("li");
    li.textContent = line;
    ol.appendChild(li);
  });
  box.appendChild(ol);
  return box;
}

async function loadDraw() {
  const { res, data } = await api(`/api/me/pages/${currentPage.id}/features/daily_draw`);
  if (!res.ok) {
    drawCardSub.textContent = data.message || "Could not load the draw.";
    return;
  }
  const st = data.state || {};
  const pending = st.pending;
  drawManager.textContent = "";
  drawCardSub.textContent =
    `The active deck for ${st.localDate || "today"} has ${st.active ? st.active.count : 0} card(s). ` +
    (pending ? `A new ${pending.count}-card deck is scheduled from ${pending.appliesOn} (owner-local midnight). ` : "No scheduled revision. ") +
    "Each visitor's browser picks one card for the owner-local day from a random local seed; nothing is assigned on the server.";
  drawManager.appendChild(deckList(`Active deck (${st.active ? st.active.style : "-"})`, st.active));
  if (pending) {
    drawManager.appendChild(deckList(`Scheduled from ${pending.appliesOn}`, pending));
    const cancel = askCardButton("Cancel scheduled revision", "draw-cancel", "");
    cancel.style.marginTop = "10px";
    drawManager.appendChild(cancel);
  } else {
    drawManager.appendChild(deckList("Scheduled", null));
  }
}

drawManager.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-act='draw-cancel']");
  if (!btn) return;
  api(`/api/me/pages/${currentPage.id}/features/daily_draw/cancel`, { method: "POST", body: {} })
    .then(({ res, data }) => {
      drawCardSub.textContent = res.ok ? (data.message || "Cancelled.") : (data.message || "Could not cancel.");
      if (res.ok) loadDraw();
    });
});

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