// Minimal wrapper around GA4's gtag.js -- kept to one place so every call
// site (main.jsx's init, every CTA's click handler below) agrees on what's
// safe to call before the script has loaded, and so switching analytics
// providers later only means changing this file, not every component that
// tracks something.
//
// Off entirely unless VITE_GA_MEASUREMENT_ID is set at build time (Vercel
// project settings -> Environment Variables) -- same "missing config
// degrades to a no-op" pattern as every other optional integration in this
// app (Resend, Stripe, ...), not a crash or a build failure. No analytics
// account exists yet; this just makes wiring one up a config change, not a
// code change.
const GA_ID = import.meta.env.VITE_GA_MEASUREMENT_ID;

export function initAnalytics() {
  if (!GA_ID || typeof document === "undefined") return;

  window.dataLayer = window.dataLayer || [];
  function gtag() {
    window.dataLayer.push(arguments);
  }
  window.gtag = gtag;

  const script = document.createElement("script");
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${GA_ID}`;
  document.head.appendChild(script);

  gtag("js", new Date());
  // beacon transport: every trackEvent() call below fires from a CTA click
  // that immediately navigates the tab away (that's the whole point of a
  // CTA) -- without this, the event request racing that navigation is
  // exactly the kind of thing browsers cancel mid-flight.
  gtag("config", GA_ID, { transport_type: "beacon" });
}

// Safe to call whether or not analytics is configured or has finished
// loading -- every call site below calls this unconditionally rather than
// checking GA_ID or window.gtag itself first.
export function trackEvent(name, params = {}) {
  if (typeof window === "undefined" || typeof window.gtag !== "function") return;
  window.gtag("event", name, params);
}
