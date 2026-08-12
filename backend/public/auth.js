// Auth gate: token storage, authenticated fetch wrapper, and the
// login/signup/onboarding screens that guard the rest of the app.

const TOKEN_KEY = "rekono_token";

const PLAN_NAMES = { free: "Free", starter: "Starter", growth: "Growth", business: "Business" };

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
// back to the login screen on a 401 (expired/invalid token), and on a 402
// routes to whichever screen actually applies -- onboarding was never
// finished (onboarding_required) vs. a paid plan with no active
// subscription behind it (billing_required). See plan.js on the backend.
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
    const body = await res
      .clone()
      .json()
      .catch(() => ({}));
    if (body.onboarding_required) {
      showOnboarding();
    } else {
      showBillingRequired();
    }
    throw new Error(body.detail || "Access blocked.");
  }
  return res;
}

function showAuthGate() {
  document.getElementById("auth-gate").style.display = "flex";
  document.getElementById("onboarding-gate").style.display = "none";
  document.getElementById("billing-required").style.display = "none";
  document.getElementById("app-shell").style.display = "none";
}

function showOnboarding() {
  document.getElementById("auth-gate").style.display = "none";
  document.getElementById("onboarding-gate").style.display = "flex";
  document.getElementById("billing-required").style.display = "none";
  document.getElementById("app-shell").style.display = "none";
}

function showBillingRequired() {
  document.getElementById("auth-gate").style.display = "none";
  document.getElementById("onboarding-gate").style.display = "none";
  document.getElementById("billing-required").style.display = "flex";
  document.getElementById("app-shell").style.display = "none";
}

function showApp(user) {
  document.getElementById("auth-gate").style.display = "none";
  document.getElementById("onboarding-gate").style.display = "none";
  document.getElementById("billing-required").style.display = "none";
  document.getElementById("app-shell").style.display = "block";
  const badge = document.getElementById("current-user-badge");
  if (badge) badge.textContent = user.full_name || user.email;

  const planBadge = document.getElementById("plan-badge");
  if (planBadge) {
    const planName = PLAN_NAMES[user.plan] || user.plan;
    planBadge.textContent = user.billing_period ? `${planName} plan (${user.billing_period})` : `${planName} plan`;
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
  const passwordConfirm = document.getElementById("signup-password-confirm").value;
  if (password !== passwordConfirm) {
    authError("Passwords do not match.");
    return;
  }
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

// ---- Onboarding wizard (personalization -> plan choice) ----
// Personalization answers live in memory only until the plan step submits
// them together with the plan choice in one call -- there's no draft-saving
// endpoint, since the whole point is this is a single short wizard, not a
// multi-session form.
let onboardingAnswers = null;

function showOnboardingStep(stepId) {
  document.querySelectorAll(".onboarding-step").forEach((s) => s.classList.remove("active"));
  document.getElementById(stepId).classList.add("active");
  document.getElementById("onboarding-error").style.display = "none";
}

document.getElementById("onboarding-personalize-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const formData = new FormData(e.target);
  onboardingAnswers = {
    role: formData.get("role"),
    company_size: formData.get("company_size"),
    primary_use_case: formData.get("primary_use_case"),
    monthly_invoice_volume: formData.get("monthly_invoice_volume"),
  };
  showOnboardingStep("onboarding-step-plan");
});

document.getElementById("onboarding-back-btn").addEventListener("click", () => {
  showOnboardingStep("onboarding-step-personalize");
});

document.querySelectorAll("#onboarding-step-plan .billing-toggle-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#onboarding-step-plan .billing-toggle-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById("onboarding-plan-grid").classList.toggle("is-annual", btn.dataset.period === "annual");
  });
});

