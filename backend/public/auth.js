// Auth gate: token storage, authenticated fetch wrapper, and the
// login/signup/onboarding screens that guard the rest of the app.

const TOKEN_KEY = "rekono_token";

const PLAN_NAMES = { free: "Free", starter: "Starter", growth: "Growth", business: "Business", scale: "Scale" };
const PLAN_ORDER = ["free", "starter", "growth", "business", "scale"];

// Mirrors the feature bullets shown on the marketing site / onboarding plan
// cards for each tier, so hovering the plan badge tells you what you
// actually picked without having to remember or go dig up the pricing page.
const PLAN_BENEFITS = {
  free: ["25 documents/mo", "1 seat", "Extraction + review queue", "CSV / Excel export"],
  starter: ["150 documents/mo", "1 seat", "Extraction + review queue", "CSV / Excel export", "Email support"],
  growth: ["750 documents/mo", "5 seats", "Everything in Starter", "Matching engine + full audit trail", "Priority support"],
  business: ["2,500 documents/mo", "Unlimited seats", "Everything in Growth", "Custom confidence thresholds", "Risk-based auto-approval", "Dedicated onboarding"],
  scale: ["10,000 documents/mo", "Unlimited seats", "Everything in Business", "Dedicated support channel", "Priority feature requests"],
};

// One or two letters for the top bar's account avatar. Falls back through
// full name -> email -> "?", since full_name is optional on a User and an
// avatar with nothing in it reads as a rendering bug rather than a control.
function initialsFor(user) {
  const name = (user.full_name || "").trim();
  if (name) {
    const parts = name.split(/\s+/);
    const first = parts[0][0];
    const last = parts.length > 1 ? parts[parts.length - 1][0] : "";
    return (first + last).toUpperCase();
  }
  return (user.email || "?").trim().slice(0, 1).toUpperCase() || "?";
}

// Shared by the account menu's plan badge and the Settings > Billing summary
// so the two never drift out of sync with each other.
function planSummaryText(user) {
  const planName = PLAN_NAMES[user.plan] || user.plan;
  if (user.subscription_status === "trialing" && user.trial_ends_at) {
    const daysLeft = Math.max(0, Math.ceil((new Date(user.trial_ends_at) - new Date()) / (1000 * 60 * 60 * 24)));
    return `${planName} plan — trial, ${daysLeft} day${daysLeft === 1 ? "" : "s"} left`;
  }
  return user.billing_period ? `${planName} plan (${user.billing_period})` : `${planName} plan`;
}

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
// finished (onboarding_required), a paid plan with no active subscription
// behind it (billing_required), or an upload that hit the plan's monthly
// document cap (plan_cap_reached -- billing is fine, just needs a bigger
// plan or to wait for next month, so this opens the Upgrade modal rather
// than the full-page billing-required gate the other two use).
// See plan.js/ingestion.js on the backend.
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
    } else if (body.plan_cap_reached) {
      showUpgradePromptForCapReached(body.detail);
    } else {
      showBillingRequired();
    }
    throw new Error(body.detail || "Access blocked.");
  }
  return res;
}

// ---- Stale-while-revalidate cache for the tab views (app.js's load*
// functions) ----
// Switching back to a tab already visited this session used to always
// blank it out and block on a network round trip before showing anything.
// cachedLoad renders whatever's cached for `cacheKey` immediately (if any),
// then always fetches a fresh copy in the background and re-renders only if
// the response actually changed -- so a cached render is never more than
// one round trip stale, and an unchanged response doesn't cause a
// pointless re-render (which would rebuild the DOM and rebind every event
// listener in it for nothing).
//
// Not a general response cache: it's scoped to the handful of GET views
// app.js reloads by calling the same load*() function repeatedly, and a
// mutation that changes what one of those views shows (approve/reject/
// delete an invoice, add/remove a team member, ...) calls invalidateCache()
// for its prefix right before reloading, so the view the user just acted on
// always re-fetches instead of flashing what's now stale cached data.
const apiCache = new Map();

function invalidateCache(prefix) {
  for (const key of apiCache.keys()) {
    if (key.startsWith(prefix)) apiCache.delete(key);
  }
}

