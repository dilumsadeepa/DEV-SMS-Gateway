(() => {
  const {
    ensureUser,
    mountSidebar,
    showNotice,
    showError,
    clearError,
    escapeHtml,
    formatDate,
  } = window.PsgApp;

  const MAX_ITEMS = 300;
  const MAX_CHAT_ITEMS = 400;

  const state = {
    socket: null,
    matched: [],
    events: [],
    chatItems: [],
    clockTimer: null,
  };

  const el = {
    simConnectionBadge: document.getElementById("simConnectionBadge"),
    simPin: document.getElementById("simPin"),
    simDeviceId: document.getElementById("simDeviceId"),
    simDeviceName: document.getElementById("simDeviceName"),
    simMobileFilter: document.getElementById("simMobileFilter"),
    simAutoAcknowledge: document.getElementById("simAutoAcknowledge"),
    simConnectBtn: document.getElementById("simConnectBtn"),
    simDisconnectBtn: document.getElementById("simDisconnectBtn"),
    simClearBtn: document.getElementById("simClearBtn"),
    simThemeToggle: document.getElementById("simThemeToggle"),
    simPhoneFrame: document.getElementById("simPhoneFrame"),
    simPhoneClock: document.getElementById("simPhoneClock"),
    simHeaderName: document.getElementById("simHeaderName"),
    simHeaderState: document.getElementById("simHeaderState"),
    simMatchedCount: document.getElementById("simMatchedCount"),
    simMatchedList: document.getElementById("simMatchedList"),
    simChatMessages: document.getElementById("simChatMessages"),
    simEvents: document.getElementById("simEvents"),
    chatCloseBtn: document.querySelector(".chat-close-btn"),
  };

  function normalizeNumber(value) {
    return String(value || "").trim().replace(/\s+/g, "");
  }

  function parseRecipientList(value) {
    if (Array.isArray(value)) {
      return value.map((item) => normalizeNumber(item)).filter(Boolean);
    }

    if (typeof value === "string") {
      return value
        .split(",")
        .map((item) => normalizeNumber(item))
        .filter(Boolean);
    }

    return [];
  }

  function parseMobileFilters() {
    return parseRecipientList(el.simMobileFilter.value);
  }

  function buildSocketUrl() {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const query = new URLSearchParams({
      pin: String(el.simPin.value || "").trim(),
      deviceId: String(el.simDeviceId.value || "").trim(),
      deviceName: String(el.simDeviceName.value || "").trim(),
      appVersion: "web-simulator-1.0",
    });

    return `${protocol}//${window.location.host}/ws/device?${query.toString()}`;
  }

  function setConnectionBadge(status, text) {
    el.simConnectionBadge.textContent = text;
    el.simConnectionBadge.className = `status-pill ${status}`;
    el.simHeaderState.textContent = text;
  }

  function pushEvent(label, payload) {
    const timestamp = new Date().toISOString();
    const serialized = payload !== undefined ? ` ${JSON.stringify(payload)}` : "";
    state.events.unshift(`[${timestamp}] ${label}${serialized}`);
    if (state.events.length > MAX_ITEMS) {
      state.events.length = MAX_ITEMS;
    }
    el.simEvents.textContent = state.events.join("\n");
  }

  function renderActivityLists() {
    el.simMatchedCount.textContent = String(state.matched.length);

    el.simMatchedList.innerHTML = state.matched.length
      ? state.matched
          .map((item) => `
            <article class="sim-list-item">
              <strong>${escapeHtml(item.requestId)}</strong>
              <div>${escapeHtml(formatDate(item.at))}</div>
              <div>Matched: ${escapeHtml(item.matchedRecipients.join(", "))}</div>
              <div>${escapeHtml(item.message)}</div>
            </article>
          `)
          .join("")
      : '<p class="muted">No matched messages.</p>';
  }

  function addChatMessage(direction, text, meta = "") {
    state.chatItems.push({
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      at: new Date().toISOString(),
      direction,
      text: String(text || ""),
      meta: String(meta || ""),
    });

    if (state.chatItems.length > MAX_CHAT_ITEMS) {
      state.chatItems.shift();
    }

    renderChatMessages();
  }

  function renderChatMessages() {
    if (!state.chatItems.length) {
      el.simChatMessages.innerHTML = '<div class="chat-placeholder">Waiting for incoming SMS...</div>';
      return;
    }

    el.simChatMessages.innerHTML = state.chatItems
      .map((item) => `
        <div class="chat-row ${escapeHtml(item.direction)}">
          <div class="chat-bubble">${escapeHtml(item.text)}</div>
          <div class="chat-meta">${escapeHtml(item.meta || formatDate(item.at))}</div>
        </div>
      `)
      .join("");

    el.simChatMessages.scrollTop = el.simChatMessages.scrollHeight;
  }

  function renderAll() {
    renderActivityLists();
    renderChatMessages();
  }

  function pushMatchedMessage(item) {
    state.matched.unshift(item);
    if (state.matched.length > MAX_ITEMS) {
      state.matched.length = MAX_ITEMS;
    }
    renderAll();
  }

  function sendSocketPayload(payload) {
    if (!state.socket || state.socket.readyState !== WebSocket.OPEN) {
      return;
    }

    state.socket.send(JSON.stringify(payload));
    pushEvent("OUT", payload);
  }

  function shouldAutoAcknowledge() {
    return Boolean(el.simAutoAcknowledge.checked);
  }

  function acknowledgeMatched(requestId, matchedRecipients) {
    if (!shouldAutoAcknowledge()) {
      return;
    }

    matchedRecipients.forEach((recipient) => {
      sendSocketPayload({
        type: "sms_status",
        requestId,
        status: "sent",
        recipient,
        to: recipient,
        timestamp: new Date().toISOString(),
      });
    });

    sendSocketPayload({
      type: "sms_result",
      requestId,
      success: true,
    });

    addChatMessage(
      "outgoing",
      `Delivered (${matchedRecipients.length} recipient${matchedRecipients.length > 1 ? "s" : ""})`,
      `req ${requestId.slice(0, 8)}`
    );
  }

  function acknowledgeIgnored(requestId, reason) {
    if (!shouldAutoAcknowledge()) {
      return;
    }

    sendSocketPayload({
      type: "sms_result",
      requestId,
      success: false,
      error: reason || "no_recipient_match_for_simulator_mobile",
    });
  }

  function applyMobileFilter(recipients) {
    const filters = parseMobileFilters();
    if (!filters.length) {
      return recipients;
    }

    const allowed = new Set(filters.map((item) => normalizeNumber(item)));
    return recipients.filter((recipient) => allowed.has(normalizeNumber(recipient)));
  }

  function handleSendSms(payload) {
    const requestId = String(payload.requestId || "").trim() || `local-${Date.now()}`;
    const recipients = parseRecipientList(payload.to);
    const message = String(payload.message || "");
    const matchedRecipients = applyMobileFilter(recipients);
    const filterText = parseMobileFilters().join(", ");

    if (matchedRecipients.length === 0 && parseMobileFilters().length > 0) {
      const reason = `No recipient matches device mobile filter (${filterText}).`;
      pushEvent("IGNORED send_sms", { requestId, recipients, reason });
      acknowledgeIgnored(requestId, "no_recipient_match_for_simulator_mobile");
      return;
    }

    pushMatchedMessage({
      at: new Date().toISOString(),
      requestId,
      recipients,
      matchedRecipients,
      message,
    });
    pushEvent("ACCEPTED send_sms", { requestId, recipients, matchedRecipients });
    addChatMessage(
      "incoming",
      message || "(empty message)",
      `${matchedRecipients.join(", ")}`
    );
    acknowledgeMatched(requestId, matchedRecipients.length ? matchedRecipients : recipients);
  }

  function closeSocket() {
    if (!state.socket) {
      setConnectionBadge("warn", "disconnected");
      return;
    }

    const currentSocket = state.socket;
    state.socket = null;

    if (
      currentSocket.readyState === WebSocket.OPEN
      || currentSocket.readyState === WebSocket.CONNECTING
    ) {
      currentSocket.close(1000, "manual_disconnect");
    }

    setConnectionBadge("warn", "disconnected");
    pushEvent("Socket disconnected");
    addChatMessage("system", "Disconnected from gateway.");
  }

  function connectSocket() {
    clearError();

    const pin = String(el.simPin.value || "").trim();
    const deviceId = String(el.simDeviceId.value || "").trim();
    const deviceName = String(el.simDeviceName.value || "").trim();

    if (!pin || !deviceId || !deviceName) {
      showError("PIN, Device ID, and Device Name are required.");
      return;
    }

    closeSocket();

    const socketUrl = buildSocketUrl();
    pushEvent("Connecting", { socketUrl });
    setConnectionBadge("warn", "connecting");

    const socket = new WebSocket(socketUrl);
    state.socket = socket;

    socket.addEventListener("open", () => {
      if (state.socket !== socket) {
        return;
      }
      setConnectionBadge("ok", "connected");
      showNotice(`Connected as ${deviceName} on PIN ${pin}.`);
      pushEvent("Socket connected");
      addChatMessage("system", `Connected as ${deviceName}`, `PIN ${pin}`);
    });

    socket.addEventListener("message", (event) => {
      let payload = null;
      try {
        payload = JSON.parse(String(event.data || ""));
      } catch {
        pushEvent("IN(raw)", String(event.data || ""));
        return;
      }

      pushEvent("IN", payload);

      if (payload.type === "registered") {
        showNotice(`Registered with server for PIN ${pin}.`);
        addChatMessage("system", "Device registered on server.", `PIN ${pin}`);
        return;
      }

      if (payload.type === "send_sms") {
        handleSendSms(payload);
      }
    });

    socket.addEventListener("error", () => {
      if (state.socket === socket) {
        setConnectionBadge("err", "error");
      }
      showError("WebSocket error. Check PIN or connection.");
      pushEvent("Socket error");
      addChatMessage("system", "Socket error. Check PIN or connection.");
    });

    socket.addEventListener("close", (event) => {
      if (state.socket === socket) {
        state.socket = null;
        setConnectionBadge("warn", "disconnected");
      }
      pushEvent("Socket closed", { code: event.code, reason: event.reason || "" });
      addChatMessage("system", `Socket closed (${event.code})`, event.reason || "no reason");
    });
  }

  function clearMessages() {
    state.matched = [];
    state.events = [];
    state.chatItems = [];
    renderAll();
    el.simEvents.textContent = "";
    showNotice("Simulator messages cleared.");
  }

  function applyTheme() {
    const dark = Boolean(el.simThemeToggle.checked);
    el.simPhoneFrame.classList.toggle("dark", dark);
  }

  function updateClock() {
    const now = new Date();
    el.simPhoneClock.textContent = now.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  }

  function startClock() {
    updateClock();
    if (state.clockTimer) {
      clearInterval(state.clockTimer);
    }
    state.clockTimer = setInterval(updateClock, 1000);
  }

  function preloadFromQuery() {
    const params = new URLSearchParams(window.location.search);
    const pin = String(params.get("pin") || "").trim();
    const mobile = String(params.get("mobile") || "").trim();
    const deviceId = String(params.get("deviceId") || "").trim();
    const deviceName = String(params.get("deviceName") || "").trim();

    if (pin) {
      el.simPin.value = pin;
    }
    if (mobile) {
      el.simMobileFilter.value = mobile;
    }
    el.simDeviceId.value = deviceId || `web-sim-${Date.now().toString(36)}`;
    el.simDeviceName.value = deviceName || "Web Simulator";
    el.simHeaderName.textContent = el.simDeviceName.value;
  }

  el.simConnectBtn.addEventListener("click", () => {
    el.simHeaderName.textContent = String(el.simDeviceName.value || "Web Simulator").trim() || "Web Simulator";
    connectSocket();
  });

  el.simDisconnectBtn.addEventListener("click", () => {
    closeSocket();
  });

  el.simClearBtn.addEventListener("click", () => {
    clearMessages();
  });

  el.simThemeToggle.addEventListener("change", () => {
    applyTheme();
  });

  if (el.chatCloseBtn) {
    el.chatCloseBtn.addEventListener("click", () => {
      window.close();
    });
  }

  window.addEventListener("beforeunload", () => {
    closeSocket();
  });

  (async () => {
    try {
      await ensureUser();
      mountSidebar("simulator");
      preloadFromQuery();
      renderAll();
      applyTheme();
      startClock();
      setConnectionBadge("warn", "disconnected");
    } catch (error) {
      if (!String(error.message || "").startsWith("redirect_")) {
        showError(`Startup failed: ${error.message}`);
      }
    }
  })();
})();
