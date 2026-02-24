(() => {
  const STORAGE = {
    token: "psg_auth_token",
    user: "psg_auth_user",
    expiresAt: "psg_auth_expires_at",
  };

  const el = {
    loadingBlock: document.getElementById("loadingBlock"),
    setupBlock: document.getElementById("setupBlock"),
    authBlock: document.getElementById("authBlock"),
    authBlockHint: document.getElementById("authBlockHint"),
    openBootstrapBtn: document.getElementById("openBootstrapBtn"),
    bootstrapForm: document.getElementById("bootstrapForm"),
    bootstrapSubmitBtn: document.getElementById("bootstrapSubmitBtn"),
    bootstrapName: document.getElementById("bootstrapName"),
    bootstrapEmail: document.getElementById("bootstrapEmail"),
    bootstrapPassword: document.getElementById("bootstrapPassword"),
    errorBanner: document.getElementById("errorBanner"),
    noticeBanner: document.getElementById("noticeBanner"),
  };

  function showError(message) {
    el.errorBanner.textContent = message;
    el.errorBanner.classList.remove("hidden");
  }

  function clearError() {
    el.errorBanner.classList.add("hidden");
  }

  function showNotice(message) {
    el.noticeBanner.textContent = message;
    el.noticeBanner.classList.remove("hidden");
  }

  function setView(view) {
    el.loadingBlock.classList.toggle("hidden", view !== "loading");
    el.setupBlock.classList.toggle("hidden", view !== "setup");
    el.authBlock.classList.toggle("hidden", view !== "auth");

    if (view !== "setup") {
      el.bootstrapForm.classList.add("hidden");
    }
  }

  async function request(path, options = {}) {
    const response = await fetch(path, {
      method: options.method || "GET",
      headers: options.body ? { "Content-Type": "application/json" } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    const json = await response.json().catch(() => ({}));
    if (!response.ok || json.ok === false) {
      const error = new Error(json.error || `http_${response.status}`);
      error.payload = json;
      throw error;
    }

    return json;
  }

  function persistSession(data) {
    localStorage.setItem(STORAGE.token, data.token || "");
    localStorage.setItem(STORAGE.user, JSON.stringify(data.user || null));
    localStorage.setItem(STORAGE.expiresAt, data.expiresAt || "");
  }

  async function loadBootstrapState() {
    clearError();
    const status = await request("/api/public/bootstrap-status");

    if (status.hasSuperAdmin) {
      setView("auth");
      el.authBlockHint.textContent = status.registrationEnabled
        ? "A super admin already exists. Continue to dashboard login or registration."
        : "A super admin already exists. Registration is disabled, so use Login to continue.";
      return;
    }

    setView("setup");
  }

  el.openBootstrapBtn.addEventListener("click", () => {
    clearError();
    el.bootstrapForm.classList.remove("hidden");
    el.bootstrapName.focus();
  });

  el.bootstrapForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearError();
    showNotice("");
    el.noticeBanner.classList.add("hidden");

    const payload = {
      name: String(el.bootstrapName.value || "").trim(),
      email: String(el.bootstrapEmail.value || "").trim(),
      password: String(el.bootstrapPassword.value || ""),
    };

    if (!payload.name || !payload.email || payload.password.length < 8) {
      showError("Enter a valid name, email, and password (min 8 chars).");
      return;
    }

    el.bootstrapSubmitBtn.disabled = true;

    try {
      const result = await request("/api/public/bootstrap-super-admin", {
        method: "POST",
        body: payload,
      });

      persistSession(result);
      showNotice("Super admin created. Redirecting...");
      window.location.href = "/super-admin-dashboard";
    } catch (error) {
      if (error.message === "super_admin_already_exists") {
        await loadBootstrapState();
      }
      showError(`Get started failed: ${error.message}`);
    } finally {
      el.bootstrapSubmitBtn.disabled = false;
    }
  });

  loadBootstrapState().catch((error) => {
    setView("auth");
    showError(`Unable to load bootstrap status: ${error.message}`);
  });
})();
