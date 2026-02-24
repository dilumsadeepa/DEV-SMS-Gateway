(() => {
  const {
    request,
    ensureUser,
    mountSidebar,
    showNotice,
    showError,
    clearError,
    escapeHtml,
    parseJson,
    formatDate,
  } = window.PsgApp;

  const state = {
    user: null,
    environments: [],
    keysByEnvironment: {},
    rawKeysByEnvironment: {},
    smsAnalysis: null,
    smsAnalysisTimer: null,
  };

  const el = {
    reloadWorkspaceBtn: document.getElementById("reloadWorkspaceBtn"),
    createEnvironmentForm: document.getElementById("createEnvironmentForm"),
    environmentList: document.getElementById("environmentList"),

    smsEnvironmentSelect: document.getElementById("smsEnvironmentSelect"),
    smsKnownKeySelect: document.getElementById("smsKnownKeySelect"),
    simulatorMobileFilter: document.getElementById("simulatorMobileFilter"),
    openDeviceSimulatorBtn: document.getElementById("openDeviceSimulatorBtn"),
    smsApiKeyInput: document.getElementById("smsApiKeyInput"),
    smsToInput: document.getElementById("smsToInput"),
    smsMessageInput: document.getElementById("smsMessageInput"),
    sendSmsForm: document.getElementById("sendSmsForm"),
    smsResult: document.getElementById("smsResult"),
    smsAnalysisPanel: document.getElementById("smsAnalysisPanel"),
    smsAnalysisEncodingBadge: document.getElementById("smsAnalysisEncodingBadge"),
    smsAnalysisEncoding: document.getElementById("smsAnalysisEncoding"),
    smsAnalysisUnicode: document.getElementById("smsAnalysisUnicode"),
    smsAnalysisLength: document.getElementById("smsAnalysisLength"),
    smsAnalysisSegments: document.getElementById("smsAnalysisSegments"),
    smsAnalysisLimit: document.getElementById("smsAnalysisLimit"),
    smsAnalysisRemaining: document.getElementById("smsAnalysisRemaining"),
    smsRecipientSummary: document.getElementById("smsRecipientSummary"),
    smsInvalidRecipients: document.getElementById("smsInvalidRecipients"),
    smsUnsupportedCharacters: document.getElementById("smsUnsupportedCharacters"),
    smsSegmentPreview: document.getElementById("smsSegmentPreview"),

    statusForm: document.getElementById("statusForm"),
    statusRequestId: document.getElementById("statusRequestId"),
    statusApiKey: document.getElementById("statusApiKey"),
    statusResult: document.getElementById("statusResult"),
  };

  function getSelectedEnvironment() {
    const selectedId = String(el.smsEnvironmentSelect.value || "").trim();
    return state.environments.find((environment) => String(environment.id || "") === selectedId) || null;
  }

  function openDeviceSimulatorWindow() {
    const selectedEnvironment = getSelectedEnvironment();
    const mobile = String(el.simulatorMobileFilter?.value || "").trim();
    const params = new URLSearchParams();

    if (selectedEnvironment?.pin) {
      params.set("pin", String(selectedEnvironment.pin));
    }

    if (mobile) {
      params.set("mobile", mobile);
    }

    if (state.user?.name) {
      params.set("deviceName", `${String(state.user.name).trim()} Simulator`);
    }

    params.set("deviceId", `web-sim-${Date.now().toString(36)}`);

    const targetUrl = `/device-simulator?${params.toString()}`;
    const popupName = `psg_device_simulator_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const simulatorWindow = window.open(
      targetUrl,
      popupName,
      "popup=yes,width=560,height=920,menubar=no,toolbar=no,location=no,status=no,resizable=yes,scrollbars=yes"
    );
    if (!simulatorWindow) {
      showError("Popup blocked. Allow popups and try again.");
      return;
    }

    showNotice("Device simulator opened in a new window.");
  }

  function getRawKeyStorageKey() {
    const userId = String(state.user?.id || "anonymous");
    return `psg_raw_keys_${userId}`;
  }

  function loadRawKeysFromStorage() {
    state.rawKeysByEnvironment = parseJson(localStorage.getItem(getRawKeyStorageKey()) || "{}", {});
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

  function mergeKeysWithRemembered(environmentId, apiKeys) {
    const remembered = state.rawKeysByEnvironment[environmentId] || {};
    return (apiKeys || []).map((key) => ({
      ...key,
      rawKey: remembered[key.id] || null,
    }));
  }

  function renderList(items, emptyText) {
    if (!Array.isArray(items) || items.length === 0) {
      return `<span class="muted">${escapeHtml(emptyText)}</span>`;
    }
    return `<ul>${items.map((item) => `<li>${item}</li>`).join("")}</ul>`;
  }

  function renderSmsAnalysis(analysis) {
    if (!analysis || !analysis.message || !analysis.recipients) {
      return;
    }

    state.smsAnalysis = analysis;

    const message = analysis.message;
    const recipients = analysis.recipients;

    el.smsAnalysisEncodingBadge.textContent = escapeHtml(message.encoding || "Unknown");
    el.smsAnalysisEncoding.textContent = message.encoding || "Unknown";
    el.smsAnalysisUnicode.textContent = message.unicodeDetected ? "Yes" : "No";
    el.smsAnalysisLength.textContent = `${Number(message.totalCharacters || 0)} chars / ${Number(message.totalUnits || 0)} units`;
    el.smsAnalysisSegments.textContent = String(Number(message.segmentCount || 0));
    el.smsAnalysisLimit.textContent = String(Number(message.perSegmentLimit || 0));
    el.smsAnalysisRemaining.textContent = String(Number(message.remainingInCurrentSegment || 0));

    const recipientSummary = [
      `Total: ${Number(recipients.total || 0)}`,
      `Valid: ${Number(recipients.validCount || 0)}`,
      `Invalid: ${Number(recipients.invalidCount || 0)}`,
    ].join(" | ");
    el.smsRecipientSummary.textContent = recipientSummary;

    const invalidRecipientItems = (recipients.invalidRecipients || []).map((item) => {
      const input = escapeHtml(item.input || item.normalized || "(empty)");
      const reason = escapeHtml(item.reason || "Invalid E.164 number");
      return `<strong>${input}</strong>: ${reason}`;
    });
    el.smsInvalidRecipients.innerHTML = renderList(invalidRecipientItems, "No invalid recipients.");

    const unsupportedItems = (message.unsupportedCharacters || []).map((item) => {
      const char = escapeHtml(item.character || "");
      const codePoint = escapeHtml(item.codePoint || "");
      const reason = escapeHtml(item.reason || "");
      return `<strong>${char || "(space)"}</strong> ${codePoint}: ${reason}`;
    });

    const extensionItems = (message.extensionCharacters || []).map((item) => {
      const char = escapeHtml(item.character || "");
      const codePoint = escapeHtml(item.codePoint || "");
      const reason = escapeHtml(item.reason || "");
      return `Extension char <strong>${char || "(space)"}</strong> ${codePoint}: ${reason}`;
    });

    el.smsUnsupportedCharacters.innerHTML = renderList(
      [...unsupportedItems, ...extensionItems],
      "All characters are GSM-7 supported."
    );

    const segmentItems = (message.segments || []).map((segment) => {
      const index = Number(segment.index || 0);
      const unitCount = Number(segment.unitCount || 0);
      const charCount = Number(segment.characterCount || 0);
      const text = escapeHtml(segment.text || "");
      return `Part ${index}: ${charCount} chars / ${unitCount} units<br><span class=\"mono\">${text}</span>`;
    });

    el.smsSegmentPreview.innerHTML = renderList(segmentItems, "No message content to split.");
  }

  async function fetchSmsAnalysis() {
    const to = String(el.smsToInput.value || "").trim();
    const message = String(el.smsMessageInput.value || "").trim();

    try {
      const result = await request("/api/sms/analyze", {
        method: "POST",
        body: { to, message },
      });
      renderSmsAnalysis(result.analysis);
    } catch (error) {
      const reason = error && error.message ? error.message : "analysis_failed";
      showError(`SMS analysis failed: ${reason}`);
    }
  }

  function scheduleSmsAnalysis() {
    if (state.smsAnalysisTimer) {
      clearTimeout(state.smsAnalysisTimer);
    }

    state.smsAnalysisTimer = setTimeout(() => {
      fetchSmsAnalysis();
    }, 180);
  }

  function renderKnownKeyOptions(environmentId) {
    const keys = (state.keysByEnvironment[environmentId] || []).filter((item) => item.isActive && item.rawKey);

    if (!keys.length) {
      el.smsKnownKeySelect.innerHTML = '<option value="">No saved raw key</option>';
      return;
    }

    const options = keys
      .map((key) => `<option value="${escapeHtml(key.id)}">${escapeHtml(key.name)} (${escapeHtml(key.keyPreview || key.id)})</option>`)
      .join("");

    el.smsKnownKeySelect.innerHTML = `<option value="">Select key</option>${options}`;
  }

  function renderEnvironmentOptions(selectedEnvironmentId = "") {
    if (!state.environments.length) {
      el.smsEnvironmentSelect.innerHTML = '<option value="">No environments</option>';
      renderKnownKeyOptions("");
      return;
    }

    el.smsEnvironmentSelect.innerHTML = state.environments
      .map((environment) => `<option value="${escapeHtml(environment.id)}">${escapeHtml(environment.name)} (PIN ${escapeHtml(environment.pin)})</option>`)
      .join("");

    const resolvedId = state.environments.some((environment) => environment.id === selectedEnvironmentId)
      ? selectedEnvironmentId
      : state.environments[0].id;

    el.smsEnvironmentSelect.value = resolvedId;
    renderKnownKeyOptions(resolvedId);
  }

  function renderEnvironmentCards() {
    if (!state.environments.length) {
      el.environmentList.innerHTML = `
        <article class="environment-card">
          <p class="muted">No environments available. Create your first environment.</p>
        </article>
      `;
      return;
    }

    el.environmentList.innerHTML = state.environments
      .map((environment) => {
        const keys = state.keysByEnvironment[environment.id] || [];
        const keyRows = keys.length
          ? keys
              .map((key) => {
                const statusText = key.isActive ? "active" : "revoked";
                const rawKeyCell = key.rawKey
                  ? `<div class="mono">${escapeHtml(key.rawKey)}</div>`
                  : '<span class="muted">not available</span>';
                const revokeButton = key.isActive
                  ? `<button type="button" class="btn" data-action="revoke-key" data-environment-id="${escapeHtml(environment.id)}" data-key-id="${escapeHtml(key.id)}">Revoke</button>`
                  : "";

                return `
                  <tr>
                    <td>${escapeHtml(key.name)}</td>
                    <td class="mono">${escapeHtml(key.keyPreview || "")}</td>
                    <td>${escapeHtml(statusText)}</td>
                    <td>${rawKeyCell}</td>
                    <td>${formatDate(key.createdAt)}</td>
                    <td>${revokeButton}</td>
                  </tr>
                `;
              })
              .join("")
          : '<tr><td colspan="6" class="muted">No API keys yet.</td></tr>';

        return `
          <article class="environment-card" data-environment-id="${escapeHtml(environment.id)}">
            <div class="environment-head">
              <h3>${escapeHtml(environment.name)}</h3>
              <span class="pill">PIN ${escapeHtml(environment.pin)}</span>
            </div>
            <div class="muted small">${escapeHtml(environment.description || "No description")}</div>
            <div class="mono" style="margin-top:6px;">Env ID: ${escapeHtml(environment.id)}</div>

            <div class="inline-actions" style="margin-top:10px;">
              <button type="button" class="btn" data-action="select-environment" data-environment-id="${escapeHtml(environment.id)}">Use For SMS</button>
              <button type="button" class="btn" data-action="refresh-keys" data-environment-id="${escapeHtml(environment.id)}">Refresh Keys</button>
            </div>

            <form class="form-grid" data-action="create-key" data-environment-id="${escapeHtml(environment.id)}" style="margin-top:10px;">
              <label class="field">
                <span>New Key Name</span>
                <input type="text" name="keyName" placeholder="backend-service" />
              </label>
              <div class="field action-row">
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
      })
      .join("");
  }

  async function loadEnvironments() {
    const result = await request("/api/environments");
    state.environments = Array.isArray(result.environments) ? result.environments : [];

    const keyLoadTasks = state.environments.map(async (environment) => {
      try {
        const keyResult = await request(`/api/environments/${encodeURIComponent(environment.id)}/api-keys`);
        state.keysByEnvironment[environment.id] = mergeKeysWithRemembered(environment.id, keyResult.apiKeys || []);
      } catch {
        state.keysByEnvironment[environment.id] = [];
      }
    });

    await Promise.all(keyLoadTasks);

    renderEnvironmentCards();
    renderEnvironmentOptions();
  }

  async function loadEnvironmentKeys(environmentId) {
    const result = await request(`/api/environments/${encodeURIComponent(environmentId)}/api-keys`);
    state.keysByEnvironment[environmentId] = mergeKeysWithRemembered(environmentId, result.apiKeys || []);
    renderEnvironmentCards();
    renderKnownKeyOptions(el.smsEnvironmentSelect.value);
  }

  el.reloadWorkspaceBtn.addEventListener("click", async () => {
    clearError();
    try {
      await loadEnvironments();
      showNotice("Workspace reloaded.");
    } catch (error) {
      showError(`Reload failed: ${error.message}`);
    }
  });

  el.createEnvironmentForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearError();

    const form = new FormData(el.createEnvironmentForm);
    const metadataText = String(form.get("metadata") || "").trim();

    const payload = {
      name: String(form.get("name") || "").trim(),
      pin: String(form.get("pin") || "").trim(),
      description: String(form.get("description") || "").trim(),
    };

    if (metadataText) {
      const metadata = parseJson(metadataText, null);
      if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
        showError("Metadata must be a JSON object.");
        return;
      }
      payload.metadata = metadata;
    }

    try {
      const result = await request("/api/environments", {
        method: "POST",
        body: payload,
      });

      const environment = result.environment;
      const keyInfo = {
        ...result.apiKeyInfo,
        rawKey: result.apiKey,
      };

      state.environments.push(environment);
      state.environments.sort((left, right) => String(left.name || "").localeCompare(String(right.name || "")));

      if (!state.keysByEnvironment[environment.id]) {
        state.keysByEnvironment[environment.id] = [];
      }

      state.keysByEnvironment[environment.id].unshift(keyInfo);
      rememberRawKey(environment.id, keyInfo.id, result.apiKey);

      renderEnvironmentCards();
      renderEnvironmentOptions(environment.id);

      el.smsApiKeyInput.value = result.apiKey;
      el.createEnvironmentForm.reset();
      showNotice(`Environment created: ${environment.name}`);
    } catch (error) {
      showError(`Create environment failed: ${error.message}`);
    }
  });

  el.environmentList.addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) {
      return;
    }

    clearError();

    const action = button.getAttribute("data-action");
    const environmentId = String(button.getAttribute("data-environment-id") || "").trim();

    if (!environmentId) {
      return;
    }

    if (action === "select-environment") {
      renderEnvironmentOptions(environmentId);
      showNotice("Environment selected for SMS.");
      return;
    }

    if (action === "refresh-keys") {
      try {
        await loadEnvironmentKeys(environmentId);
        showNotice("Environment keys refreshed.");
      } catch (error) {
        showError(`Refresh keys failed: ${error.message}`);
      }
      return;
    }

    if (action === "revoke-key") {
      const keyId = String(button.getAttribute("data-key-id") || "").trim();
      if (!keyId) {
        return;
      }

      try {
        await request(`/api/environments/${encodeURIComponent(environmentId)}/api-keys/${encodeURIComponent(keyId)}`, {
          method: "DELETE",
        });

        state.keysByEnvironment[environmentId] = (state.keysByEnvironment[environmentId] || []).map((key) => {
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
        showError(`Revoke key failed: ${error.message}`);
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

    const environmentId = String(form.getAttribute("data-environment-id") || "").trim();
    const input = form.querySelector("input[name='keyName']");
    const keyName = String(input?.value || "").trim() || "default";

    try {
      const result = await request(`/api/environments/${encodeURIComponent(environmentId)}/api-keys`, {
        method: "POST",
        body: { name: keyName },
      });

      const keyInfo = {
        ...result.apiKeyInfo,
        rawKey: result.apiKey,
      };

      if (!state.keysByEnvironment[environmentId]) {
        state.keysByEnvironment[environmentId] = [];
      }

      state.keysByEnvironment[environmentId].unshift(keyInfo);
      rememberRawKey(environmentId, keyInfo.id, result.apiKey);

      renderEnvironmentCards();
      renderKnownKeyOptions(el.smsEnvironmentSelect.value);

      el.smsApiKeyInput.value = result.apiKey;
      form.reset();
      showNotice("New key created.");
    } catch (error) {
      showError(`Create key failed: ${error.message}`);
    }
  });

  el.smsEnvironmentSelect.addEventListener("change", () => {
    renderKnownKeyOptions(el.smsEnvironmentSelect.value);
  });

  el.smsKnownKeySelect.addEventListener("change", () => {
    const selectedKeyId = String(el.smsKnownKeySelect.value || "").trim();
    if (!selectedKeyId) {
      return;
    }

    const environmentId = el.smsEnvironmentSelect.value;
    const key = (state.keysByEnvironment[environmentId] || []).find((item) => item.id === selectedKeyId);
    if (key && key.rawKey) {
      el.smsApiKeyInput.value = key.rawKey;
    }
  });

  el.openDeviceSimulatorBtn.addEventListener("click", () => {
    clearError();
    openDeviceSimulatorWindow();
  });

  [el.smsToInput, el.smsMessageInput].forEach((input) => {
    input.addEventListener("input", () => {
      scheduleSmsAnalysis();
    });
  });

  el.sendSmsForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearError();

    const apiKey = String(el.smsApiKeyInput.value || "").trim();
    const to = String(el.smsToInput.value || "").trim();
    const message = String(el.smsMessageInput.value || "").trim();

    if (!apiKey) {
      showError("API key is required.");
      return;
    }

    try {
      const result = await request("/api/send-sms", {
        method: "POST",
        apiKey,
        body: { to, message },
      });

      if (result.analysis) {
        renderSmsAnalysis(result.analysis);
      }

      el.smsResult.textContent = JSON.stringify(result, null, 2);
      el.smsResult.classList.remove("hidden");

      if (result.requestId) {
        el.statusRequestId.value = result.requestId;
      }

      showNotice("SMS request sent.");
    } catch (error) {
      if (error?.payload?.analysis) {
        renderSmsAnalysis(error.payload.analysis);
      }
      el.smsResult.textContent = JSON.stringify(error.payload || { error: error.message }, null, 2);
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
      el.statusResult.textContent = JSON.stringify(error.payload || { error: error.message }, null, 2);
      el.statusResult.classList.remove("hidden");
      showError(`Status lookup failed: ${error.message}`);
    }
  });

  (async () => {
    try {
      state.user = await ensureUser();
      mountSidebar("command");
      loadRawKeysFromStorage();
      await loadEnvironments();
      await fetchSmsAnalysis();
    } catch (error) {
      if (!String(error.message || "").startsWith("redirect_")) {
        showError(`Startup failed: ${error.message}`);
      }
    }
  })();
})();
