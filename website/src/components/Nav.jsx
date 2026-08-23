import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { APP_URL } from "../lib/constants.js";
import Logomark from "./Logomark.jsx";

const LINKS = [
  { href: "#how-it-works", label: "How It Works" },
  { href: "#features", label: "Features" },
  { href: "#pricing", label: "Pricing" },
  { href: "#faq", label: "FAQ" },
];

export default function Nav() {
  // The header starts fully transparent over the hero (nothing to separate
  // it from yet) and only picks up the glass treatment once there's real
  // content passing underneath it to blur -- a glass bar over empty sky
  // looks like a rendering bug, not a design choice.
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
      className={`sticky top-0 z-40 transition-colors duration-300 ${
        scrolled ? "glass-panel-strong" : "bg-transparent border-b border-transparent"
      }`}
    >
      <div className="mx-auto flex max-w-content items-center justify-between px-7 py-4">
        <a href="#top" className="flex items-center gap-2 font-display text-lg font-bold text-paper">
          <Logomark className="h-[26px] w-[26px] shadow-glow" />
          Rekono
        </a>

        <nav className="hidden items-center gap-7 font-body text-[0.92rem] text-paper-dim md:flex">
          {LINKS.map((l) => (
            <a key={l.href} href={l.href} className="transition-colors hover:text-paper">
              {l.label}
            </a>
          ))}
        </nav>

        <div className="hidden items-center gap-3 md:flex">
          <a
            href={APP_URL}
            className="rounded-lg px-4 py-2 text-[0.9rem] font-semibold text-paper-dim transition-colors hover:text-paper"
          >
            Sign in
          </a>
          <a
            href={APP_URL}
            className="rounded-lg bg-gradient-to-b from-blue to-blue-deep px-4 py-2 text-[0.9rem] font-semibold text-white shadow-md transition-transform duration-150 hover:-translate-y-0.5 hover:shadow-glow"
          >
            Get started
          </a>
        </div>

        <button
          type="button"
          aria-label="Toggle menu"
          aria-expanded={mobileOpen}
          onClick={() => setMobileOpen((v) => !v)}
          className="flex h-9 w-9 items-center justify-center rounded-lg text-paper md:hidden"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
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
            transition={{ duration: 0.22 }}
            className="glass-panel-strong overflow-hidden border-t border-line-soft md:hidden"
          >
            <nav className="flex flex-col gap-1 px-7 py-4">
              {LINKS.map((l) => (
                <a
                  key={l.href}
                  href={l.href}
                  onClick={() => setMobileOpen(false)}
                  className="rounded-lg px-2 py-2.5 text-[0.95rem] text-paper-dim hover:text-paper"
                >
                  {l.label}
                </a>
              ))}
              <div className="mt-2 flex flex-col gap-2 border-t border-line-soft pt-3">
                <a href={APP_URL} className="rounded-lg px-2 py-2 text-center font-semibold text-paper-dim">
                  Sign in
                </a>
                <a
                  href={APP_URL}
                  className="rounded-lg bg-gradient-to-b from-blue to-blue-deep px-2 py-2.5 text-center font-semibold text-white shadow-md"
                >
                  Get started
                </a>
              </div>
            </nav>
          </motion.div>
        )}
      </AnimatePresence>
    </header>
  );
}