async function cachedLoad(cacheKey, fetcher, render) {
  const cached = apiCache.get(cacheKey);
  if (cached !== undefined) render(cached);

  const data = await fetcher();
  const changed = cached === undefined || JSON.stringify(cached) !== JSON.stringify(data);
  apiCache.set(cacheKey, data);
  if (changed) render(data);
  return data;
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
  // Stashed for app.js's dashboard greeting -- the /api/auth/me response is
  // already fetched here on every bootstrap, so re-requesting it there just
  // to learn the user's name would be a redundant round trip.
  window.currentUser = user;
  const banner = document.getElementById("demo-mode-banner");
  if (banner) banner.style.display = user.is_demo ? "flex" : "none";
  const badge = document.getElementById("current-user-badge");
  if (badge) badge.textContent = user.full_name || user.email;

  // The account menu is collapsed behind this avatar, so it's the only thing
  // identifying the signed-in user until it's opened. Initials come off the
  // name already in hand -- no extra request, nothing to upload or store.
  const avatar = document.getElementById("topbar-avatar");
  if (avatar) avatar.textContent = initialsFor(user);

  const planBadge = document.getElementById("plan-badge");
  if (planBadge) planBadge.textContent = planSummaryText(user);

  const tooltip = document.getElementById("plan-benefits-tooltip");
  if (tooltip) {
    const planName = PLAN_NAMES[user.plan] || user.plan;
    const benefits = PLAN_BENEFITS[user.plan] || [];
    tooltip.innerHTML = `<div class="plan-tooltip-title">${planName} plan includes</div><ul>${benefits
      .map((b) => `<li>${b}</li>`)
      .join("")}</ul>`;
  }

  // Nothing to upgrade to once you're on the top self-serve tier -- Scale is
  // the ceiling, fully self-serve, no "talk to us" contact-sales path above it.
  const upgradeBtn = document.getElementById("upgrade-btn");
  if (upgradeBtn) {
    const rank = PLAN_ORDER.indexOf(user.plan);
    upgradeBtn.dataset.currentPlan = user.plan;
    upgradeBtn.style.display = rank >= 0 && rank < PLAN_ORDER.length - 1 ? "block" : "none";
  }

  const docUsage = document.getElementById("doc-usage");
  if (docUsage && user.document_cap != null && user.documents_used_this_month != null) {
    const used = user.documents_used_this_month;
    const cap = user.document_cap;
    const pct = cap > 0 ? Math.min(100, Math.round((used / cap) * 100)) : 100;
    document.getElementById("doc-usage-fill").style.width = `${pct}%`;
    document.getElementById("doc-usage-text").textContent = `${used} / ${cap} documents this month`;
    docUsage.classList.toggle("is-full", used >= cap);
    docUsage.classList.toggle("is-warning", used < cap && pct >= 90);
    docUsage.style.display = "flex";
  } else if (docUsage) {
    docUsage.style.display = "none";
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

// ---- Upgrade modal (buying a higher tier after onboarding) ----
// Shares the onboarding wizard's plan-picker markup/styling but posts to
// /api/billing/checkout instead of /api/onboarding, since personalization
// answers were already collected and the org already has a plan -- only
// tiers above the org's current one are shown, since this is strictly an
// upgrade path, not a plan-change picker.
function openUpgradeModal() {
  const currentPlan = document.getElementById("upgrade-btn").dataset.currentPlan;
  const currentRank = PLAN_ORDER.indexOf(currentPlan);
  document.querySelectorAll("#upgrade-plan-grid .onboarding-plan-card").forEach((card) => {
    card.style.display = PLAN_ORDER.indexOf(card.dataset.plan) > currentRank ? "" : "none";
  });
  document.getElementById("upgrade-error").style.display = "none";
  document.getElementById("upgrade-modal").style.display = "flex";
}

function closeUpgradeModal() {
  document.getElementById("upgrade-modal").style.display = "none";
}

// Called by apiFetch when an upload 402s with plan_cap_reached -- opens the
// same modal the account menu's Upgrade button does, with the cap-reached message
// surfaced in it, so hitting the limit leads straight to picking a bigger
// plan instead of just an error message. If there's nowhere left to upgrade
// to (already on the top tier), there's nothing useful to show here -- the
// caller's own error text is all there is to say in that case.
function showUpgradePromptForCapReached(detail) {
  const upgradeBtn = document.getElementById("upgrade-btn");
  const rank = PLAN_ORDER.indexOf(upgradeBtn?.dataset.currentPlan);
  if (rank < 0 || rank >= PLAN_ORDER.length - 1) return;

  openUpgradeModal();
  const errorEl = document.getElementById("upgrade-error");
  errorEl.textContent = detail || "You've reached your plan's document limit for this month.";
  errorEl.style.display = "block";
}

document.getElementById("upgrade-btn").addEventListener("click", openUpgradeModal);
document.getElementById("upgrade-modal-close").addEventListener("click", closeUpgradeModal);
document.getElementById("upgrade-modal").addEventListener("click", (e) => {
  if (e.target.id === "upgrade-modal") closeUpgradeModal();
});

document.querySelectorAll("#upgrade-modal .billing-toggle-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#upgrade-modal .billing-toggle-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById("upgrade-plan-grid").classList.toggle("is-annual", btn.dataset.period === "annual");
  });
});

