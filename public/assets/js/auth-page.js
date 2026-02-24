(() => {
  const { request, setSession, getToken, getExpiresAt, clearSessionStorage, showNotice, showError, clearError } = window.PsgApp;

  const el = {
    registerForm: document.getElementById("registerForm"),
    loginForm: document.getElementById("loginForm"),
  };

  function getPostLoginPath(user) {
    const role = String(user?.role || "user");
    if (role === "super_admin" || role === "admin") {
      return "/super-admin-dashboard";
    }
    return "/command-panel";
  }

  function applyHashHint() {
    const hash = String(window.location.hash || "").toLowerCase();
    if (hash === "#register") {
      const input = document.getElementById("registerName");
      if (input) {
        input.focus();
      }
      return;
    }

    if (hash === "#login") {
      const input = document.getElementById("loginEmail");
      if (input) {
        input.focus();
      }
    }
  }

  async function redirectIfAuthenticated() {
    if (!getToken()) {
      return;
    }

    try {
      const me = await request("/api/auth/me");
      setSession({
        token: getToken(),
        user: me.user,
        expiresAt: getExpiresAt(),
      });
      window.location.href = getPostLoginPath(me.user);
    } catch {
      clearSessionStorage();
    }
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
      await request("/api/auth/register", {
        method: "POST",
        body: payload,
        useAuthToken: false,
      });

      showNotice("Registration completed. Login with your account.");
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
      const result = await request("/api/auth/login", {
        method: "POST",
        body: payload,
        useAuthToken: false,
      });

      setSession({
        token: result.token,
        user: result.user,
        expiresAt: result.expiresAt,
      });

      window.location.href = getPostLoginPath(result.user);
    } catch (error) {
      showError(`Login failed: ${error.message}`);
    }
  });

  redirectIfAuthenticated();
  applyHashHint();
})();
