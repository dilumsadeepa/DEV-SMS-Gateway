(() => {
  const {
    request,
    ensureUser,
    mountSidebar,
    showNotice,
    showError,
    clearError,
    escapeHtml,
    formatDate,
    isSuperAdminRole,
  } = window.PsgApp;

  const state = {
    user: null,
    summary: null,
    settings: null,
    users: [],
    devices: [],
    logs: [],
  };

  const el = {
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
    logRetentionForm: document.getElementById("logRetentionForm"),
    logRetentionDaysInput: document.getElementById("logRetentionDaysInput"),
    saveLogRetentionBtn: document.getElementById("saveLogRetentionBtn"),
    clearLogsBtn: document.getElementById("clearLogsBtn"),

    managedUserRefreshBtn: document.getElementById("managedUserRefreshBtn"),

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
    managedUsersBody: document.getElementById("managedUsersBody"),

    adminDeviceSearch: document.getElementById("adminDeviceSearch"),
    adminDevicesBody: document.getElementById("adminDevicesBody"),

    adminLogSearch: document.getElementById("adminLogSearch"),
    adminLogsBody: document.getElementById("adminLogsBody"),
  };

  function currentRole() {
    return String(state.user?.role || "user");
  }

  function userIsSuperAdmin() {
    return isSuperAdminRole(currentRole());
  }

  function renderRoleControls() {
    const role = currentRole();

    el.managementRoleBadge.textContent = role.replace("_", " ").toUpperCase();

    if (userIsSuperAdmin()) {
      el.managedCreateRole.innerHTML = `
        <option value="user">User</option>
        <option value="admin">Admin</option>
      `;
      el.managedUpdateRole.disabled = false;
      el.registrationEnabledToggle.disabled = false;
      el.saveRegistrationSettingsBtn.disabled = false;
      el.logRetentionDaysInput.disabled = false;
      el.saveLogRetentionBtn.disabled = false;
      el.clearLogsBtn.disabled = false;
    } else {
      el.managedCreateRole.innerHTML = '<option value="user">User</option>';
      el.managedUpdateRole.value = "user";
      el.managedUpdateRole.disabled = true;
      el.registrationEnabledToggle.disabled = true;
      el.saveRegistrationSettingsBtn.disabled = true;
      el.logRetentionDaysInput.disabled = true;
      el.saveLogRetentionBtn.disabled = true;
      el.clearLogsBtn.disabled = true;
    }
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

  function renderSummary() {
    const users = state.summary?.users || {};
    const resources = state.summary?.resources || {};

    el.mgStatUsers.textContent = String(users.total || 0);
    el.mgStatSuperAdmins.textContent = String(users.superAdmins || 0);
    el.mgStatAdmins.textContent = String(users.admins || 0);
    el.mgStatNormalUsers.textContent = String(users.users || 0);
    el.mgStatEnvironments.textContent = String(resources.environments || 0);
    el.mgStatApiKeys.textContent = String(resources.apiKeys || 0);

    if (state.settings && Object.prototype.hasOwnProperty.call(state.settings, "registrationEnabled")) {
      el.registrationEnabledToggle.checked = Boolean(state.settings.registrationEnabled);
    }

    if (state.settings && Object.prototype.hasOwnProperty.call(state.settings, "logRetentionDays")) {
      const value = Number(state.settings.logRetentionDays);
      if (Number.isInteger(value)) {
        el.logRetentionDaysInput.value = String(value);
      }
    }
  }

  function renderUsers() {
    const search = String(el.managedUserSearch.value || "").trim().toLowerCase();
    const roleFilter = String(el.managedUserRoleFilter.value || "").trim();

    const users = state.users.filter((user) => {
      if (roleFilter && String(user.role || "") !== roleFilter) {
        return false;
      }

      if (!search) {
        return true;
      }

      const haystack = [user.name, user.email, user.role]
        .map((value) => String(value || "").toLowerCase())
        .join(" ");

      return haystack.includes(search);
    });

    el.managedUsersBody.innerHTML = users.length
      ? users
          .map((user) => `
            <tr>
              <td>${escapeHtml(user.name || "-")}</td>
              <td class="mono">${escapeHtml(user.email || "-")}</td>
              <td>${escapeHtml(String(user.role || "user").replace("_", " "))}</td>
              <td>${user.isActive ? "active" : "inactive"}</td>
              <td>${formatDate(user.createdAt)}</td>
              <td>
                <button type="button" class="btn" data-action="edit-managed-user" data-user-id="${escapeHtml(user.id)}">Edit</button>
              </td>
            </tr>
          `)
          .join("")
      : '<tr><td colspan="6" class="muted">No users found.</td></tr>';
  }

  function renderDevices() {
    const search = String(el.adminDeviceSearch.value || "").trim().toLowerCase();

    const devices = state.devices.filter((device) => {
      if (!search) {
        return true;
      }

      const haystack = [device.pin, device.deviceName, device.deviceId, device.ip, device.appVersion]
        .map((value) => String(value || "").toLowerCase())
        .join(" ");

      return haystack.includes(search);
    });

    el.adminDevicesBody.innerHTML = devices.length
      ? devices
          .map((device) => `
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
          `)
          .join("")
      : '<tr><td colspan="5" class="muted">No global devices available.</td></tr>';
  }

  function renderLogs() {
    const search = String(el.adminLogSearch.value || "").trim().toLowerCase();

    const logs = state.logs
      .filter((log) => {
        if (!search) {
          return true;
        }

        const haystack = [log.type, log.pin, log.message, log.requestId, log.error, log.deviceId]
          .map((value) => String(value || "").toLowerCase())
          .join(" ");

        return haystack.includes(search);
      })
      .slice(0, 300);

    el.adminLogsBody.innerHTML = logs.length
      ? logs
          .map((log) => `
            <tr>
              <td>${formatDate(log.at)}</td>
              <td>${escapeHtml(log.type || "-")}</td>
              <td class="mono">${escapeHtml(log.pin || "-")}</td>
              <td>${escapeHtml(log.message || log.error || log.requestId || "-")}</td>
            </tr>
          `)
          .join("")
      : '<tr><td colspan="4" class="muted">No global logs available.</td></tr>';
  }

  function renderAll() {
    renderRoleControls();
    renderSummary();
    renderUsers();
    renderDevices();
    renderLogs();
  }

  async function loadAdminData() {
    const [summaryResult, settingsResult, usersResult, devicesResult, logsResult] = await Promise.all([
      request("/api/admin/summary"),
      request("/api/admin/settings"),
      request("/api/admin/users"),
      request("/api/admin/devices"),
      request("/api/admin/logs"),
    ]);

    state.summary = summaryResult.summary || null;
    state.settings = settingsResult.settings || null;
    state.users = Array.isArray(usersResult.users) ? usersResult.users : [];
    state.devices = Array.isArray(devicesResult.devices) ? devicesResult.devices : [];
    state.logs = Array.isArray(logsResult.logs) ? logsResult.logs : [];

    state.logs.sort((left, right) => {
      const leftTs = new Date(right.at || 0).getTime();
      const rightTs = new Date(left.at || 0).getTime();
      return leftTs - rightTs;
    });

    renderAll();
  }

  el.registrationToggleForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearError();

    if (!userIsSuperAdmin()) {
      showError("Only super admin can change registration setting.");
      return;
    }

    try {
      const result = await request("/api/admin/settings/registration", {
        method: "PATCH",
        body: {
          enabled: Boolean(el.registrationEnabledToggle.checked),
        },
      });

      state.settings = result.settings || state.settings;
      renderSummary();
      showNotice("Registration setting updated.");
    } catch (error) {
      showError(`Update registration failed: ${error.message}`);
    }
  });

  el.logRetentionForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearError();

    if (!userIsSuperAdmin()) {
      showError("Only super admin can change log retention.");
      return;
    }

    const days = Number.parseInt(String(el.logRetentionDaysInput.value || "").trim(), 10);
    if (!Number.isInteger(days) || days < 1 || days > 365) {
      showError("Log retention days must be an integer between 1 and 365.");
      return;
    }

    try {
      const result = await request("/api/admin/settings/log-retention", {
        method: "PATCH",
        body: { days },
      });

      state.settings = result.settings || state.settings;
      renderSummary();
      showNotice(`Log retention updated to ${days} day(s).`);
      await loadAdminData();
    } catch (error) {
      showError(`Update log retention failed: ${error.message}`);
    }
  });

  el.clearLogsBtn.addEventListener("click", async () => {
    clearError();

    if (!userIsSuperAdmin()) {
      showError("Only super admin can delete logs.");
      return;
    }

    const confirmed = window.confirm("Delete all gateway logs now?");
    if (!confirmed) {
      return;
    }

    try {
      const result = await request("/api/admin/logs", {
        method: "DELETE",
      });
      const clearedLogs = Number(result?.summary?.clearedLogs || 0);
      showNotice(`Deleted ${clearedLogs} log item(s).`);
      await loadAdminData();
    } catch (error) {
      showError(`Delete logs failed: ${error.message}`);
    }
  });

  el.createManagedUserForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearError();

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

      await loadAdminData();
      showNotice("Managed user created.");
    } catch (error) {
      showError(`Create user failed: ${error.message}`);
    }
  });

  el.updateManagedUserForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearError();

    const userId = String(el.managedUpdateUserId.value || "").trim();
    if (!userId) {
      showError("Select a user from table before updating.");
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

      await loadAdminData();
      fillManagedUpdateForm(result.user || null);
      showNotice("Managed user updated.");
    } catch (error) {
      showError(`Update user failed: ${error.message}`);
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
    const user = state.users.find((item) => String(item.id || "") === userId) || null;
    fillManagedUpdateForm(user);
  });

  el.managedUserRefreshBtn.addEventListener("click", async () => {
    clearError();

    try {
      await loadAdminData();
      showNotice("Management data refreshed.");
    } catch (error) {
      showError(`Refresh failed: ${error.message}`);
    }
  });

  [el.managedUserSearch, el.managedUserRoleFilter].forEach((input) => {
    input.addEventListener("input", renderUsers);
    input.addEventListener("change", renderUsers);
  });

  el.adminDeviceSearch.addEventListener("input", renderDevices);
  el.adminLogSearch.addEventListener("input", renderLogs);

  (async () => {
    try {
      state.user = await ensureUser({ requireAdmin: true });
      mountSidebar("admin");
      clearManagedUpdateForm();
      await loadAdminData();
    } catch (error) {
      if (!String(error.message || "").startsWith("redirect_")) {
        showError(`Startup failed: ${error.message}`);
      }
    }
  })();
})();
