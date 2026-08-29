import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { APP_URL } from "../lib/constants.js";
import { trackEvent } from "../lib/analytics.js";
import Logomark from "./Logomark.jsx";

const LINKS = [
  { href: "#the-month", label: "The month" },
  { href: "#ledger", label: "Ledger" },
  { href: "#pricing", label: "Pricing" },
  { href: "#faq", label: "FAQ" },
];

export default function Nav() {
  // The header is on the page ground the whole way down; what changes on
  // scroll is only whether it carries a rule under it. Over the hero
  // there's nothing to separate from yet, so there's no rule. The previous
  // version swapped in a blurred glass bar here -- that read as a floating
  // consumer app, which is exactly what this identity is not.
  const [scrolled, setScrolled] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // A visit to any #anchor link should close the mobile drawer, same as
  // clicking a link normally would navigate away from an open menu.
  useEffect(() => {
    if (!mobileOpen) return;
    const close = () => setMobileOpen(false);
    window.addEventListener("hashchange", close);
    return () => window.removeEventListener("hashchange", close);
  }, [mobileOpen]);

  return (
    <header
      className={`sticky top-0 z-40 bg-paper transition-colors duration-200 ${
        scrolled || mobileOpen ? "border-b border-rule" : "border-b border-transparent"
      }`}
    >
      <div className="mx-auto flex max-w-content items-center justify-between gap-lg px-lg py-md md:px-xl">
        <a href="#top" className="flex items-center gap-sm font-display text-[1.15rem] font-bold text-ink">
          <Logomark className="h-[26px] w-[26px]" />
          Rekono
        </a>

        <nav className="hidden items-center gap-xl text-[0.92rem] text-ink-soft md:flex">
          {LINKS.map((l) => (
            <a key={l.href} href={l.href} className="transition-colors hover:text-accent-text">
              {l.label}
            </a>
          ))}
        </nav>

        <div className="hidden items-center gap-md md:flex">
          <a
            href={APP_URL}
            onClick={() => trackEvent("cta_click", { cta: "nav_sign_in" })}
            className="text-[0.92rem] font-medium text-ink-soft transition-colors hover:text-ink"
          >
            Sign in
          </a>
          <a
            href={APP_URL}
            onClick={() => trackEvent("cta_click", { cta: "nav_get_started" })}
            className="btn-primary px-lg py-sm text-[0.9rem]"
          >
            Get started
          </a>
        </div>

        <button
          type="button"
          aria-label="Toggle menu"
          aria-expanded={mobileOpen}
          onClick={() => setMobileOpen((v) => !v)}
          className="flex h-9 w-9 items-center justify-center rounded text-ink md:hidden"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
            {mobileOpen ? <path d="M6 6l12 12M18 6L6 18" /> : <path d="M4 7h16M4 12h16M4 17h16" />}
          </svg>
        </button>
      </div>

      <AnimatePresence>
        {mobileOpen && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden border-t border-rule-soft bg-paper md:hidden"
          >
            <nav className="flex flex-col px-lg py-md">
              {LINKS.map((l) => (
                <a
                  key={l.href}
                  href={l.href}
                  onClick={() => setMobileOpen(false)}
                  className="border-b border-rule-soft py-md text-[0.98rem] text-ink-soft"
                >
                  {l.label}
                </a>
              ))}
              <div className="mt-lg flex flex-col gap-sm">
                <a
                  href={APP_URL}
                  onClick={() => trackEvent("cta_click", { cta: "nav_mobile_get_started" })}
                  className="btn-primary py-md"
                >
                  Get started
                </a>
                <a
                  href={APP_URL}
                  onClick={() => trackEvent("cta_click", { cta: "nav_mobile_sign_in" })}
                  className="btn-secondary py-md"
                >
                  Sign in
                </a>
              </div>
            </nav>
          </motion.div>
        )}
      </AnimatePresence>
    </header>
  );
}
