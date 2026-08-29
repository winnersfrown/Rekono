import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import Reveal from "./Reveal.jsx";
import { APP_URL } from "../lib/constants.js";
import { trackEvent } from "../lib/analytics.js";

const PLANS = [
  {
    tag: "Starter",
    title: "For a single AP owner",
    monthly: 99,
    annual: 79,
    annualTotal: "$948/yr",
    annualSave: "save $240 (20%)",
    cap: "Up to 150 documents/mo",
    features: ["14-day free trial", "1 seat", "Full general ledger", "Extraction + review queue", "CSV / Excel export"],
    featured: false,
  },
  {
    tag: "Growth",
    badge: "Most chosen",
    title: "For a small finance team",
    monthly: 249,
    annual: 199,
    annualTotal: "$2,388/yr",
    annualSave: "save $600 (20%)",
    cap: "Up to 750 documents/mo",
    features: ["14-day free trial", "5 seats", "Everything in Starter", "Matching engine + audit trail", "Priority support"],
    featured: true,
  },
  {
    tag: "Business",
    title: "For growing volume",
    monthly: 499,
    annual: 399,
    annualTotal: "$4,788/yr",
    annualSave: "save $1,200 (20%)",
    cap: "Up to 2,500 documents/mo",
    features: [
      "14-day free trial",
      "Unlimited seats",
      "Everything in Growth",
      "Custom confidence thresholds",
      "Risk-based auto-approval",
      "Dedicated onboarding",
    ],
    featured: false,
  },
  {
    tag: "Scale",
    title: "For your highest volume",
    monthly: 1499,
    annual: 1199,
    annualTotal: "$14,388/yr",
    annualSave: "save $3,600 (20%)",
    cap: "Up to 10,000 documents/mo",
    features: ["14-day free trial", "Unlimited seats", "Everything in Business", "Dedicated support channel", "Priority feature requests"],
    featured: false,
  },
];

function PriceTag({ plan, annual }) {
  const value = annual ? plan.annual : plan.monthly;
  return (
    <div className="mt-md flex items-baseline gap-xs">
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={annual ? "annual" : "monthly"}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={{ duration: 0.14 }}
          className="figures font-display text-[2.4rem] font-semibold leading-none text-ink"
          style={{ fontVariationSettings: '"opsz" 60' }}
        >
          ${value.toLocaleString()}
        </motion.span>
      </AnimatePresence>
      <span className="text-[0.82rem] text-muted">{annual ? "/mo, billed annually" : "/mo"}</span>
    </div>
  );
}

export default function Pricing() {
  const [annual, setAnnual] = useState(false);

  return (
    <section id="pricing" className="py-2xl md:py-3xl">
      <div className="mx-auto max-w-content px-lg md:px-xl">
        <Reveal>
          <div className="rule-head">
            <span className="label">Pricing</span>
          </div>
          <div className="mt-lg flex flex-col gap-lg md:flex-row md:items-end md:justify-between">
            <div>
              <h2 className="section-title max-w-[20ch]">Flat monthly plans with a document cap.</h2>
              <p className="mt-md max-w-measure text-[1rem] leading-relaxed text-ink-soft">
                No per-document metering to watch nervously. Every plan runs the same ledger, extraction, review and
                matching engine. You are paying for volume, seats and support.
              </p>
            </div>

            <div role="group" aria-label="Billing period" className="inline-flex self-start border border-rule md:self-end">
              {[
                { key: "monthly", label: "Monthly" },
                { key: "annual", label: "Annual · save 20%" },
              ].map((opt, i) => {
                const active = (opt.key === "annual") === annual;
                return (
                  <button
                    key={opt.key}
                    type="button"
                    onClick={() => setAnnual(opt.key === "annual")}
                    aria-pressed={active}
                    className={`px-lg py-sm text-[0.84rem] font-medium transition-colors ${i === 1 ? "border-l border-rule" : ""} ${
                      active ? "bg-accent text-white" : "bg-paper-rise text-ink-soft hover:text-ink"
                    }`}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>
        </Reveal>

        {/* One ruled band of four columns, divided by hairlines, rather than
            four cards with a scaled-up featured one. The featured plan is
            marked by a rule above it and its accent label, not by lifting
            it off the page. */}
        <div className="mt-2xl grid grid-cols-1 border-t border-rule sm:grid-cols-2 lg:grid-cols-4">
          {PLANS.map((plan, i) => (
            <Reveal
              key={plan.tag}
              delay={i * 0.04}
              className={`flex flex-col border-b border-rule px-lg py-xl sm:px-xl ${
                i > 0 ? "lg:border-l lg:border-rule" : ""
              } ${i === 1 ? "sm:border-l sm:border-rule" : ""} ${i === 3 ? "sm:border-l sm:border-rule" : ""} ${
                plan.featured ? "bg-paper-rise" : ""
              }`}
            >
              <div className="flex items-baseline gap-sm">
                <span className={`label ${plan.featured ? "!text-accent-text" : ""}`}>{plan.tag}</span>
                {plan.badge && <span className="label !text-accent-text">· {plan.badge}</span>}
              </div>
              <h3 className="mt-xs font-body text-[0.98rem] font-medium text-ink-soft">{plan.title}</h3>

              <PriceTag plan={plan} annual={annual} />

              <div className="mt-xs h-4 text-[0.76rem] text-muted">
                {annual && (
                  <span>
                    {plan.annualTotal}, <span className="text-pos">{plan.annualSave}</span>
                  </span>
                )}
              </div>

              <div className="code mt-md border-y border-rule-soft py-sm text-[0.78rem] text-ink-soft">{plan.cap}</div>

              <ul className="mt-lg flex flex-1 flex-col gap-sm">
                {plan.features.map((f) => (
                  <li key={f} className="flex items-start gap-sm text-[0.86rem] text-ink-soft">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" className="mt-[5px] flex-none text-muted" aria-hidden>
                      <path d="M20 6L9 17l-5-5" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    {f}
                  </li>
                ))}
              </ul>

              <a
                href={APP_URL}
                onClick={() => trackEvent("cta_click", { cta: "pricing", plan: plan.tag.toLowerCase(), billing: annual ? "annual" : "monthly" })}
                className={`mt-xl py-sm text-center text-[0.9rem] ${plan.featured ? "btn-primary" : "btn-secondary"}`}
              >
                Get started
              </a>
            </Reveal>
          ))}
        </div>

        <p className="mt-xl max-w-measure text-[0.84rem] leading-relaxed text-muted">
          Paid plans include a 14-day free trial. Card required at signup, first charge after the trial ends.
          Upgrading to a higher tier later bills right away, without a new trial.
        </p>
      </div>
    </section>
  );
}