document.querySelectorAll(".onboarding-plan-card").forEach((card) => {
  card.addEventListener("click", async () => {
    const errorEl = document.getElementById("onboarding-error");
    errorEl.style.display = "none";

    // Nothing to submit if step 1 was somehow skipped (shouldn't be
    // reachable through the UI, but the plan step has no other guard against
    // it) -- send back to fill it in rather than posting blank answers.
    if (!onboardingAnswers) {
      showOnboardingStep("onboarding-step-personalize");
      return;
    }

    const plan = card.dataset.plan;
    const billingPeriod = document.querySelector("#onboarding-step-plan .billing-toggle-btn.active").dataset.period;
    document.querySelectorAll(".onboarding-plan-card").forEach((c) => (c.disabled = true));
    try {
      const res = await apiFetch("/api/onboarding", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...onboardingAnswers, plan, billing_period: billingPeriod }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        errorEl.textContent = body.detail || "Something went wrong.";
        errorEl.style.display = "block";
        return;
      }
      if (body.checkout_required) {
        window.location.href = body.checkout_url; // leaving the page for Stripe Checkout
        return;
      }
      await bootstrapApp();
    } catch (err) {
      errorEl.textContent = String(err.message || err);
      errorEl.style.display = "block";
    } finally {
      document.querySelectorAll(".onboarding-plan-card").forEach((c) => (c.disabled = false));
    }
  });
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

document.getElementById("billing-required-logout-btn").addEventListener("click", () => {
  clearToken();
  showAuthGate();
});

document.getElementById("billing-required-manage-btn").addEventListener("click", async () => {
  const el = document.getElementById("billing-required-error");
  el.style.display = "none";
  try {
    const res = await apiFetch("/api/billing/portal");
    const body = await res.json();
    if (!res.ok) throw new Error(body.detail || "Could not open billing management.");
    window.location.href = body.url;
  } catch (err) {
    el.textContent = String(err.message || err);
    el.style.display = "block";
  }
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
    if (!user.onboarding_completed) {
      showOnboarding();
      return;
    }
    if (user.plan !== "free" && user.subscription_status !== "active") {
      showBillingRequired();
      return;
    }
    showApp(user);
    if (typeof onAuthenticated === "function") onAuthenticated();
  } catch {
    showAuthGate();
  }
}

// Stripe redirects back here after Checkout. "success" needs the backend to
// actually confirm the session -- the URL alone isn't proof of payment --
// before treating the plan as active; "cancelled" just returns to the plan
// step, since personalization was already saved server-side before the
// redirect to Stripe happened, so there's nothing to re-ask.
function handleCheckoutReturn(checkoutParam) {
  const params = new URLSearchParams(location.search);
  history.replaceState(null, "", location.pathname);
  showOnboarding();
  showOnboardingStep("onboarding-step-plan");
  const errorEl = document.getElementById("onboarding-error");

  if (checkoutParam === "cancelled") {
    errorEl.textContent = "Payment was cancelled. Choose a plan to continue, or pick Free for now.";
    errorEl.style.display = "block";
    return;
  }

  const sessionId = params.get("session_id");
  document.querySelectorAll(".onboarding-plan-card").forEach((c) => (c.disabled = true));
  errorEl.textContent = "Confirming your payment…";
  errorEl.style.display = "block";
  apiFetch(`/api/billing/confirm?session_id=${encodeURIComponent(sessionId || "")}`)
    .then((res) => res.json().then((body) => ({ ok: res.ok, body })))
    .then(({ ok, body }) => {
      if (!ok) throw new Error(body.detail || "Could not confirm payment.");
      return bootstrapApp();
    })
    .catch((err) => {
      errorEl.textContent = String(err.message || err);
      document.querySelectorAll(".onboarding-plan-card").forEach((c) => (c.disabled = false));
    });
}

// A reset link takes priority over any existing session -- someone who
// clicked it clearly wants to set a new password, not silently land back in
// an already-logged-in app. Strip the token from the visible URL/history
// right away so it doesn't linger in the address bar or browser history.
const resetTokenFromUrl = new URLSearchParams(location.search).get("reset_token");
const checkoutParam = new URLSearchParams(location.search).get("checkout");
if (resetTokenFromUrl) {
  pendingResetToken = resetTokenFromUrl;
  history.replaceState(null, "", location.pathname);
  showAuthGate();
  showAuthPanel("auth-reset-panel");
} else if (checkoutParam === "success" || checkoutParam === "cancelled") {
  handleCheckoutReturn(checkoutParam);
} else {
  bootstrapApp();
}
