const loginButton = document.getElementById("login-button");
const loginStatus = document.getElementById("login-status");
const demoUser = document.getElementById("demo-user");
const tabs = document.querySelectorAll(".admin-tabs button");

let token = localStorage.getItem("misa.admin.token") || null;
let user = null;

const TIER_LABEL = { free: "Free", lifetime: "Lifetime", "free + lifetime": "Free + Lifetime" };
const REASON_LABEL = {
  enabled: "Enabled",
  owner_off: "Owner off",
  global_off: "Global off",
  plan_locked: "Plan locked",
  rollout_excluded: "Rollout excluded",
  configuration_incomplete: "Configuration incomplete",
  suspended: "Suspended",
  restricted: "Restricted",
  unknown: "Unknown",
};
const ROLE_LABEL = {
  platform_admin: "Platform admin",
  moderator: "Moderator / support",
  owner: "Profile owner",
  visitor: "Visitor",
};

function esc(s) {
  const div = document.createElement("div");
  div.textContent = s == null ? "" : String(s);
  return div.innerHTML;
}

function setLoginStatus(text, tone) {
  loginStatus.textContent = text;
  loginStatus.dataset.tone = tone || "";
}

async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(path, {
    ...opts,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

function show(view) {
  tabs.forEach((t) => t.classList.toggle("active", t.dataset.view === view));
  document.querySelectorAll(".admin-view").forEach((v) => (v.hidden = true));
  document.getElementById(`view-${view}`).hidden = false;
  if (view === "features") loadFeatures();
  if (view === "users") loadUsers();
  if (view === "audit") loadAudit();
}

tabs.forEach((t) => t.addEventListener("click", () => show(t.dataset.view)));

// ---------- features ----------
async function loadFeatures() {
  const { res, data } = await api("/api/admin/features");
  if (!res.ok) return report403(res, data);
  const el = document.getElementById("view-features");
  el.innerHTML = `
    <h1>Features</h1>
    <p class="sub">Policy version ${data.policyVersion}. Global off always wins; feature disable keeps saved data.</p>
    <div class="table-wrap"><table class="admin-table">
      <thead><tr>
        <th>Name</th><th>Tier</th><th>Global</th><th>Allowed plans</th><th>Rollout</th><th>Enabled profiles</th><th>Health</th><th>Last change</th>
      </tr></thead>
      <tbody>
        ${data.rows
          .map(
            (r) => `<tr class="${r.parentKey ? "child-row" : ""}" data-key="${esc(r.key)}">
          <td class="cell-name">${esc(r.name)}${r.parentKey ? ` <span class="muted">(${esc(r.parentKey)})</span>` : ""}</td>
          <td>${TIER_LABEL[r.tier] || r.tier}</td>
          <td>${r.globalEnabled ? '<span class="pill ok">On</span>' : '<span class="pill off">Off</span>'}</td>
          <td>${r.allowedPlans.join(", ")}</td>
          <td>${r.rolloutPercent}%</td>
          <td>${r.enabledProfileCount}</td>
          <td><span class="pill ok">${r.health}</span></td>
          <td>${r.lastChange ? `${esc(r.lastChange.action)} by ${esc(r.lastChange.actor)}` : "—"}</td>
        </tr>`
          )
          .join("")}
      </tbody>
    </table></div>`;
  el.querySelectorAll("tbody tr[data-key]").forEach((tr) =>
    tr.addEventListener("click", () => loadFeatureDetail(tr.dataset.key))
  );
}

async function loadFeatureDetail(key) {
  const { res, data } = await api(`/api/admin/features/${key}`);
  if (!res.ok) return report403(res, data);
  const el = document.getElementById("detail-above");
  el.hidden = false;
  const p = data.policy;
  const plans = ["free", "lifetime"];
  el.innerHTML = `
    <h1>${esc(data.name)} <span class="muted">(${esc(data.key)})</span></h1>
    <p class="sub">${esc(data.description)}</p>

    <div class="detail-grid">
      <section class="card">
        <h2 class="h2">Availability</h2>
        <div class="field"><label>Global switch</label>
          <button id="d-global" class="switch ${p.globalEnabled ? "on" : ""}">${p.globalEnabled ? "On" : "Off"}</button></div>
        <div class="field"><label>Allowed plans</label>
          <div class="plan-row">${plans.map((pl) => `<label class="check"><input type="checkbox" id="plan-${pl}" ${p.allowedPlans.includes(pl) ? "checked" : ""}/> ${pl}</label>`).join("")}</div></div>
        <div class="field"><label>Rollout % <output id="rollout-out">${p.rolloutPercent}</output></label>
          <input id="d-rollout" type="range" min="0" max="100" step="5" value="${p.rolloutPercent}" /></div>
        <div class="field"><label>Default for new profiles</label>
          <button id="d-default" class="switch ${p.defaultEnabled ? "on" : ""}">${p.defaultEnabled ? "On" : "Off"}</button></div>
        <div class="actions"><button id="save-policy" class="primary" type="button">Save policy</button>
          <span id="policy-status" class="status" role="status"></span></div>
      </section>

      <section class="card">
        <h2 class="h2">Activity</h2>
        <dl class="metrics">
          <div><dt>Configured profiles</dt><dd>${data.activity.configuredProfiles}</dd></div>
          <div><dt>Enabled profiles</dt><dd>${data.activity.enabledProfiles}</dd></div>
          <div><dt>Pending submissions</dt><dd>${data.activity.pendingSubmissions}</dd></div>
          <div><dt>Aggregate errors</dt><dd>${data.activity.aggregateErrors}</dd></div>
        </dl>
        <h2 class="h2">Recent changes</h2>
        <ul class="audit-mini">
          ${data.recentChanges.length ? data.recentChanges.map((a) => `<li><strong>${esc(a.action)}</strong> by ${esc(a.actor)} — ${esc(a.time)}<br><span class="muted">${esc(a.reason)}</span></li>`).join("") : "<li>No changes yet.</li>"}
        </ul>
      </section>
    </div>

    <div class="actions"><button class="linklike" id="d-back">← Back to features</button></div>`;

  document.getElementById("d-back").addEventListener("click", () => {
    document.getElementById("detail-above").hidden = true;
    document.getElementById("view-features").hidden = false;
    loadFeatures();
  });

  const toBool = (b) => (b ? "On" : "Off");
  const globalBtn = document.getElementById("d-global");
  globalBtn.addEventListener("click", () => {
    const next = globalBtn.classList.toggle("on");
    globalBtn.textContent = toBool(next);
  });
  document.getElementById("d-rollout").addEventListener("input", (e) => {
    document.getElementById("rollout-out").textContent = e.target.value;
  });
  const defaultBtn = document.getElementById("d-default");
  defaultBtn.addEventListener("click", () => {
    const next = defaultBtn.classList.toggle("on");
    defaultBtn.textContent = toBool(next);
  });

  document.getElementById("save-policy").addEventListener("click", async () => {
    const body = {
      globalEnabled: globalBtn.classList.contains("on"),
      allowedPlans: plans.filter((pl) => document.getElementById(`plan-${pl}`).checked),
      rolloutPercent: Number(document.getElementById("d-rollout").value),
      defaultEnabled: defaultBtn.classList.contains("on"),
      reason: "Admin updated feature policy.",
    };
    const { res, data: result } = await api(`/api/admin/features/${key}`, { method: "PATCH", body });
    const st = document.getElementById("policy-status");
    if (!res.ok) {
      st.textContent = result.message || "Failed to save policy.";
      st.dataset.tone = "error";
      return;
    }
    st.textContent = "Policy saved. Global off applies immediately; saved content is retained.";
    st.dataset.tone = "success";
    document.getElementById("detail-above").hidden = true;
    loadFeatures();
  });
}

// ---------- users ----------
async function loadUsers() {
  const { res, data } = await api("/api/admin/users");
  if (!res.ok) return report403(res, data);
  const el = document.getElementById("view-users");
  el.innerHTML = `
    <h1>Users</h1>
    <p class="sub">Requested vs effective feature state per owned page. Support can apply a restriction or grant with a reason and expiry.</p>
    <div class="table-wrap"><table class="admin-table">
      <thead><tr><th>User</th><th>Role</th><th>Plan</th><th>Pages</th><th>Suspended</th></tr></thead>
      <tbody>
        ${data.users
          .map(
            (u) => `<tr data-id="${esc(u.id)}"><td class="cell-name">${esc(u.handle)}</td><td>${ROLE_LABEL[u.role] || u.role}</td><td>${u.plan}</td><td>${u.pageCount}</td><td>${u.suspended ? "Yes" : "No"}</td></tr>`
          )
          .join("")}
      </tbody>
    </table></div>`;
  el.querySelectorAll("tbody tr[data-id]").forEach((tr) => tr.addEventListener("click", () => loadUserDetail(tr.dataset.id)));
}

async function loadUserDetail(userId) {
  const { res, data } = await api(`/api/admin/users/${userId}`);
  if (!res.ok) return report403(res, data);
  const el = document.getElementById("detail-above");
  el.hidden = false;
  el.innerHTML = `
    <h1>${esc(data.user.handle)} <span class="muted">(${ROLE_LABEL[data.user.role]})</span></h1>
    <p class="sub">Plan: ${data.user.plan} · Suspended: ${data.suspended ? "Yes" : "No"}</p>
    ${data.pages
      .map(
        (page) => `
      <section class="card">
        <h2 class="h2">Page /${esc(page.slug)}</h2>
        <div class="table-wrap"><table class="admin-table">
          <thead><tr><th>Feature</th><th>Requested</th><th>Effective</th><th>Reason</th></tr></thead>
          <tbody>
            ${page.features.map((f) => `<tr class="${f.parentKey ? "child-row" : ""}"><td class="cell-name">${esc(f.name)}${f.parentKey ? ` <span class="muted">(${esc(f.parentKey)})</span>` : ""}</td><td>${f.requestedEnabled ? "On" : "Off"}</td><td>${f.effectiveEnabled ? '<span class="pill ok">On</span>' : '<span class="pill off">Off</span>'}</td><td>${REASON_LABEL[f.reasonCode] || f.reasonCode}</td></tr>`).join("")}
          </tbody>
        </table></div>
      </section>`
      )
      .join("")}
    <section class="card">
      <h2 class="h2">Apply override</h2>
      <div class="form-row">
        <div class="field"><label>Feature</label><select id="ov-feature">${data.pages.flatMap((p) => p.features).map((f) => `<option value="${esc(f.key)}">${esc(f.name)}</option>`).join("")}</select></div>
        <div class="field"><label>Type</label><select id="ov-kind"><option value="grant">Entitlement grant</option><option value="restrict">Restriction</option></select></div>
        <div class="field"><label>Expiry (ISO, optional)</label><input id="ov-expiry" type="text" placeholder="2026-12-31T23:59:59.000Z" /></div>
      </div>
      <div class="field"><label>Reason (required)</label><input id="ov-reason" type="text" /></div>
      <div class="actions"><button id="ov-save" class="primary" type="button">Apply</button><span id="ov-status" class="status"></span></div>
    </section>
    <div class="actions"><button class="linklike" id="d-back">← Back to users</button></div>`;

  document.getElementById("d-back").addEventListener("click", () => {
    document.getElementById("detail-above").hidden = true;
    document.getElementById("view-users").hidden = false;
    loadUsers();
  });
  document.getElementById("ov-save").addEventListener("click", async () => {
    const body = {
      kind: document.getElementById("ov-kind").value,
      expiry: document.getElementById("ov-expiry").value || null,
      reason: document.getElementById("ov-reason").value,
    };
    const feature = document.getElementById("ov-feature").value;
    const { res, data: result } = await api(`/api/admin/users/${userId}/features/${feature}/override`, { method: "PATCH", body });
    const st = document.getElementById("ov-status");
    if (!res.ok) {
      st.textContent = result.message || "Failed to apply override.";
      st.dataset.tone = "error";
      return;
    }
    st.textContent = result.message;
    st.dataset.tone = "success";
  });
}

// ---------- audit ----------
async function loadAudit() {
  const { res, data } = await api("/api/admin/audit");
  if (!res.ok) return report403(res, data);
  const el = document.getElementById("view-audit");
  el.innerHTML = `
    <h1>Audit log</h1>
    <p class="sub">Append-only policy and moderation changes with redacted private bodies.</p>
    <div class="table-wrap"><table class="admin-table">
      <thead><tr><th>Time</th><th>Actor</th><th>Scope</th><th>Feature</th><th>Action</th><th>Reason</th></tr></thead>
      <tbody>
        ${data.audit.map((a) => `<tr><td>${esc(a.time)}</td><td>${esc(a.actor)}</td><td>${esc(a.scope)}</td><td>${esc(a.feature || "—")}</td><td>${esc(a.action)}</td><td>${esc(a.reason)}</td></tr>`).join("")}
      </tbody>
    </table></div>`;
}

function report403(res, data) {
  const message = res.status === 401 ? "Log in as a platform admin first." : data.message || "Forbidden.";
  setLoginStatus(message, "error");
}

// ---------- auth ----------
async function afterLogin() {
  const { res, data } = await api("/api/me");
  if (!res.ok) {
    setLoginStatus("Session expired. Log in again.", "error");
    localStorage.removeItem("misa.admin.token");
    token = null;
    return;
  }
  user = data.user;
  setLoginStatus(`Logged in as ${user.handle} (${ROLE_LABEL[user.role]}).`, "success");
  show(user.role === "platform_admin" ? "features" : "audit");
}

async function login() {
  const { res, data } = await api("/api/auth/login", { method: "POST", body: { handle: demoUser.value } });
  if (!res.ok) {
    setLoginStatus(data.message || "Login failed.", "error");
    return;
  }
  token = data.token;
  user = data.user;
  localStorage.setItem("misa.admin.token", token);
  await afterLogin();
}

loginButton.addEventListener("click", login);

(async () => {
  if (token) await afterLogin();
  else setLoginStatus("Log in to view the admin panel.", "pending");
})();