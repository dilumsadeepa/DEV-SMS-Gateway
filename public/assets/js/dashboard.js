  const STORAGE = {
    token: "psg_auth_token",
    user: "psg_auth_user",
    expiresAt: "psg_auth_expires_at",
  };

  const state = {
    token: localStorage.getItem(STORAGE.token) || "",
    user: null,
    expiresAt: localStorage.getItem(STORAGE.expiresAt) || "",
    environments: [],
    keysByEnvironment: {},
    rawKeysByEnvironment: {},
    health: null,
    devices: [],
    logs: [],
    adminSummary: null,
    adminSettings: null,
    adminUsers: [],
    adminDevices: [],
    adminLogs: [],
    autoRefresh: true,
    refreshInterval: null,
  };

  const el = {
    authPanel: document.getElementById("authPanel"),
    workspacePanel: document.getElementById("workspacePanel"),
    smsPanel: document.getElementById("smsPanel"),
    statusPanel: document.getElementById("statusPanel"),
    dashboardPanel: document.getElementById("dashboardPanel"),
    managementPanel: document.getElementById("managementPanel"),

    noticeBanner: document.getElementById("noticeBanner"),
    errorBanner: document.getElementById("errorBanner"),
    sessionBadge: document.getElementById("sessionBadge"),
    logoutBtn: document.getElementById("logoutBtn"),

    registerForm: document.getElementById("registerForm"),
    loginForm: document.getElementById("loginForm"),

    createEnvironmentForm: document.getElementById("createEnvironmentForm"),
    environmentList: document.getElementById("environmentList"),
    reloadWorkspaceBtn: document.getElementById("reloadWorkspaceBtn"),

    sendSmsForm: document.getElementById("sendSmsForm"),
    smsEnvironmentSelect: document.getElementById("smsEnvironmentSelect"),
    smsKnownKeySelect: document.getElementById("smsKnownKeySelect"),
    smsApiKeyInput: document.getElementById("smsApiKeyInput"),
    smsToInput: document.getElementById("smsToInput"),
    smsMessageInput: document.getElementById("smsMessageInput"),
    smsResult: document.getElementById("smsResult"),

    statusForm: document.getElementById("statusForm"),
    statusRequestId: document.getElementById("statusRequestId"),
    statusApiKey: document.getElementById("statusApiKey"),
    statusResult: document.getElementById("statusResult"),

    autoRefreshToggle: document.getElementById("autoRefreshToggle"),
    refreshDashboardBtn: document.getElementById("refreshDashboardBtn"),
    statConnectedDevices: document.getElementById("statConnectedDevices"),
    statPendingRequests: document.getElementById("statPendingRequests"),
    statMyDevices: document.getElementById("statMyDevices"),
    statMyLogs: document.getElementById("statMyLogs"),
    deviceSearch: document.getElementById("deviceSearch"),
    devicesBody: document.getElementById("devicesBody"),
    logSearch: document.getElementById("logSearch"),
    logsBody: document.getElementById("logsBody"),

    managementRoleBadge: document.getElementById("managementRoleBadge"),
    mgStatUsers: document.getElementById("mgStatUsers"),
    mgStatSuperAdmins: document.getElementById("mgStatSuperAdmins"),
    mgStatAdmins: document.getElementById("mgStatAdmins"),
    mgStatNormalUsers: document.getElementById("mgStatNormalUsers"),
    mgStatEnvironments: document.getElementById("mgStatEnvironments"),
    mgStatApiKeys: document.getElementById("mgStatApiKeys"),

    registrationToggleForm: document.getElementById("registrationToggleForm"),
    registrationEnabledToggle: document.getElementById("registrationEnabledToggle"),
    saveRegistrationSettingsBtn: document.getElementById("saveRegistrationSettingsBtn"),

    createManagedUserForm: document.getElementById("createManagedUserForm"),
    managedCreateRole: document.getElementById("managedCreateRole"),

    updateManagedUserForm: document.getElementById("updateManagedUserForm"),
    managedUpdateUserId: document.getElementById("managedUpdateUserId"),
    managedUpdateName: document.getElementById("managedUpdateName"),
    managedUpdateEmail: document.getElementById("managedUpdateEmail"),
    managedUpdatePassword: document.getElementById("managedUpdatePassword"),
    managedUpdateRole: document.getElementById("managedUpdateRole"),
    managedUpdateActive: document.getElementById("managedUpdateActive"),
    clearManagedUpdateBtn: document.getElementById("clearManagedUpdateBtn"),

    managedUserSearch: document.getElementById("managedUserSearch"),
    managedUserRoleFilter: document.getElementById("managedUserRoleFilter"),
    managedUserRefreshBtn: document.getElementById("managedUserRefreshBtn"),
    managedUsersBody: document.getElementById("managedUsersBody"),

    adminDeviceSearch: document.getElementById("adminDeviceSearch"),
    adminDevicesBody: document.getElementById("adminDevicesBody"),
    adminLogSearch: document.getElementById("adminLogSearch"),
    adminLogsBody: document.getElementById("adminLogsBody"),
  };

  function escapeHtml(value) {
    return String(value || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function parseJson(value, fallback) {
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  }

  function formatDate(value) {
    if (!value) {
      return "-";
    }
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) {
      return String(value);
    }
    return d.toLocaleString();
  }

  function showNotice(message) {
    el.noticeBanner.textContent = message;
    el.noticeBanner.classList.remove("hidden");
    setTimeout(() => {
      el.noticeBanner.classList.add("hidden");
    }, 3600);
  }

  function showError(message) {
    el.errorBanner.textContent = message;
    el.errorBanner.classList.remove("hidden");
  }

  function clearError() {
    el.errorBanner.classList.add("hidden");
  }

  function applyAuthHashHint() {
    const hash = String(window.location.hash || "").toLowerCase();
    if (hash === "#register") {
      const target = document.getElementById("registerName");
      if (target) {
        target.scrollIntoView({ behavior: "smooth", block: "center" });
        target.focus();
      }
      return;
    }

    if (hash === "#login") {
      const target = document.getElementById("loginEmail");
      if (target) {
        target.scrollIntoView({ behavior: "smooth", block: "center" });
        target.focus();
      }
    }
  }

  function currentUserRole() {
    return String(state.user?.role || "user");
  }

  function userIsAdmin() {
    return currentUserRole() === "admin" || currentUserRole() === "super_admin";
  }

  function userIsSuperAdmin() {
    return currentUserRole() === "super_admin";
  }

  function getRawKeyStorageKey() {
    if (!state.user || !state.user.id) {
      return "psg_raw_keys_anonymous";
    }
    return `psg_raw_keys_${state.user.id}`;
  }

  function loadRawKeysFromStorage() {
    const raw = localStorage.getItem(getRawKeyStorageKey());
    state.rawKeysByEnvironment = parseJson(raw || "{}", {});
    if (!state.rawKeysByEnvironment || typeof state.rawKeysByEnvironment !== "object") {
      state.rawKeysByEnvironment = {};
    }
  }

  function persistRawKeys() {
    localStorage.setItem(getRawKeyStorageKey(), JSON.stringify(state.rawKeysByEnvironment));
  }

  function rememberRawKey(environmentId, keyId, rawKey) {
    if (!environmentId || !keyId || !rawKey) {
      return;
    }
    if (!state.rawKeysByEnvironment[environmentId]) {
      state.rawKeysByEnvironment[environmentId] = {};
    }
    state.rawKeysByEnvironment[environmentId][keyId] = rawKey;
    persistRawKeys();
  }

  function clearSessionStorage() {
    localStorage.removeItem(STORAGE.token);
    localStorage.removeItem(STORAGE.user);
    localStorage.removeItem(STORAGE.expiresAt);
  }

  function setSession({ token, user, expiresAt }) {
    state.token = token;
    state.user = user;
    state.expiresAt = expiresAt || "";

    localStorage.setItem(STORAGE.token, token || "");
    localStorage.setItem(STORAGE.user, JSON.stringify(user || null));
    localStorage.setItem(STORAGE.expiresAt, expiresAt || "");

    loadRawKeysFromStorage();
    renderAuthState();
  }

  async function request(path, options = {}) {
    const method = options.method || "GET";
    const headers = {};
    let body;
    const useAuthToken = options.useAuthToken === undefined ? true : Boolean(options.useAuthToken);

    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(options.body);
    }

    if (options.apiKey) {
      headers["x-api-key"] = options.apiKey;
    } else if (useAuthToken) {
      const token = options.token === undefined ? state.token : options.token;
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }
    }

    const response = await fetch(path, { method, headers, body });
    const json = await response.json().catch(() => ({}));

    if (!response.ok || json.ok === false) {
      const error = new Error(json.error || `http_${response.status}`);
      error.status = response.status;
      error.payload = json;
      throw error;
    }

    return json;
  }

  function renderAuthState() {
    const loggedIn = Boolean(state.token && state.user);
    const isAdmin = userIsAdmin();
    const isSuperAdmin = userIsSuperAdmin();

    el.authPanel.classList.toggle("hidden", loggedIn);
    el.workspacePanel.classList.toggle("hidden", !loggedIn);
    el.smsPanel.classList.toggle("hidden", !loggedIn);
    el.statusPanel.classList.toggle("hidden", !loggedIn);
    el.dashboardPanel.classList.toggle("hidden", !loggedIn);
    el.managementPanel.classList.toggle("hidden", !loggedIn || !isAdmin);
    el.logoutBtn.classList.toggle("hidden", !loggedIn);

    if (!loggedIn) {
      el.sessionBadge.textContent = "Not logged in";
      el.managementRoleBadge.textContent = "USER";
      stopRefreshLoop();
      return;
    }

    const expiry = state.expiresAt ? ` | Expires ${formatDate(state.expiresAt)}` : "";
    el.sessionBadge.textContent = `${state.user.name} (${state.user.email}) | ${currentUserRole().toUpperCase()}${expiry}`;
    el.managementRoleBadge.textContent = currentUserRole().replace("_", " ").toUpperCase();

    if (isSuperAdmin) {
      el.managedCreateRole.innerHTML = `
        <option value="user">User</option>
        <option value="admin">Admin</option>
      `;
      el.managedUpdateRole.disabled = false;
    } else {
      el.managedCreateRole.innerHTML = `<option value="user">User</option>`;
      el.managedUpdateRole.value = "user";
      el.managedUpdateRole.disabled = true;
    }

    el.registrationEnabledToggle.disabled = !isSuperAdmin;
    el.saveRegistrationSettingsBtn.disabled = !isSuperAdmin;
    startRefreshLoop();
  }

  function renderEnvironmentCards() {
    if (!state.environments.length) {
      el.environmentList.innerHTML = `
        <article class="environment-card">
          <div class="muted">No environments yet. Create your first environment to generate a default API key.</div>
        </article>
      `;
      return;
    }

    el.environmentList.innerHTML = state.environments.map((environment) => {
      const keys = state.keysByEnvironment[environment.id] || [];
      const keyRows = keys.length
        ? keys.map((key) => {
          const raw = key.rawKey ? `<div class="mono">${escapeHtml(key.rawKey)}</div>` : "<span class=\"muted\">not available</span>";
          const activeText = key.isActive ? "active" : "revoked";
          const revokeButton = key.isActive
            ? `<button type="button" class="btn" data-action="revoke-key" data-environment-id="${environment.id}" data-key-id="${key.id}">Revoke</button>`
            : "";

          return `
            <tr>
              <td>${escapeHtml(key.name)}</td>
              <td class="mono">${escapeHtml(key.keyPreview || "")}</td>
              <td>${escapeHtml(activeText)}</td>
              <td>${raw}</td>
              <td>${formatDate(key.createdAt)}</td>
              <td>${revokeButton}</td>
            </tr>
          `;
        }).join("")
        : "<tr><td colspan=\"6\" class=\"muted\">No API keys loaded.</td></tr>";

      const description = environment.description ? escapeHtml(environment.description) : "No description";

      return `
        <article class="environment-card" data-environment-id="${environment.id}">
          <div class="environment-head">
            <h3>${escapeHtml(environment.name)}</h3>
            <span class="pill">PIN ${escapeHtml(environment.pin)}</span>
          </div>
          <div class="muted small">${description}</div>
          <div class="mono" style="margin-top:6px;">Env ID: ${escapeHtml(environment.id)}</div>
          <div class="inline-actions" style="margin-top:10px;">
            <button type="button" class="btn" data-action="select-environment" data-environment-id="${environment.id}">Use For SMS</button>
            <button type="button" class="btn" data-action="refresh-keys" data-environment-id="${environment.id}">Refresh Keys</button>
          </div>
          <form class="form-grid" data-action="create-key" data-environment-id="${environment.id}" style="margin-top:10px;">
            <div class="field">
              <label>New Key Name</label>
              <input type="text" name="keyName" placeholder="backend-service" />
            </div>
            <div class="field" style="justify-content:flex-end;">
              <label style="visibility:hidden;">Create</label>
              <button type="submit" class="btn btn-primary">Create Key</button>
            </div>
          </form>
          <div class="key-table-wrap">
            <table class="key-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Preview</th>
                  <th>Status</th>
                  <th>Raw Key</th>
                  <th>Created</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>${keyRows}</tbody>
            </table>
          </div>
        </article>
      `;
    }).join("");
  }

  function renderEnvironmentOptions(selectedEnvironmentId) {
    const selectedId = selectedEnvironmentId || el.smsEnvironmentSelect.value;

    if (!state.environments.length) {
      el.smsEnvironmentSelect.innerHTML = '<option value="">No environment</option>';
      renderKnownKeyOptions("");
      return;
    }

    el.smsEnvironmentSelect.innerHTML = state.environments
      .map((environment) => `<option value="${environment.id}">${escapeHtml(environment.name)} (PIN ${escapeHtml(environment.pin)})</option>`)
      .join("");

    const finalId = state.environments.some((environment) => environment.id === selectedId)
      ? selectedId
      : state.environments[0].id;

    el.smsEnvironmentSelect.value = finalId;
    renderKnownKeyOptions(finalId);
  }

  function renderKnownKeyOptions(environmentId) {
    const keys = (state.keysByEnvironment[environmentId] || []).filter((item) => item.isActive);
    const withRaw = keys.filter((item) => Boolean(item.rawKey));

    if (!withRaw.length) {
      el.smsKnownKeySelect.innerHTML = '<option value="">No saved raw key for this environment</option>';
      return;
    }

    el.smsKnownKeySelect.innerHTML = [
      '<option value="">Select known key</option>',
      ...withRaw.map((key) => `<option value="${key.id}">${escapeHtml(key.name)} (${escapeHtml(key.keyPreview || key.id)})</option>`),
    ].join("");
  }

  function renderDashboard() {
    const health = state.health || {};

    el.statConnectedDevices.textContent = Number(health.connectedDevices || 0).toString();
    el.statPendingRequests.textContent = Number(health.pendingRequests || 0).toString();
    el.statMyDevices.textContent = String(state.devices.length || 0);
    el.statMyLogs.textContent = String(state.logs.length || 0);

    const deviceQuery = el.deviceSearch.value.trim().toLowerCase();
    const devices = state.devices.filter((device) => {
      if (!deviceQuery) {
        return true;
      }
      const haystack = [device.pin, device.deviceName, device.deviceId, device.ip, device.appVersion]
        .map((item) => String(item || "").toLowerCase())
        .join(" ");
      return haystack.includes(deviceQuery);
    });

    el.devicesBody.innerHTML = devices.length
      ? devices.map((device) => `
          <tr>
            <td class="mono">${escapeHtml(device.pin)}</td>
            <td>
              <div>${escapeHtml(device.deviceName || "-")}</div>
              <div class="mono">${escapeHtml(device.deviceId || "-")}</div>
            </td>
            <td class="mono">${escapeHtml(device.ip || "-")}</td>
            <td>${device.online ? "online" : "offline"}</td>
            <td>${formatDate(device.lastSeenAt)}</td>
          </tr>
        `).join("")
      : '<tr><td colspan="5" class="muted">No devices for this account.</td></tr>';

    const logQuery = el.logSearch.value.trim().toLowerCase();
    const logs = state.logs
      .filter((log) => {
        if (!logQuery) {
          return true;
        }
        const haystack = [log.type, log.pin, log.message, log.requestId, log.error, log.deviceId]
          .map((item) => String(item || "").toLowerCase())
          .join(" ");
        return haystack.includes(logQuery);
      })
      .slice(0, 250);

    el.logsBody.innerHTML = logs.length
      ? logs.map((log) => `
          <tr>
            <td>${formatDate(log.at)}</td>
            <td>${escapeHtml(log.type || "-")}</td>
            <td class="mono">${escapeHtml(log.pin || "-")}</td>
            <td class="mono">${escapeHtml(log.message || log.error || log.requestId || "-")}</td>
          </tr>
        `).join("")
      : '<tr><td colspan="4" class="muted">No logs for this account.</td></tr>';
  }

  function clearManagedUpdateForm() {
    el.managedUpdateUserId.value = "";
    el.managedUpdateName.value = "";
    el.managedUpdateEmail.value = "";
    el.managedUpdatePassword.value = "";
    el.managedUpdateRole.value = "user";
    el.managedUpdateActive.value = "true";
  }

  function fillManagedUpdateForm(user) {
    if (!user) {
      clearManagedUpdateForm();
      return;
    }

    el.managedUpdateUserId.value = user.id;
    el.managedUpdateName.value = user.name || "";
    el.managedUpdateEmail.value = user.email || "";
    el.managedUpdatePassword.value = "";
    el.managedUpdateRole.value = user.role || "user";
    el.managedUpdateActive.value = user.isActive ? "true" : "false";
  }

  function renderManagementPanel() {
    if (!userIsAdmin()) {
      return;
    }

    const summary = state.adminSummary || {};
    const usersSummary = summary.users || {};
    const resourcesSummary = summary.resources || {};

    el.mgStatUsers.textContent = String(usersSummary.total || 0);
    el.mgStatSuperAdmins.textContent = String(usersSummary.superAdmins || 0);
    el.mgStatAdmins.textContent = String(usersSummary.admins || 0);
    el.mgStatNormalUsers.textContent = String(usersSummary.users || 0);
    el.mgStatEnvironments.textContent = String(resourcesSummary.environments || 0);
    el.mgStatApiKeys.textContent = String(resourcesSummary.apiKeys || 0);

    if (state.adminSettings && Object.prototype.hasOwnProperty.call(state.adminSettings, "registrationEnabled")) {
      el.registrationEnabledToggle.checked = Boolean(state.adminSettings.registrationEnabled);
    }

    const userSearch = String(el.managedUserSearch.value || "").trim().toLowerCase();
    const roleFilter = String(el.managedUserRoleFilter.value || "").trim();
    const users = state.adminUsers.filter((user) => {
      if (roleFilter && String(user.role || "") !== roleFilter) {
        return false;
      }

      if (!userSearch) {
        return true;
      }

      const haystack = [user.name, user.email, user.role]
        .map((item) => String(item || "").toLowerCase())
        .join(" ");
      return haystack.includes(userSearch);
    });

    el.managedUsersBody.innerHTML = users.length
      ? users.map((user) => `
          <tr>
            <td>${escapeHtml(user.name || "-")}</td>
            <td class="mono">${escapeHtml(user.email || "-")}</td>
            <td>${escapeHtml(String(user.role || "user").replace("_", " "))}</td>
            <td>${user.isActive ? "active" : "inactive"}</td>
            <td>${formatDate(user.createdAt)}</td>
            <td>
              <button
                type="button"
                class="btn"
                data-action="edit-managed-user"
                data-user-id="${escapeHtml(user.id)}"
              >
                Edit
              </button>
            </td>
          </tr>
        `).join("")
      : '<tr><td colspan="6" class="muted">No managed users found.</td></tr>';

    const deviceSearch = String(el.adminDeviceSearch.value || "").trim().toLowerCase();
    const adminDevices = state.adminDevices.filter((device) => {
      if (!deviceSearch) {
        return true;
      }

      const haystack = [device.pin, device.deviceName, device.deviceId, device.ip, device.appVersion]
        .map((item) => String(item || "").toLowerCase())
        .join(" ");
      return haystack.includes(deviceSearch);
    });

    el.adminDevicesBody.innerHTML = adminDevices.length
      ? adminDevices.map((device) => `
          <tr>
            <td class="mono">${escapeHtml(device.pin || "-")}</td>
            <td>
              <div>${escapeHtml(device.deviceName || "-")}</div>
              <div class="mono">${escapeHtml(device.deviceId || "-")}</div>
            </td>
            <td class="mono">${escapeHtml(device.ip || "-")}</td>
            <td>${device.online ? "online" : "offline"}</td>
            <td>${formatDate(device.lastSeenAt)}</td>
          </tr>
        `).join("")
      : '<tr><td colspan="5" class="muted">No global devices available.</td></tr>';

    const logSearch = String(el.adminLogSearch.value || "").trim().toLowerCase();
    const adminLogs = state.adminLogs
      .filter((log) => {
        if (!logSearch) {
          return true;
        }

        const haystack = [log.type, log.pin, log.message, log.requestId, log.error, log.deviceId]
          .map((item) => String(item || "").toLowerCase())
          .join(" ");
        return haystack.includes(logSearch);
      })
      .slice(0, 250);

    el.adminLogsBody.innerHTML = adminLogs.length
      ? adminLogs.map((log) => `
          <tr>
            <td>${formatDate(log.at)}</td>
            <td>${escapeHtml(log.type || "-")}</td>
            <td class="mono">${escapeHtml(log.pin || "-")}</td>
            <td class="mono">${escapeHtml(log.message || log.error || log.requestId || "-")}</td>
          </tr>
        `).join("")
      : '<tr><td colspan="4" class="muted">No global logs available.</td></tr>';
  }

  function mergeKeysWithRemembered(environmentId, apiKeys) {
    const remembered = state.rawKeysByEnvironment[environmentId] || {};
    return apiKeys.map((key) => ({
      ...key,
      rawKey: remembered[key.id] || null,
    }));
  }

  async function loadEnvironments() {
    const result = await request("/api/environments");
    state.environments = Array.isArray(result.environments) ? result.environments : [];

    const loadKeyTasks = state.environments.map(async (environment) => {
      try {
        const keyResult = await request(`/api/environments/${encodeURIComponent(environment.id)}/api-keys`);
        state.keysByEnvironment[environment.id] = mergeKeysWithRemembered(environment.id, keyResult.apiKeys || []);
      } catch {
        state.keysByEnvironment[environment.id] = state.keysByEnvironment[environment.id] || [];
      }
    });

    await Promise.all(loadKeyTasks);

    renderEnvironmentCards();
    renderEnvironmentOptions();
  }

  async function refreshDashboard() {
    const [healthResult, devicesResult, logsResult] = await Promise.all([
      request("/health", { token: "" }),
      request("/api/account/devices"),
      request("/api/account/logs"),
    ]);

    state.health = healthResult;
    state.devices = Array.isArray(devicesResult.devices) ? devicesResult.devices : [];
    state.logs = Array.isArray(logsResult.logs) ? logsResult.logs : [];
    state.logs.sort((a, b) => {
      const left = new Date(b.at || 0).getTime();
      const right = new Date(a.at || 0).getTime();
      return left - right;
    });

    renderDashboard();
  }

  async function refreshManagementWorkspace() {
    if (!userIsAdmin()) {
      state.adminSummary = null;
      state.adminSettings = null;
      state.adminUsers = [];
      state.adminDevices = [];
      state.adminLogs = [];
      return;
    }

    const [summaryResult, settingsResult, usersResult, devicesResult, logsResult] = await Promise.all([
      request("/api/admin/summary"),
      request("/api/admin/settings"),
      request("/api/admin/users"),
      request("/api/admin/devices"),
      request("/api/admin/logs"),
    ]);

    state.adminSummary = summaryResult.summary || null;
    state.adminSettings = settingsResult.settings || null;
    state.adminUsers = Array.isArray(usersResult.users) ? usersResult.users : [];
    state.adminDevices = Array.isArray(devicesResult.devices) ? devicesResult.devices : [];
    state.adminLogs = Array.isArray(logsResult.logs) ? logsResult.logs : [];
    state.adminLogs.sort((a, b) => {
      const left = new Date(b.at || 0).getTime();
      const right = new Date(a.at || 0).getTime();
      return left - right;
    });

    renderManagementPanel();
  }

  async function loadWorkspace() {
    await Promise.all([
      loadEnvironments(),
      refreshDashboard(),
      refreshManagementWorkspace(),
    ]);
  }

  function stopRefreshLoop() {
    if (state.refreshInterval) {
      clearInterval(state.refreshInterval);
      state.refreshInterval = null;
    }
  }

  function startRefreshLoop() {
    stopRefreshLoop();
    state.refreshInterval = setInterval(async () => {
      if (!state.autoRefresh || !state.token) {
        return;
      }
      if (document.hidden) {
        return;
      }
      try {
        await Promise.all([
          refreshDashboard(),
          refreshManagementWorkspace(),
        ]);
      } catch {
        // no-op
      }
    }, 5000);
  }

  async function bootstrapSession() {
    const storedUser = parseJson(localStorage.getItem(STORAGE.user) || "null", null);
    if (storedUser && state.token) {
      state.user = storedUser;
      loadRawKeysFromStorage();
      renderAuthState();

      try {
        const me = await request("/api/auth/me");
        state.user = me.user;
        localStorage.setItem(STORAGE.user, JSON.stringify(me.user));
      } catch {
        clearSessionStorage();
        state.token = "";
        state.user = null;
        renderAuthState();
      }
    } else {
      renderAuthState();
    }
  }

  async function logout() {
    try {
      if (state.token) {
        await request("/api/auth/logout", { method: "POST" });
      }
    } catch {
      // no-op
    }

    state.token = "";
    state.user = null;
    state.expiresAt = "";
    state.environments = [];
    state.keysByEnvironment = {};
    state.devices = [];
    state.logs = [];
    state.health = null;
    state.adminSummary = null;
    state.adminSettings = null;
    state.adminUsers = [];
    state.adminDevices = [];
    state.adminLogs = [];
    clearSessionStorage();
    renderAuthState();
    renderEnvironmentCards();
    renderEnvironmentOptions();
    renderDashboard();
    clearManagedUpdateForm();
    renderManagementPanel();
    showNotice("Logged out.");
  }

  el.registerForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearError();

    const form = new FormData(el.registerForm);
    const payload = {
      name: String(form.get("name") || "").trim(),
      email: String(form.get("email") || "").trim(),
      password: String(form.get("password") || ""),
    };

    try {
      await request("/api/auth/register", { method: "POST", body: payload, useAuthToken: false });
      showNotice("Registration complete. Please login now.");
      el.loginForm.email.value = payload.email;
      el.loginForm.password.focus();
      el.registerForm.reset();
    } catch (error) {
      showError(`Register failed: ${error.message}`);
    }
  });

  el.loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearError();

    const form = new FormData(el.loginForm);
    const payload = {
      email: String(form.get("email") || "").trim(),
      password: String(form.get("password") || ""),
    };

    try {
      const result = await request("/api/auth/login", { method: "POST", body: payload, useAuthToken: false });
      setSession({
        token: result.token,
        user: result.user,
        expiresAt: result.expiresAt,
      });
      await loadWorkspace();
      el.loginForm.reset();
      showNotice("Login successful.");
    } catch (error) {
      showError(`Login failed: ${error.message}`);
    }
  });

  el.logoutBtn.addEventListener("click", () => {
    clearError();
    logout();
  });

  el.createEnvironmentForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearError();

    const form = new FormData(el.createEnvironmentForm);
    const metadataInput = String(form.get("metadata") || "").trim();
    let metadata = undefined;

    if (metadataInput) {
      const parsed = parseJson(metadataInput, null);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        showError("Metadata must be a valid JSON object.");
        return;
      }
      metadata = parsed;
    }

    const payload = {
      name: String(form.get("name") || "").trim(),
      pin: String(form.get("pin") || "").trim(),
      description: String(form.get("description") || "").trim(),
    };

    if (metadata) {
      payload.metadata = metadata;
    }

    try {
      const result = await request("/api/environments", { method: "POST", body: payload });
      const environment = result.environment;
      const info = result.apiKeyInfo;
      const raw = result.apiKey;

      state.environments.push(environment);
      state.environments.sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));

      if (!state.keysByEnvironment[environment.id]) {
        state.keysByEnvironment[environment.id] = [];
      }

      const keyInfo = {
        ...info,
        rawKey: raw,
      };
      state.keysByEnvironment[environment.id].unshift(keyInfo);
      rememberRawKey(environment.id, info.id, raw);

      renderEnvironmentCards();
      renderEnvironmentOptions(environment.id);

      el.smsApiKeyInput.value = raw;
      showNotice(`Environment created. Default key generated for ${environment.name}.`);
      el.createEnvironmentForm.reset();
      await refreshManagementWorkspace();
    } catch (error) {
      showError(`Create environment failed: ${error.message}`);
    }
  });

  el.reloadWorkspaceBtn.addEventListener("click", async () => {
    clearError();
    try {
      await loadWorkspace();
      showNotice("Workspace reloaded.");
    } catch (error) {
      showError(`Reload failed: ${error.message}`);
    }
  });

  el.environmentList.addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) {
      return;
    }

    clearError();
    const action = button.getAttribute("data-action");
    const environmentId = button.getAttribute("data-environment-id");

    if (!environmentId) {
      return;
    }

    if (action === "select-environment") {
      renderEnvironmentOptions(environmentId);
      showNotice("Environment selected for SMS form.");
      return;
    }

    if (action === "refresh-keys") {
      try {
        const result = await request(`/api/environments/${encodeURIComponent(environmentId)}/api-keys`);
        state.keysByEnvironment[environmentId] = mergeKeysWithRemembered(environmentId, result.apiKeys || []);
        renderEnvironmentCards();
        renderKnownKeyOptions(el.smsEnvironmentSelect.value);
        showNotice("Environment keys refreshed.");
      } catch (error) {
        showError(`Load keys failed: ${error.message}`);
      }
      return;
    }

    if (action === "revoke-key") {
      const keyId = button.getAttribute("data-key-id");
      if (!keyId) {
        return;
      }

      try {
        await request(`/api/environments/${encodeURIComponent(environmentId)}/api-keys/${encodeURIComponent(keyId)}`, {
          method: "DELETE",
        });

        const keys = state.keysByEnvironment[environmentId] || [];
        state.keysByEnvironment[environmentId] = keys.map((key) => {
          if (key.id !== keyId) {
            return key;
          }
          return {
            ...key,
            isActive: false,
            revokedAt: new Date().toISOString(),
          };
        });

        renderEnvironmentCards();
        renderKnownKeyOptions(el.smsEnvironmentSelect.value);
        showNotice("API key revoked.");
      } catch (error) {
        showError(`Revoke failed: ${error.message}`);
      }
    }
  });

  el.environmentList.addEventListener("submit", async (event) => {
    const form = event.target.closest("form[data-action='create-key']");
    if (!form) {
      return;
    }

    event.preventDefault();
    clearError();

    const environmentId = form.getAttribute("data-environment-id");
    const keyNameInput = form.querySelector("input[name='keyName']");
    const name = String(keyNameInput ? keyNameInput.value : "").trim() || "default";

    try {
      const result = await request(`/api/environments/${encodeURIComponent(environmentId)}/api-keys`, {
        method: "POST",
        body: { name },
      });

      const info = {
        ...result.apiKeyInfo,
        rawKey: result.apiKey,
      };

      const keys = state.keysByEnvironment[environmentId] || [];
      state.keysByEnvironment[environmentId] = [info, ...keys];
      rememberRawKey(environmentId, info.id, result.apiKey);

      renderEnvironmentCards();
      renderKnownKeyOptions(el.smsEnvironmentSelect.value);
      el.smsApiKeyInput.value = result.apiKey;
      showNotice("New environment key created.");
    } catch (error) {
      showError(`Create key failed: ${error.message}`);
    }
  });

  el.smsEnvironmentSelect.addEventListener("change", () => {
    renderKnownKeyOptions(el.smsEnvironmentSelect.value);
  });

  el.smsKnownKeySelect.addEventListener("change", () => {
    const selectedKeyId = el.smsKnownKeySelect.value;
    if (!selectedKeyId) {
      return;
    }

    const environmentId = el.smsEnvironmentSelect.value;
    const key = (state.keysByEnvironment[environmentId] || []).find((item) => item.id === selectedKeyId);
    if (key && key.rawKey) {
      el.smsApiKeyInput.value = key.rawKey;
    }
  });

  el.sendSmsForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearError();

    const apiKey = String(el.smsApiKeyInput.value || "").trim();
    const to = String(el.smsToInput.value || "").trim();
    const message = String(el.smsMessageInput.value || "").trim();

    if (!apiKey) {
      showError("API key is required to send SMS.");
      return;
    }

    try {
      const result = await request("/api/send-sms", {
        method: "POST",
        apiKey,
        body: {
          to,
          message,
        },
      });

      el.smsResult.textContent = JSON.stringify(result, null, 2);
      el.smsResult.classList.remove("hidden");

      if (result.requestId) {
        el.statusRequestId.value = result.requestId;
      }

      showNotice("SMS request sent.");
      await Promise.all([
        refreshDashboard(),
        refreshManagementWorkspace(),
      ]);
    } catch (error) {
      const payload = error && error.payload ? error.payload : { error: error.message };
      el.smsResult.textContent = JSON.stringify(payload, null, 2);
      el.smsResult.classList.remove("hidden");
      showError(`Send SMS failed: ${error.message}`);
    }
  });

  el.statusForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearError();

    const requestId = String(el.statusRequestId.value || "").trim();
    const apiKey = String(el.statusApiKey.value || "").trim();

    if (!requestId) {
      showError("Request ID is required.");
      return;
    }

    try {
      const result = await request(`/api/status/${encodeURIComponent(requestId)}`, {
        apiKey: apiKey || undefined,
      });
      el.statusResult.textContent = JSON.stringify(result, null, 2);
      el.statusResult.classList.remove("hidden");
    } catch (error) {
      const payload = error && error.payload ? error.payload : { error: error.message };
      el.statusResult.textContent = JSON.stringify(payload, null, 2);
      el.statusResult.classList.remove("hidden");
      showError(`Status lookup failed: ${error.message}`);
    }
  });

  el.refreshDashboardBtn.addEventListener("click", async () => {
    clearError();
    try {
      await Promise.all([
        refreshDashboard(),
        refreshManagementWorkspace(),
      ]);
      showNotice("Dashboard refreshed.");
    } catch (error) {
      showError(`Refresh failed: ${error.message}`);
    }
  });

  el.autoRefreshToggle.addEventListener("change", () => {
    state.autoRefresh = Boolean(el.autoRefreshToggle.checked);
  });

  el.deviceSearch.addEventListener("input", () => {
    renderDashboard();
  });

  el.logSearch.addEventListener("input", () => {
    renderDashboard();
  });

  el.registrationToggleForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearError();

    if (!userIsSuperAdmin()) {
      showError("Only super admin can change registration settings.");
      return;
    }

    try {
      const result = await request("/api/admin/settings/registration", {
        method: "PATCH",
        body: {
          enabled: Boolean(el.registrationEnabledToggle.checked),
        },
      });
      state.adminSettings = result.settings || state.adminSettings;
      renderManagementPanel();
      showNotice("Registration setting updated.");
    } catch (error) {
      showError(`Update registration setting failed: ${error.message}`);
    }
  });

  el.createManagedUserForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearError();

    if (!userIsAdmin()) {
      showError("Only admin or super admin can create users.");
      return;
    }

    const form = new FormData(el.createManagedUserForm);
    const payload = {
      name: String(form.get("name") || "").trim(),
      email: String(form.get("email") || "").trim(),
      password: String(form.get("password") || ""),
      role: String(form.get("role") || "user"),
      isActive: String(form.get("isActive") || "true") === "true",
    };

    try {
      await request("/api/admin/users", {
        method: "POST",
        body: payload,
      });
      el.createManagedUserForm.reset();
      if (!userIsSuperAdmin()) {
        el.managedCreateRole.value = "user";
      }
      showNotice("Managed user created.");
      await refreshManagementWorkspace();
    } catch (error) {
      showError(`Create managed user failed: ${error.message}`);
    }
  });

  el.updateManagedUserForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearError();

    const userId = String(el.managedUpdateUserId.value || "").trim();
    if (!userId) {
      showError("Select a user from the table before updating.");
      return;
    }

    const payload = {
      name: String(el.managedUpdateName.value || "").trim(),
      email: String(el.managedUpdateEmail.value || "").trim(),
      isActive: String(el.managedUpdateActive.value || "true") === "true",
    };

    const password = String(el.managedUpdatePassword.value || "").trim();
    if (password) {
      payload.password = password;
    }

    if (userIsSuperAdmin()) {
      payload.role = String(el.managedUpdateRole.value || "user");
    }

    try {
      const result = await request(`/api/admin/users/${encodeURIComponent(userId)}`, {
        method: "PATCH",
        body: payload,
      });
      showNotice("Managed user updated.");
      await refreshManagementWorkspace();
      fillManagedUpdateForm(result.user || null);
    } catch (error) {
      showError(`Update managed user failed: ${error.message}`);
    }
  });

  el.clearManagedUpdateBtn.addEventListener("click", () => {
    clearManagedUpdateForm();
  });

  el.managedUsersBody.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-action='edit-managed-user']");
    if (!button) {
      return;
    }

    const userId = String(button.getAttribute("data-user-id") || "").trim();
    const user = state.adminUsers.find((item) => String(item.id || "") === userId) || null;
    fillManagedUpdateForm(user);
  });

  el.managedUserRefreshBtn.addEventListener("click", async () => {
    clearError();
    try {
      await refreshManagementWorkspace();
      showNotice("Management data refreshed.");
    } catch (error) {
      showError(`Management refresh failed: ${error.message}`);
    }
  });

  el.managedUserSearch.addEventListener("input", () => {
    renderManagementPanel();
  });

  el.managedUserRoleFilter.addEventListener("change", () => {
    renderManagementPanel();
  });

  el.adminDeviceSearch.addEventListener("input", () => {
    renderManagementPanel();
  });

  el.adminLogSearch.addEventListener("input", () => {
    renderManagementPanel();
  });

  (async () => {
    try {
      await bootstrapSession();
      if (state.token && state.user) {
        await loadWorkspace();
      } else {
        renderEnvironmentCards();
        renderEnvironmentOptions();
        renderDashboard();
        clearManagedUpdateForm();
        renderManagementPanel();
        applyAuthHashHint();
      }
    } catch (error) {
      showError(`Startup failed: ${error.message}`);
    }
  })();
