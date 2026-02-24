(() => {
  const STORAGE = {
    token: "psg_auth_token",
    user: "psg_auth_user",
    expiresAt: "psg_auth_expires_at",
  };

  let noticeTimer = null;

  function parseJson(value, fallback) {
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  }

  function escapeHtml(value) {
    return String(value || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function formatDate(value) {
    if (!value) {
      return "-";
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return String(value);
    }
    return date.toLocaleString();
  }

  function getToken() {
    return localStorage.getItem(STORAGE.token) || "";
  }

  function getUser() {
    return parseJson(localStorage.getItem(STORAGE.user) || "null", null);
  }

  function getExpiresAt() {
    return localStorage.getItem(STORAGE.expiresAt) || "";
  }

  function clearSessionStorage() {
    localStorage.removeItem(STORAGE.token);
    localStorage.removeItem(STORAGE.user);
    localStorage.removeItem(STORAGE.expiresAt);
  }

  function setSession({ token, user, expiresAt }) {
    localStorage.setItem(STORAGE.token, token || "");
    localStorage.setItem(STORAGE.user, JSON.stringify(user || null));
    localStorage.setItem(STORAGE.expiresAt, expiresAt || "");
  }

  function isAdminRole(role) {
    return role === "admin" || role === "super_admin";
  }

  function isSuperAdminRole(role) {
    return role === "super_admin";
  }

  function redirectToLogin(hash = "login") {
    const safeHash = hash ? `#${hash}` : "";
    window.location.href = `/dashboard${safeHash}`;
  }

  async function request(path, options = {}) {
    const method = options.method || "GET";
    const headers = {};
    let body;

    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(options.body);
    }

    if (options.apiKey) {
      headers["x-api-key"] = options.apiKey;
    } else {
      const useAuthToken = options.useAuthToken === undefined ? true : Boolean(options.useAuthToken);
      if (useAuthToken) {
        const token = options.token !== undefined ? options.token : getToken();
        if (token) {
          headers.Authorization = `Bearer ${token}`;
        }
      }
    }

    const response = await fetch(path, {
      method,
      headers,
      body,
    });

    const json = await response.json().catch(() => ({}));
    if (!response.ok || json.ok === false) {
      const error = new Error(json.error || `http_${response.status}`);
      error.status = response.status;
      error.payload = json;
      throw error;
    }

    return json;
  }

  async function ensureUser({ requireAdmin = false } = {}) {
    const token = getToken();
    if (!token) {
      redirectToLogin();
      throw new Error("redirect_login");
    }

    try {
      const me = await request("/api/auth/me");
      setSession({
        token,
        user: me.user,
        expiresAt: getExpiresAt(),
      });

      if (requireAdmin && !isAdminRole(String(me.user?.role || ""))) {
        window.location.href = "/command-panel";
        throw new Error("redirect_forbidden");
      }

      return me.user;
    } catch (error) {
      if (String(error.message || "").startsWith("redirect_")) {
        throw error;
      }

      clearSessionStorage();
      redirectToLogin();
      throw error;
    }
  }

  async function logout() {
    try {
      if (getToken()) {
        await request("/api/auth/logout", {
          method: "POST",
        });
      }
    } catch {
      // ignore logout API errors
    }

    clearSessionStorage();
    redirectToLogin();
  }

  function showNotice(message) {
    const banner = document.getElementById("noticeBanner");
    if (!banner) {
      return;
    }

    if (!message) {
      banner.classList.add("hidden");
      return;
    }

    banner.textContent = message;
    banner.classList.remove("hidden");

    if (noticeTimer) {
      clearTimeout(noticeTimer);
    }

    noticeTimer = setTimeout(() => {
      banner.classList.add("hidden");
    }, 3600);
  }

  function showError(message) {
    const banner = document.getElementById("errorBanner");
    if (!banner) {
      return;
    }

    banner.textContent = message;
    banner.classList.remove("hidden");
  }

  function clearError() {
    const banner = document.getElementById("errorBanner");
    if (!banner) {
      return;
    }

    banner.classList.add("hidden");
  }

  function mountSidebar(activeNav) {
    const user = getUser();
    const role = String(user?.role || "user");

    const sessionBadge = document.getElementById("sessionBadge");
    if (sessionBadge) {
      if (user) {
        sessionBadge.textContent = `${user.name} (${user.email}) | ${role.replace("_", " ").toUpperCase()}`;
      } else {
        sessionBadge.textContent = "Not logged in";
      }
    }

    const navLinks = document.querySelectorAll("[data-nav]");
    navLinks.forEach((link) => {
      const navName = link.getAttribute("data-nav");
      link.classList.toggle("active", navName === activeNav);

      if (navName === "admin") {
        link.classList.toggle("hidden", !isAdminRole(role));
      }
    });

    const logoutBtn = document.getElementById("logoutBtn");
    if (logoutBtn && !logoutBtn.dataset.bound) {
      logoutBtn.addEventListener("click", () => {
        logout();
      });
      logoutBtn.dataset.bound = "true";
    }
  }

  window.PsgApp = {
    STORAGE,
    parseJson,
    escapeHtml,
    formatDate,
    request,
    getToken,
    getUser,
    getExpiresAt,
    setSession,
    clearSessionStorage,
    ensureUser,
    logout,
    showNotice,
    showError,
    clearError,
    mountSidebar,
    isAdminRole,
    isSuperAdminRole,
  };
})();