document.querySelectorAll("#upgrade-plan-grid .onboarding-plan-card").forEach((card) => {
  card.addEventListener("click", async () => {
    const errorEl = document.getElementById("upgrade-error");
    errorEl.style.display = "none";
    const plan = card.dataset.plan;
    const billingPeriod = document.querySelector("#upgrade-modal .billing-toggle-btn.active").dataset.period;
    document.querySelectorAll("#upgrade-plan-grid .onboarding-plan-card").forEach((c) => (c.disabled = true));
    try {
      const res = await apiFetch("/api/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan, billing_period: billingPeriod }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        errorEl.textContent = body.detail || "Something went wrong.";
        errorEl.style.display = "block";
        return;
      }
      // Tells handleCheckoutReturn (below) that this checkout came from an
      // already-onboarded user upgrading, not from the onboarding wizard --
      // it should land back on the dashboard, not re-show onboarding.
      sessionStorage.setItem("rekono_checkout_context", "upgrade");
      window.location.href = body.checkout_url; // leaving the page for Stripe Checkout
    } catch (err) {
      errorEl.textContent = String(err.message || err);
      errorEl.style.display = "block";
    } finally {
      document.querySelectorAll("#upgrade-plan-grid .onboarding-plan-card").forEach((c) => (c.disabled = false));
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

// Populated from ?invite_token=... on page load, below.
let pendingInviteToken = null;

async function loadInviteDetails(token) {
  const introEl = document.getElementById("invite-intro");
  const formEl = document.getElementById("invite-accept-form");
  try {
    const res = await fetch(`/api/team/invite/${token}`);
    const body = await res.json();
    if (!res.ok) {
      introEl.textContent = body.detail || "This invite link is invalid or has expired.";
      return;
    }
    introEl.textContent = `You've been invited to join ${body.org_name} on Rekono.`;
    document.getElementById("invite-email").value = body.email;
    formEl.style.display = "flex";
  } catch (err) {
    introEl.textContent = String(err);
  }
}

document.getElementById("invite-accept-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  document.getElementById("invite-error").style.display = "none";
  const full_name = document.getElementById("invite-full-name").value.trim();
  const password = document.getElementById("invite-password").value;
  const submitBtn = e.target.querySelector("button[type=submit]");
  submitBtn.disabled = true;
  try {
    const res = await fetch(`/api/team/invite/${pendingInviteToken}/accept`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ full_name, password }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const el = document.getElementById("invite-error");
      el.textContent = body.detail || "Could not accept this invite.";
      el.style.display = "block";
      return;
    }
    setToken(body.access_token);
    await bootstrapApp();
  } catch (err) {
    const el = document.getElementById("invite-error");
    el.textContent = String(err);
    el.style.display = "block";
  } finally {
    submitBtn.disabled = false;
  }
});

document.getElementById("logout-btn").addEventListener("click", () => {
  clearToken();
  showAuthGate();
});

document.getElementById("demo-signup-btn").addEventListener("click", () => {
  clearToken();
  showAuthGate();
  showAuthPanel("auth-signup-panel", { tabBtn: document.querySelector('[data-auth-tab="signup-panel"]') });
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
    if (user.plan !== "free" && user.subscription_status !== "active" && user.subscription_status !== "trialing") {
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

  const isUpgrade = sessionStorage.getItem("rekono_checkout_context") === "upgrade";
  sessionStorage.removeItem("rekono_checkout_context");

  // An already-onboarded user upgrading via the account-menu modal should land
  // back on their dashboard, not re-see the onboarding wizard -- retries on
  // failure go through the upgrade modal's own error banner too, since its
  // plan cards post to /api/billing/checkout (this path), not /api/onboarding.
  if (isUpgrade) {
    bootstrapApp();
    if (checkoutParam === "cancelled") return;
    const sessionId = params.get("session_id");
    apiFetch(`/api/billing/confirm?session_id=${encodeURIComponent(sessionId || "")}`)
      .then((res) => res.json().then((body) => ({ ok: res.ok, body })))
      .then(({ ok, body }) => {
        if (!ok) throw new Error(body.detail || "Could not confirm payment.");
        return bootstrapApp();
      })
      .catch((err) => {
        openUpgradeModal();
        const errorEl = document.getElementById("upgrade-error");
        errorEl.textContent = String(err.message || err);
        errorEl.style.display = "block";
      });
    return;
  }

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

// Google redirects back here after /api/auth/google/callback -- either
// ?google_auth=success&code=<handoff> (exchange it for a real access token,
// never put directly in the URL by the backend -- see routes/auth.js) or
// ?google_auth=error&reason=<code> (show why and fall back to the normal
// sign-in form).
const GOOGLE_AUTH_ERROR_MESSAGES = {
  not_configured: "Google sign-in isn't set up yet. Please use email/password.",
  denied: "Google sign-in was cancelled.",
  state_mismatch: "Google sign-in failed (session expired). Please try again.",
  oauth_failed: "Google sign-in failed. Please try again.",
  email_unverified: "That Google account's email isn't verified. Please use email/password.",
};

function handleGoogleAuthReturn(status, code, reason) {
  history.replaceState(null, "", location.pathname);
  showAuthGate();

  if (status === "error") {
    authError(GOOGLE_AUTH_ERROR_MESSAGES[reason] || "Google sign-in failed. Please try again.");
    return;
  }

  fetch(`/api/auth/google/exchange?code=${encodeURIComponent(code || "")}`)
    .then((res) => res.json().then((body) => ({ ok: res.ok, body })))
    .then(({ ok, body }) => {
      if (!ok) throw new Error(body.detail || "Could not complete Google sign-in.");
      setToken(body.access_token);
      return bootstrapApp();
    })
    .catch((err) => {
      authError(String(err.message || err));
    });
}

// The marketing site's "View live demo" link sends visitors here with
// ?demo=1 -- no signup, no OAuth round trip, just a same-origin POST that
// spins up a freshly seeded demo org (routes/demo.js) and logs straight
// into it. Same "show the gate while it settles" shape as
// handleGoogleAuthReturn above, just with nothing to exchange since the
// token comes back directly in the POST response.
function handleDemoLogin() {
  history.replaceState(null, "", location.pathname);
  showAuthGate();

  fetch("/api/demo/login", { method: "POST" })
    .then((res) => res.json().then((body) => ({ ok: res.ok, body })))
    .then(({ ok, body }) => {
      if (!ok) throw new Error(body.detail || "Could not start the demo. Please try again.");
      setToken(body.access_token);
      return bootstrapApp();
    })
    .catch((err) => {
      authError(String(err.message || err));
    });
}

// QuickBooks redirects back here after /api/integrations/quickbooks/callback
// -- either ?quickbooks=connected or ?quickbooks=error&reason=<code>. Unlike
// Google/Stripe's redirects above, this one always happens to an
// already-logged-in session (connecting QuickBooks is a settings action, not
// part of signing in), so there's no token/code to hand off here -- just
// re-confirm the existing session and land back on the Settings tab where
// the user started.
const QUICKBOOKS_ERROR_MESSAGES = {
  state_mismatch: "QuickBooks connection failed (session expired). Please try again.",
  denied: "QuickBooks connection was cancelled.",
  oauth_failed: "QuickBooks connection failed. Please try again.",
};

function handleQuickbooksReturn(status, reason) {
  history.replaceState(null, "", location.pathname);
  bootstrapApp().then(() => {
    if (typeof switchTab !== "function") return;
    switchTab("settings");
    const statusEl = document.getElementById("settings-quickbooks-status");
    if (!statusEl) return;
    statusEl.textContent =
      status === "connected" ? "QuickBooks connected." : QUICKBOOKS_ERROR_MESSAGES[reason] || "QuickBooks connection failed. Please try again.";
  });
}

// A reset link takes priority over any existing session -- someone who
// clicked it clearly wants to set a new password, not silently land back in
// an already-logged-in app. Strip the token from the visible URL/history
// right away so it doesn't linger in the address bar or browser history.
const resetTokenFromUrl = new URLSearchParams(location.search).get("reset_token");
const inviteTokenFromUrl = new URLSearchParams(location.search).get("invite_token");
const checkoutParam = new URLSearchParams(location.search).get("checkout");
const googleAuthParam = new URLSearchParams(location.search).get("google_auth");
const quickbooksParam = new URLSearchParams(location.search).get("quickbooks");
const demoParam = new URLSearchParams(location.search).get("demo");
if (resetTokenFromUrl) {
  pendingResetToken = resetTokenFromUrl;
  history.replaceState(null, "", location.pathname);
  showAuthGate();
  showAuthPanel("auth-reset-panel");
} else if (inviteTokenFromUrl) {
  // Same reasoning as a reset link: someone who clicked an invite clearly
  // wants to accept it, even if this browser happens to have an unrelated
  // session already logged in.
  pendingInviteToken = inviteTokenFromUrl;
  history.replaceState(null, "", location.pathname);
  showAuthGate();
  showAuthPanel("auth-invite-panel");
  loadInviteDetails(inviteTokenFromUrl);
} else if (checkoutParam === "success" || checkoutParam === "cancelled") {
  handleCheckoutReturn(checkoutParam);
} else if (googleAuthParam === "success" || googleAuthParam === "error") {
  const params = new URLSearchParams(location.search);
  handleGoogleAuthReturn(googleAuthParam, params.get("code"), params.get("reason"));
} else if (quickbooksParam === "connected" || quickbooksParam === "error") {
  handleQuickbooksReturn(quickbooksParam, new URLSearchParams(location.search).get("reason"));
} else if (demoParam === "1") {
  handleDemoLogin();
} else {
  bootstrapApp();
}
