import { useState } from "react";
import { MotionConfig } from "framer-motion";
import Reveal from "./components/Reveal.jsx";
import ContactModal from "./components/ContactModal.jsx";
import Logomark from "./components/Logomark.jsx";
import { APP_URL, PRIVACY_URL, TERMS_URL } from "./lib/constants.js";
import { trackEvent } from "./lib/analytics.js";

// Every claim on this page traces to something checkable: Rekono's own
// published pricing (plans.js) and shipped features on one side, publicly
// reported figures (G2, Numeric, ERP Scorecard, Vendr) on the other. Where
// Rillet is ahead -- multi-entity consolidation -- this says so rather
// than pretending otherwise. A comparison page that only ever finds itself
// winning is marketing, not evidence, and undercuts the rows that are true.
const ROWS = [
  {
    label: "Pricing",
    rekono: "Published: $0-$1,499/mo, self-serve",
    rillet: "Quote-only; publicly reported at ~$20K-$35K/yr",
    edge: "rekono",
  },
  {
    label: "Time to first close",
    rekono: "Sign up and start today",
    rillet: "Reported implementation timelines around 45 days",
    edge: "rekono",
  },
  {
    label: "Switching your books over",
    rekono: "Upload a trial balance CSV, import in one step",
    rillet: "Manual re-entry as part of implementation",
    edge: "rekono",
  },
  {
    label: "Cap table & equity",
    rekono: "Share register, option pool (ASC 718), SAFEs & convertible notes",
    rillet: "Not part of the product",
    edge: "rekono",
  },
  {
    label: "Board reporting",
    rekono: "Cash, burn, runway, P&L, balance sheet, cap table, MRR/ARR in one report",
    rillet: "Close automation and reporting; no cap table",
    edge: "rekono",
  },
  {
    label: "AI decision trust",
    rekono: "Every extraction and correction has a visible audit trail with confidence shown",
    rillet: "Not surfaced in product marketing",
    edge: "rekono",
  },
  {
    label: "Revenue recognition (ASC 606)",
    rekono: "Built in, from invoice line items",
    rillet: "Built in, driven from CRM/billing data",
    edge: "tie",
  },
  {
    label: "Multi-entity consolidation",
    rekono: "Not yet built -- one entity per organization today",
    rillet: "Native, a core part of its positioning",
    edge: "rillet",
  },
  {
    label: "Integration library",
    rekono: "QuickBooks, Plaid -- narrower, growing",
    rillet: "Broader (Stripe, Salesforce, Rippling, ...); users report it's still growing too",
    edge: "rillet",
  },
];

// .label sets its own `color: var(--muted)` as a plain (non-@layer) rule in
// index.css, which wins over a Tailwind text-* utility on the same element
// by source order despite equal specificity -- an inline style is the one
// thing guaranteed to sit above both.
function EdgeTag({ edge }) {
  if (edge === "tie") return <span className="label">Both</span>;
  const isRekono = edge === "rekono";
  return (
    <span className="label" style={{ color: isRekono ? "var(--pos)" : "var(--muted)" }}>
      {isRekono ? "Rekono" : "Rillet"}
    </span>
  );
}

