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

// Drop-in replacement for fetch() that attaches the bearer token, bounces
// back to the login screen on a 401 (expired/invalid token), and shows the
// trial-expired screen on a 402 (trial ran out mid-session).
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
  if (res.status === 402) {
    showTrialExpired();
    throw new Error("Trial expired.");
  }
  return res;
}

function showAuthGate() {
  document.getElementById("auth-gate").style.display = "flex";
  document.getElementById("trial-expired").style.display = "none";
  document.getElementById("app-shell").style.display = "none";
}

function showTrialExpired() {
  document.getElementById("auth-gate").style.display = "none";
  document.getElementById("trial-expired").style.display = "flex";
  document.getElementById("app-shell").style.display = "none";
}

function showApp(user) {
  document.getElementById("auth-gate").style.display = "none";
  document.getElementById("trial-expired").style.display = "none";
  document.getElementById("app-shell").style.display = "block";
  const badge = document.getElementById("current-user-badge");
  if (badge) badge.textContent = user.full_name || user.email;

  const trialBadge = document.getElementById("trial-badge");
  if (trialBadge) {
    const days = user.trial_days_remaining;
    trialBadge.textContent = days === 1 ? "1 day left in trial" : `${days} days left in trial`;
    trialBadge.classList.toggle("trial-badge-warn", days <= 3);
  }
}

function authError(message) {
  const el = document.getElementById("auth-error");
  el.textContent = message;
  el.style.display = message ? "block" : "none";
}

function authSuccess(message) {
  const el = document.getElementById("auth-success");
  el.textContent = message;
  el.style.display = message ? "block" : "none";
}

// Forgot/reset live outside the Sign in / Create account tab pair -- reached
// via a link (forgot) or a one-off emailed URL (reset), not the tab bar --
// so switching to them also hides the tab bar rather than trying to make it
// track a third/fourth "active" state.
function showAuthPanel(panelId, { tabBtn } = {}) {
  document.querySelectorAll(".auth-tab-btn").forEach((b) => b.classList.remove("active"));
  document.querySelectorAll(".auth-panel").forEach((p) => p.classList.remove("active"));
  document.getElementById(panelId).classList.add("active");
  if (tabBtn) tabBtn.classList.add("active");
  document.querySelector(".auth-tabs").style.display = tabBtn ? "flex" : "none";
  authError("");
  authSuccess("");
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
  btn.addEventListener("click", () => showAuthPanel(`auth-${btn.dataset.authTab}`, { tabBtn: btn }));
});

document.getElementById("forgot-password-link").addEventListener("click", (e) => {
  e.preventDefault();
  showAuthPanel("auth-forgot-panel");
});

document.getElementById("forgot-back-link").addEventListener("click", (e) => {
  e.preventDefault();
  showAuthPanel("auth-login-panel", { tabBtn: document.querySelector('[data-auth-tab="login-panel"]') });
});

document.getElementById("forgot-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  authError("");
  authSuccess("");
  const email = document.getElementById("forgot-email").value.trim();
  const submitBtn = e.target.querySelector("button[type=submit]");
  submitBtn.disabled = true;
  try {
    const res = await fetch("/api/auth/forgot-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok) {
      authSuccess(body.detail || "If an account exists for that email, we've sent password reset instructions.");
      e.target.reset();
    } else {
      authError(body.detail || "Something went wrong.");
    }
  } catch (err) {
    authError(String(err));
  } finally {
    submitBtn.disabled = false;
  }
});

// Populated from ?reset_token=... on page load, below -- present only when
// the user arrived via the link from a reset-password email.
let pendingResetToken = null;

document.getElementById("reset-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  authError("");
  const password = document.getElementById("reset-password").value;
  const submitBtn = e.target.querySelector("button[type=submit]");
  submitBtn.disabled = true;
  try {
    const res = await fetch("/api/auth/reset-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: pendingResetToken, password }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      authError(body.detail || "Could not reset your password.");
      return;
    }
    setToken(body.access_token);
    await bootstrapApp();
  } catch (err) {
    authError(String(err));
  } finally {
    submitBtn.disabled = false;
  }
});

document.getElementById("logout-btn").addEventListener("click", () => {
  clearToken();
  showAuthGate();
});

document.getElementById("trial-expired-logout-btn").addEventListener("click", () => {
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
    if (user.trial_expired) {
      showTrialExpired();
      return;
    }
    showApp(user);
    if (typeof onAuthenticated === "function") onAuthenticated();
  } catch {
    showAuthGate();
  }
}

// A reset link takes priority over any existing session -- someone who
// clicked it clearly wants to set a new password, not silently land back in
// an already-logged-in app. Strip the token from the visible URL/history
// right away so it doesn't linger in the address bar or browser history.
const resetTokenFromUrl = new URLSearchParams(location.search).get("reset_token");
if (resetTokenFromUrl) {
  pendingResetToken = resetTokenFromUrl;
  history.replaceState(null, "", location.pathname);
  showAuthGate();
  showAuthPanel("auth-reset-panel");
} else {
  bootstrapApp();
}
