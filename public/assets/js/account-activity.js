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
  } = window.PsgApp;

  const state = {
    health: null,
    environments: [],
    devices: [],
    logs: [],
    visibleLogs: [],
    autoRefresh: true,
    refreshInterval: null,
  };

  const el = {
    autoRefreshToggle: document.getElementById("autoRefreshToggle"),
    refreshDashboardBtn: document.getElementById("refreshDashboardBtn"),
    saveLogsBtn: document.getElementById("saveLogsBtn"),
    deleteLogsBtn: document.getElementById("deleteLogsBtn"),

    statConnectedDevices: document.getElementById("statConnectedDevices"),
    statPendingRequests: document.getElementById("statPendingRequests"),
    statMyDevices: document.getElementById("statMyDevices"),
    statMyLogs: document.getElementById("statMyLogs"),

    environmentFilter: document.getElementById("environmentFilter"),
    deviceStatusFilter: document.getElementById("deviceStatusFilter"),
    logStatusFilter: document.getElementById("logStatusFilter"),
    mobileFilter: document.getElementById("mobileFilter"),
    contentFilter: document.getElementById("contentFilter"),
    fromTime: document.getElementById("fromTime"),
    toTime: document.getElementById("toTime"),
    resetFiltersBtn: document.getElementById("resetFiltersBtn"),

    devicesBody: document.getElementById("devicesBody"),
    logsBody: document.getElementById("logsBody"),

    smsAnalysisModal: document.getElementById("smsAnalysisModal"),
    closeSmsAnalysisBtn: document.getElementById("closeSmsAnalysisBtn"),
    smsAnalysisContent: document.getElementById("smsAnalysisContent"),
  };

  function parseFilterDate(value) {
    if (!value) {
      return null;
    }
    const ts = new Date(value).getTime();
    return Number.isNaN(ts) ? null : ts;
  }

  function statusPillClass(type) {
    const normalized = String(type || "").toLowerCase();
    if (["sms_sent", "sent", "online", "ok", "delivered"].includes(normalized)) {
      return "ok";
    }
    if (["sms_failed", "failed", "error", "offline"].includes(normalized)) {
      return "err";
    }
    return "warn";
  }

  function getLogStatus(log) {
    return String(log.status || log.type || "unknown");
  }

  function getLogTime(log) {
    return log.at || log.timestamp || null;
  }

  function getLogMobile(log) {
    if (Array.isArray(log.to)) {
      return log.to.map((item) => String(item || "").trim()).filter(Boolean).join(", ");
    }

    const value = log.to || log.recipient || "";
    return String(value || "").trim();
  }

  function getLogContent(log) {
    return String(log.message || log.error || log.requestId || "-");
  }

  function isSmsLog(log) {
    const type = String(log?.type || "").toLowerCase();
    return Boolean(log?.analysis) || type.startsWith("sms_");
  }

  function getRecipientsForAnalysis(log) {
    if (Array.isArray(log?.to)) {
      return log.to.map((item) => String(item || "").trim()).filter(Boolean);
    }

    if (typeof log?.to === "string" && log.to.trim()) {
      return log.to.split(",").map((item) => item.trim()).filter(Boolean);
    }

    if (typeof log?.recipient === "string" && log.recipient.trim()) {
      return [log.recipient.trim()];
    }

    return [];
  }

  function normalizeLogAnalysis(log) {
    if (log && typeof log.analysis === "object" && log.analysis !== null) {
      return log.analysis;
    }

    if (typeof log?.analysis === "string") {
      try {
        const parsed = JSON.parse(log.analysis);
        return parsed && typeof parsed === "object" ? parsed : null;
      } catch {
        return null;
      }
    }

    return null;
  }

  async function resolveLogAnalysis(log) {
    const existing = normalizeLogAnalysis(log);
    if (existing) {
      return existing;
    }

    const message = String(log?.message || "").trim();
    const to = getRecipientsForAnalysis(log);
    if (!message || to.length === 0) {
      return null;
    }

    const result = await request("/api/sms/analyze", {
      method: "POST",
      body: { to, message },
    });

    return result.analysis || null;
  }

  function formatBooleanFlag(value) {
    return value ? "Yes" : "No";
  }

  function formatCharacterLabel(character) {
    if (character === "\n") {
      return "\\n";
    }
    if (character === "\r") {
      return "\\r";
    }
    if (character === "\t") {
      return "\\t";
    }
    if (character === "\f") {
      return "\\f";
    }
    if (character === " ") {
      return "(space)";
    }
    return character || "";
  }

  function closeSmsAnalysisModal() {
    el.smsAnalysisModal.classList.add("hidden");
    el.smsAnalysisModal.setAttribute("aria-hidden", "true");
    el.smsAnalysisContent.innerHTML = "";
  }

  function openSmsAnalysisModal(log, analysis) {
    const recipients = analysis?.recipients || {};
    const message = analysis?.message || {};

    const invalidRecipients = Array.isArray(recipients.invalidRecipients) ? recipients.invalidRecipients : [];
    const extensionCharacters = Array.isArray(message.extensionCharacters) ? message.extensionCharacters : [];
    const unsupportedCharacters = Array.isArray(message.unsupportedCharacters) ? message.unsupportedCharacters : [];
    const segments = Array.isArray(message.segments) ? message.segments : [];

    const summaryCards = analysis
      ? `
        <div class="analysis-grid">
          <article class="analysis-card">
            <h4>Encoding</h4>
            <div class="analysis-row"><span>Type</span><strong>${escapeHtml(String(message.encoding || "-"))}</strong></div>
            <div class="analysis-row"><span>Unicode</span><strong>${escapeHtml(formatBooleanFlag(Boolean(message.unicodeDetected)))}</strong></div>
            <div class="analysis-row"><span>GSM-7 Supported</span><strong>${escapeHtml(formatBooleanFlag(Boolean(message.gsm7Supported)))}</strong></div>
          </article>

          <article class="analysis-card">
            <h4>Length</h4>
            <div class="analysis-row"><span>Characters</span><strong>${escapeHtml(String(message.totalCharacters ?? "-"))}</strong></div>
            <div class="analysis-row"><span>Units</span><strong>${escapeHtml(String(message.totalUnits ?? "-"))}</strong></div>
            <div class="analysis-row"><span>Remaining</span><strong>${escapeHtml(String(message.remainingInCurrentSegment ?? "-"))}</strong></div>
          </article>

          <article class="analysis-card">
            <h4>Multipart</h4>
            <div class="analysis-row"><span>Multipart</span><strong>${escapeHtml(formatBooleanFlag(Boolean(message.isMultipart)))}</strong></div>
            <div class="analysis-row"><span>Segments</span><strong>${escapeHtml(String(message.segmentCount ?? "-"))}</strong></div>
            <div class="analysis-row"><span>Per Segment Limit</span><strong>${escapeHtml(String(message.perSegmentLimit ?? "-"))}</strong></div>
          </article>

          <article class="analysis-card">
            <h4>E.164 Validation</h4>
            <div class="analysis-row"><span>Total Recipients</span><strong>${escapeHtml(String(recipients.total ?? "-"))}</strong></div>
            <div class="analysis-row"><span>Valid</span><strong>${escapeHtml(String(recipients.validCount ?? "-"))}</strong></div>
            <div class="analysis-row"><span>Invalid</span><strong>${escapeHtml(String(recipients.invalidCount ?? "-"))}</strong></div>
          </article>
        </div>
      `
      : `
        <div class="analysis-empty">
          Analysis is not available for this log entry.
        </div>
      `;

    const invalidRecipientsHtml = invalidRecipients.length
      ? `
        <section class="analysis-section">
          <h4>Invalid Recipients and Reasons</h4>
          <ul class="analysis-list">
            ${invalidRecipients
              .map((item) => `
                <li>
                  <strong>${escapeHtml(String(item.input || item.normalized || "-"))}</strong>
                  - ${escapeHtml(String(item.reason || item.validationCode || "Invalid recipient"))}
                </li>
              `)
              .join("")}
          </ul>
        </section>
      `
      : "";

    const extensionCharactersHtml = extensionCharacters.length
      ? `
        <section class="analysis-section">
          <h4>GSM-7 Extension Characters</h4>
          <ul class="analysis-list">
            ${extensionCharacters
              .map((item) => `
                <li>
                  <strong>${escapeHtml(formatCharacterLabel(String(item.character || "")))}</strong>
                  (${escapeHtml(String(item.codePoint || "-"))})
                  - ${escapeHtml(String(item.reason || "Uses GSM-7 extension table."))}
                </li>
              `)
              .join("")}
          </ul>
        </section>
      `
      : "";

    const unsupportedCharactersHtml = unsupportedCharacters.length
      ? `
        <section class="analysis-section">
          <h4>Unsupported Characters and Reasons</h4>
          <ul class="analysis-list">
            ${unsupportedCharacters
              .map((item) => `
                <li>
                  <strong>${escapeHtml(formatCharacterLabel(String(item.character || "")))}</strong>
                  (${escapeHtml(String(item.codePoint || "-"))})
                  - ${escapeHtml(String(item.reason || "Not supported in GSM-7."))}
                </li>
              `)
              .join("")}
          </ul>
        </section>
      `
      : "";

    const segmentsHtml = segments.length
      ? `
        <section class="analysis-section">
          <h4>Multipart Simulation</h4>
          <div class="analysis-table-wrap">
            <table class="analysis-table">
              <thead>
                <tr>
                  <th>Segment</th>
                  <th>Units</th>
                  <th>Characters</th>
                  <th>Text</th>
                </tr>
              </thead>
              <tbody>
                ${segments
                  .map((segment) => `
                    <tr>
                      <td>${escapeHtml(String(segment.index ?? "-"))}</td>
                      <td>${escapeHtml(String(segment.unitCount ?? "-"))}</td>
                      <td>${escapeHtml(String(segment.characterCount ?? "-"))}</td>
                      <td class="analysis-segment-text">${escapeHtml(String(segment.text || ""))}</td>
                    </tr>
                  `)
                  .join("")}
              </tbody>
            </table>
          </div>
        </section>
      `
      : "";

    el.smsAnalysisContent.innerHTML = `
      <section class="analysis-section">
        <h4>Log Summary</h4>
        <div class="analysis-grid">
          <article class="analysis-card">
            <div class="analysis-row"><span>Type</span><strong>${escapeHtml(String(log?.type || log?.status || "-"))}</strong></div>
            <div class="analysis-row"><span>PIN</span><strong>${escapeHtml(String(log?.pin || "-"))}</strong></div>
            <div class="analysis-row"><span>Time</span><strong>${escapeHtml(formatDate(getLogTime(log)))}</strong></div>
          </article>
          <article class="analysis-card">
            <div class="analysis-row"><span>Mobile</span><strong>${escapeHtml(getLogMobile(log) || "-")}</strong></div>
            <div class="analysis-row"><span>Request ID</span><strong>${escapeHtml(String(log?.requestId || "-"))}</strong></div>
            <div class="analysis-row"><span>Content</span><strong>${escapeHtml(getLogContent(log))}</strong></div>
          </article>
        </div>
      </section>

      ${summaryCards}
      ${invalidRecipientsHtml}
      ${extensionCharactersHtml}
      ${unsupportedCharactersHtml}
      ${segmentsHtml}
    `;

    el.smsAnalysisModal.classList.remove("hidden");
    el.smsAnalysisModal.setAttribute("aria-hidden", "false");
  }

  function getSelectedEnvironment() {
    const selectedEnvironmentId = String(el.environmentFilter.value || "all");
    if (selectedEnvironmentId === "all") {
      return null;
    }

    return state.environments.find((environment) => String(environment.id || "") === selectedEnvironmentId) || null;
  }

  function filterByEnvironment(logOrDevice) {
    const selectedEnvironment = getSelectedEnvironment();
    if (!selectedEnvironment) {
      return true;
    }

    const itemEnvironmentId = String(logOrDevice.environmentId || "");
    if (itemEnvironmentId) {
      return itemEnvironmentId === String(selectedEnvironment.id || "");
    }

    return String(logOrDevice.pin || "") === String(selectedEnvironment.pin || "");
  }

  function updateEnvironmentOptions() {
    const current = String(el.environmentFilter.value || "all");
    const options = [
      '<option value="all">All Environments</option>',
      ...state.environments.map(
        (environment) =>
          `<option value="${escapeHtml(environment.id)}">${escapeHtml(environment.name)} (PIN ${escapeHtml(environment.pin)})</option>`
      ),
    ];

    el.environmentFilter.innerHTML = options.join("");

    const exists = state.environments.some((environment) => String(environment.id || "") === current);
    el.environmentFilter.value = exists ? current : "all";
  }

  function updateLogStatusOptions() {
    const current = String(el.logStatusFilter.value || "all");
    const scopedLogs = state.logs.filter((log) => filterByEnvironment(log));
    const dynamicTypes = Array.from(
      new Set(
        scopedLogs
          .map((log) => String(log.type || log.status || "").trim())
          .filter(Boolean)
      )
    ).sort();

    const options = ["all", ...dynamicTypes];
    el.logStatusFilter.innerHTML = options
      .map((value) => {
        const label = value === "all" ? "All" : value;
        return `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`;
      })
      .join("");

    if (options.includes(current)) {
      el.logStatusFilter.value = current;
    }
  }

  function renderFilteredTables() {
    const deviceStatus = String(el.deviceStatusFilter.value || "all");
    const logStatus = String(el.logStatusFilter.value || "all");
    const mobileTerm = String(el.mobileFilter.value || "").trim().toLowerCase();
    const contentTerm = String(el.contentFilter.value || "").trim().toLowerCase();
    const fromTs = parseFilterDate(el.fromTime.value);
    const toTs = parseFilterDate(el.toTime.value);

    const filteredDevices = state.devices.filter((device) => {
      if (!filterByEnvironment(device)) {
        return false;
      }

      if (deviceStatus === "online" && !device.online) {
        return false;
      }
      if (deviceStatus === "offline" && device.online) {
        return false;
      }

      const mobileHaystack = [device.pin, device.deviceName, device.deviceId]
        .map((value) => String(value || "").toLowerCase())
        .join(" ");

      if (mobileTerm && !mobileHaystack.includes(mobileTerm)) {
        return false;
      }

      const contentHaystack = [device.ip, device.appVersion]
        .map((value) => String(value || "").toLowerCase())
        .join(" ");

      if (contentTerm && !contentHaystack.includes(contentTerm)) {
        return false;
      }

      const seenTs = new Date(device.lastSeenAt || 0).getTime();
      if (fromTs && !Number.isNaN(seenTs) && seenTs < fromTs) {
        return false;
      }
      if (toTs && !Number.isNaN(seenTs) && seenTs > toTs) {
        return false;
      }

      return true;
    });

    const filteredLogs = state.logs.filter((log) => {
      if (!filterByEnvironment(log)) {
        return false;
      }

      const status = getLogStatus(log);
      if (logStatus !== "all" && status !== logStatus) {
        return false;
      }

      const mobileValue = getLogMobile(log).toLowerCase();
      if (mobileTerm && !mobileValue.includes(mobileTerm)) {
        return false;
      }

      const contentValue = [getLogContent(log), log.type, log.status]
        .map((value) => String(value || "").toLowerCase())
        .join(" ");

      if (contentTerm && !contentValue.includes(contentTerm)) {
        return false;
      }

      const logTs = new Date(getLogTime(log) || 0).getTime();
      if (fromTs && !Number.isNaN(logTs) && logTs < fromTs) {
        return false;
      }
      if (toTs && !Number.isNaN(logTs) && logTs > toTs) {
        return false;
      }

      return true;
    });
    state.visibleLogs = filteredLogs;

    el.devicesBody.innerHTML = filteredDevices.length
      ? filteredDevices
          .map((device) => `
            <tr>
              <td class="mono">${escapeHtml(device.pin || "-")}</td>
              <td>
                <div>${escapeHtml(device.deviceName || "-")}</div>
                <div class="mono">${escapeHtml(device.deviceId || "-")}</div>
              </td>
              <td class="mono">${escapeHtml(device.ip || "-")}</td>
              <td>${device.online ? '<span class="status-pill ok">online</span>' : '<span class="status-pill err">offline</span>'}</td>
              <td>${formatDate(device.lastSeenAt)}</td>
            </tr>
          `)
          .join("")
      : '<tr><td colspan="5" class="muted">No devices match current filters.</td></tr>';

    el.logsBody.innerHTML = filteredLogs.length
      ? filteredLogs
          .map((log, index) => {
            const status = getLogStatus(log);
            const mobile = getLogMobile(log) || "-";
            const content = getLogContent(log);
            const actionCell = isSmsLog(log)
              ? `<button class="btn btn-small" type="button" data-action="view-sms-analysis" data-log-index="${index}">View</button>`
              : '<span class="muted small">-</span>';

            return `
              <tr>
                <td>${formatDate(getLogTime(log))}</td>
                <td><span class="status-pill ${statusPillClass(status)}">${escapeHtml(status)}</span></td>
                <td class="mono">${escapeHtml(mobile)}</td>
                <td>${escapeHtml(content)}</td>
                <td class="mono">${escapeHtml(log.pin || "-")}</td>
                <td class="logs-actions-cell">${actionCell}</td>
              </tr>
            `;
          })
          .join("")
      : '<tr><td colspan="6" class="muted">No logs match current filters.</td></tr>';
  }

  function renderStats() {
    const health = state.health || {};
    el.statConnectedDevices.textContent = String(Number(health.connectedDevices || 0));
    el.statPendingRequests.textContent = String(Number(health.pendingRequests || 0));
    el.statMyDevices.textContent = String(state.devices.length);
    el.statMyLogs.textContent = String(state.logs.length);
  }

  async function loadActivityData() {
    const [healthResult, environmentsResult, devicesResult, logsResult] = await Promise.all([
      request("/health", { useAuthToken: false }),
      request("/api/environments"),
      request("/api/account/devices"),
      request("/api/account/logs"),
    ]);

    state.health = healthResult;
    state.environments = Array.isArray(environmentsResult.environments) ? environmentsResult.environments : [];
    state.devices = Array.isArray(devicesResult.devices) ? devicesResult.devices : [];
    state.logs = Array.isArray(logsResult.logs) ? logsResult.logs : [];

    state.logs.sort((left, right) => {
      const leftTs = new Date(right.at || right.timestamp || 0).getTime();
      const rightTs = new Date(left.at || left.timestamp || 0).getTime();
      return leftTs - rightTs;
    });

    updateEnvironmentOptions();
    updateLogStatusOptions();
    renderStats();
    renderFilteredTables();
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
      if (!state.autoRefresh || document.hidden) {
        return;
      }

      try {
        await loadActivityData();
      } catch {
        // no-op
      }
    }, 6000);
  }

  el.refreshDashboardBtn.addEventListener("click", async () => {
    clearError();
    try {
      await loadActivityData();
      showNotice("Activity refreshed.");
    } catch (error) {
      showError(`Refresh failed: ${error.message}`);
    }
  });

  el.saveLogsBtn.addEventListener("click", async () => {
    clearError();
    el.saveLogsBtn.disabled = true;

    try {
      const result = await request("/api/account/logs/save", {
        method: "POST",
      });
      const summary = result.summary || {};
      const inserted = Number(summary.inserted || 0);
      const scanned = Number(summary.scanned || 0);
      showNotice(`Saved ${inserted} of ${scanned} log(s) to database.`);
    } catch (error) {
      showError(`Save logs failed: ${error.message}`);
    } finally {
      el.saveLogsBtn.disabled = false;
    }
  });

  el.deleteLogsBtn.addEventListener("click", async () => {
    clearError();

    const confirmed = window.confirm("Are you sure you want to delete logs?");
    if (!confirmed) {
      return;
    }

    el.deleteLogsBtn.disabled = true;
    try {
      const result = await request("/api/account/logs", {
        method: "DELETE",
      });
      const summary = result.summary || {};
      const removedRuntimeLogs = Number(summary.removedRuntimeLogs || 0);
      const deletedDbLogs = Number(summary.deletedDbLogs || 0);

      await loadActivityData();
      showNotice(`Deleted logs. Runtime: ${removedRuntimeLogs}, Database: ${deletedDbLogs}.`);
    } catch (error) {
      showError(`Delete logs failed: ${error.message}`);
    } finally {
      el.deleteLogsBtn.disabled = false;
    }
  });

  el.logsBody.addEventListener("click", async (event) => {
    const viewBtn = event.target.closest('button[data-action="view-sms-analysis"]');
    if (!viewBtn) {
      return;
    }

    const index = Number(viewBtn.dataset.logIndex);
    const log = Number.isInteger(index) ? state.visibleLogs[index] : null;
    if (!log) {
      return;
    }

    const originalLabel = viewBtn.textContent;
    viewBtn.disabled = true;
    viewBtn.textContent = "Loading...";
    clearError();

    try {
      const analysis = await resolveLogAnalysis(log);
      openSmsAnalysisModal(log, analysis);
    } catch (error) {
      showError(`Failed to load SMS analysis: ${error.message}`);
    } finally {
      viewBtn.disabled = false;
      viewBtn.textContent = originalLabel;
    }
  });

  el.closeSmsAnalysisBtn.addEventListener("click", () => {
    closeSmsAnalysisModal();
  });

  el.smsAnalysisModal.addEventListener("click", (event) => {
    const closeModal = event.target.closest("[data-close-analysis-modal='true']");
    if (closeModal) {
      closeSmsAnalysisModal();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !el.smsAnalysisModal.classList.contains("hidden")) {
      closeSmsAnalysisModal();
    }
  });

  el.autoRefreshToggle.addEventListener("change", () => {
    state.autoRefresh = Boolean(el.autoRefreshToggle.checked);
  });

  [
    el.environmentFilter,
    el.deviceStatusFilter,
    el.logStatusFilter,
    el.mobileFilter,
    el.contentFilter,
    el.fromTime,
    el.toTime,
  ].forEach((input) => {
    input.addEventListener("input", () => {
      if (input === el.environmentFilter) {
        updateLogStatusOptions();
      }
      renderFilteredTables();
    });

    input.addEventListener("change", () => {
      if (input === el.environmentFilter) {
        updateLogStatusOptions();
      }
      renderFilteredTables();
    });
  });

  el.resetFiltersBtn.addEventListener("click", () => {
    el.environmentFilter.value = "all";
    el.deviceStatusFilter.value = "all";
    el.logStatusFilter.value = "all";
    el.mobileFilter.value = "";
    el.contentFilter.value = "";
    el.fromTime.value = "";
    el.toTime.value = "";
    updateLogStatusOptions();
    renderFilteredTables();
  });

  (async () => {
    try {
      await ensureUser();
      mountSidebar("activity");
      await loadActivityData();
      startRefreshLoop();
    } catch (error) {
      if (!String(error.message || "").startsWith("redirect_")) {
        showError(`Startup failed: ${error.message}`);
      }
    }
  })();
})();
