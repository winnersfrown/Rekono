// Auth gate: token storage, authenticated fetch wrapper, and the
// login/signup screen that guards the rest of the app.

const TOKEN_KEY = "rekono_token";

function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

function setToken(token) {
  localStorage.setItem(TOKEN_KEY, token);
}

function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

// Drop-in replacement for fetch() that attaches the bearer token and
// bounces back to the login screen on a 401 (expired/invalid token).
async function apiFetch(url, options = {}) {
  const token = getToken();
  const headers = new Headers(options.headers || {});
  if (token) headers.set("Authorization", `Bearer ${token}`);

  const res = await fetch(url, { ...options, headers });
  if (res.status === 401) {
    clearToken();
    showAuthGate();
    throw new Error("Session expired. Please sign in again.");
  }
  return res;
}

function showAuthGate() {
  document.getElementById("auth-gate").style.display = "flex";
  document.getElementById("app-shell").style.display = "none";
}

function showApp(user) {
  document.getElementById("auth-gate").style.display = "none";
  document.getElementById("app-shell").style.display = "block";
  const badge = document.getElementById("current-user-badge");
  if (badge) badge.textContent = user.full_name || user.email;
}

function authError(message) {
  const el = document.getElementById("auth-error");
  el.textContent = message;
  el.style.display = message ? "block" : "none";
}

document.getElementById("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  authError("");
  const email = document.getElementById("login-email").value.trim();
  const password = document.getElementById("login-password").value;
  try {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      authError(err.detail || "Sign in failed.");
      return;
    }
    const data = await res.json();
    setToken(data.access_token);
    await bootstrapApp();
  } catch (err) {
    authError(String(err));
  }
});

document.getElementById("signup-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  authError("");
  const org_name = document.getElementById("signup-org").value.trim();
  const full_name = document.getElementById("signup-name").value.trim();
  const email = document.getElementById("signup-email").value.trim();
  const password = document.getElementById("signup-password").value;
  try {
    const res = await fetch("/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ org_name, full_name, email, password }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      authError(err.detail || "Sign up failed.");
      return;
    }
    const data = await res.json();
    setToken(data.access_token);
    await bootstrapApp();
  } catch (err) {
    authError(String(err));
  }
});

document.querySelectorAll(".auth-tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".auth-tab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".auth-panel").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(`auth-${btn.dataset.authTab}`).classList.add("active");
    authError("");
  });
});

document.getElementById("logout-btn").addEventListener("click", () => {
  clearToken();
  showAuthGate();
});

// Verifies any stored token against the API and shows the right screen.
// Exposed globally so app.js can call it once (init) rather than duplicating
// the same "am I logged in" check.
async function bootstrapApp() {
  const token = getToken();
  if (!token) {
    showAuthGate();
    return;
  }
  try {
    const res = await fetch("/api/auth/me", { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      clearToken();
      showAuthGate();
      return;
    }
    const user = await res.json();
    showApp(user);
    if (typeof onAuthenticated === "function") onAuthenticated();
  } catch {
    showAuthGate();
  }
}

bootstrapApp();