function ComparisonTable() {
  return (
    <div className="panel w-full overflow-x-auto">
      <table className="w-full min-w-[640px] border-collapse text-[0.9rem]">
        <thead>
          <tr className="border-b border-rule">
            <th className="label px-lg py-md text-left font-medium">Where it matters</th>
            <th className="label px-md py-md text-left font-medium">Rekono</th>
            <th className="label px-md py-md text-left font-medium">Rillet</th>
            <th className="label px-lg py-md text-left font-medium">Edge</th>
          </tr>
        </thead>
        <tbody>
          {ROWS.map((r) => (
            <tr key={r.label} className="border-b border-rule-soft align-top">
              <td className="px-lg py-md font-medium text-ink">{r.label}</td>
              <td className="px-md py-md text-ink-soft">{r.rekono}</td>
              <td className="px-md py-md text-ink-soft">{r.rillet}</td>
              <td className="px-lg py-md"><EdgeTag edge={r.edge} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MiniHeader() {
  return (
    <header className="border-b border-rule bg-paper">
      <div className="mx-auto flex max-w-content items-center justify-between gap-lg px-lg py-md md:px-xl">
        <a href="/" className="flex items-center gap-sm font-display text-[1.15rem] font-bold text-ink">
          <Logomark className="h-[26px] w-[26px]" />
          Rekono
        </a>
        <div className="flex items-center gap-md">
          <a href="/" className="text-[0.9rem] font-medium text-ink-soft transition-colors hover:text-ink">
            Home
          </a>
          <a
            href={APP_URL}
            onClick={() => trackEvent("cta_click", { cta: "vs_rillet_nav_get_started" })}
            className="btn-primary px-lg py-sm text-[0.9rem]"
          >
            Get started
          </a>
        </div>
      </div>
    </header>
  );
}

function MiniFooter() {
  return (
    <footer className="border-t border-rule bg-paper-sunk py-xl">
      <div className="mx-auto flex max-w-content flex-col gap-lg px-lg md:flex-row md:items-center md:justify-between md:px-xl">
        <div className="flex flex-col gap-xs">
          <a href="/" className="flex items-center gap-sm font-display text-[1.05rem] font-bold text-ink">
            <Logomark className="h-5 w-5" />
            Rekono
          </a>
          <span className="text-[0.84rem] text-muted">Accrual accounting and the financial close.</span>
        </div>
        <nav className="flex flex-wrap items-center gap-x-lg gap-y-sm text-[0.84rem] text-ink-soft">
          <a href="/" className="transition-colors hover:text-accent-text">Home</a>
          <a href={PRIVACY_URL} className="transition-colors hover:text-accent-text">Privacy</a>
          <a href={TERMS_URL} className="transition-colors hover:text-accent-text">Terms</a>
        </nav>
      </div>
    </footer>
  );
}

export default function VsRilletApp() {
  const [contactOpen, setContactOpen] = useState(false);

  return (
    <MotionConfig reducedMotion="user">
      <div id="top">
        <MiniHeader />
        <main>
          <section className="py-2xl md:py-3xl">
            <Reveal className="mx-auto max-w-content px-lg md:px-xl">
              <span className="label">Rekono vs Rillet</span>
              <h1 className="section-title mt-md max-w-[22ch] font-display">
                The same accrual books. A same-day start instead of a 45-day implementation.
              </h1>
              <p className="mt-md max-w-measure text-[1.05rem] leading-relaxed text-ink-soft">
                Rillet is a real accrual-accounting platform, and this isn't a claim that it's worse at everything.
                It's a claim about who each one is actually built for: Rillet quotes custom implementations in the
                five figures for teams that need multi-entity consolidation. Rekono publishes its price, imports
                your existing trial balance in one step, and ships the cap table and SAFE tracking Rillet doesn't
                have at all.
              </p>
              <div className="mt-lg flex flex-wrap items-center gap-md">
                <a
                  href={APP_URL}
                  onClick={() => trackEvent("cta_click", { cta: "vs_rillet_hero_primary" })}
                  className="btn-primary px-xl py-md"
                >
                  Get started free
                </a>
                <button
                  type="button"
                  onClick={() => {
                    trackEvent("cta_click", { cta: "vs_rillet_hero_contact" });
                    setContactOpen(true);
                  }}
                  className="btn-secondary px-xl py-md"
                >
                  Talk to us
                </button>
              </div>
            </Reveal>
          </section>

          <section className="pb-2xl md:pb-3xl">
            <Reveal className="mx-auto max-w-content px-lg md:px-xl">
              <ComparisonTable />
              <p className="mt-md text-[0.8rem] text-muted">
                Rillet figures are publicly reported (G2, Numeric, ERP Scorecard, Vendr, September 2026) --
                verify against Rillet directly for your own quote. Rekono figures are this product's own
                published pricing and shipped features.
              </p>
            </Reveal>
          </section>

          <section className="pb-2xl md:pb-3xl">
            <Reveal className="mx-auto max-w-content px-lg md:px-xl">
              <div className="border-t border-rule pt-xl">
                <span className="label">Where Rillet is ahead</span>
                <h2 className="section-title mt-md max-w-[26ch]">
                  If you run more than one legal entity and need consolidated financials today, Rillet does that
                  natively. Rekono doesn't yet.
                </h2>
                <p className="mt-md max-w-measure text-[1rem] leading-relaxed text-ink-soft">
                  Rekono is built for a single entity, closing its own books -- the shape of most companies before a
                  Series B and a holding-company structure. Multi-entity consolidation is real, unfinished work, not
                  a footnote: if that's what you need this week, Rillet is the better fit today.
                </p>
              </div>
            </Reveal>
          </section>

          <section id="final-cta" className="pb-2xl md:pb-3xl">
            <Reveal className="mx-auto max-w-content px-lg md:px-xl">
              <div className="border-t border-rule pt-2xl">
                <div className="grid gap-xl md:grid-cols-[1fr_auto] md:items-end md:gap-3xl">
                  <div>
                    <span className="label">Get started</span>
                    <h2 className="section-title mt-md max-w-[18ch]">Bring your books over and see for yourself.</h2>
                    <p className="mt-md max-w-measure text-[1rem] leading-relaxed text-ink-soft">
                      Free to start, no card required, no sales call to get a price. Export a trial balance from
                      whatever you use today and import it in one step.
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-md md:flex-col md:items-stretch">
                    <a
                      href={APP_URL}
                      onClick={() => trackEvent("cta_click", { cta: "vs_rillet_final_primary" })}
                      className="btn-primary px-xl py-md"
                    >
                      Get started free
                    </a>
                    <button
                      type="button"
                      onClick={() => {
                        trackEvent("cta_click", { cta: "vs_rillet_final_contact" });
                        setContactOpen(true);
                      }}
                      className="btn-secondary px-xl py-md"
                    >
                      Talk to us
                    </button>
                  </div>
                </div>
              </div>
            </Reveal>
          </section>
        </main>
        <MiniFooter />
      </div>
      <ContactModal open={contactOpen} onClose={() => setContactOpen(false)} />
    </MotionConfig>
  );
}
