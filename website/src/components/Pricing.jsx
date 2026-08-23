import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import Reveal from "./Reveal.jsx";
import { APP_URL } from "../lib/constants.js";

const PLANS = [
  {
    tag: "Starter",
    title: "For a single AP owner",
    monthly: 99,
    annual: 79,
    annualTotal: "$948/yr",
    annualSave: "save $240 (20%)",
    cap: "Up to 150 documents/mo",
    features: ["14-day free trial", "1 seat", "Extraction + review queue", "CSV / Excel export", "Email support"],
    featured: false,
  },
  {
    tag: "Growth",
    badge: "Most Popular",
    title: "For a small AP team",
    monthly: 249,
    annual: 199,
    annualTotal: "$2,388/yr",
    annualSave: "save $600 (20%)",
    cap: "Up to 750 documents/mo",
    features: ["14-day free trial", "5 seats", "Everything in Starter", "Matching engine + full audit trail", "Priority support"],
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
    <div className="mt-4 flex items-baseline gap-1">
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={annual ? "annual" : "monthly"}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.18 }}
          className="tabular-nums font-display text-[2.3rem] font-bold text-paper"
        >
          ${value.toLocaleString()}
        </motion.span>
      </AnimatePresence>
      <span className="text-[0.85rem] text-muted">{annual ? "/mo, billed annually" : "/mo"}</span>
    </div>
  );
}

export default function Pricing() {
  const [annual, setAnnual] = useState(false);

  return (
    <section id="pricing" className="py-24">
      <div className="mx-auto max-w-content px-7">
        <Reveal className="mx-auto max-w-2xl text-center">
          <span className="font-mono text-[0.78rem] font-semibold uppercase tracking-widest text-blue-bright">
            Pricing
          </span>
          <h2 className="mt-3 text-[2.1rem]">Flat monthly plans with a document cap.</h2>
          <p className="mt-3 text-[1rem] text-paper-dim">
            No per-document metering to watch nervously. Every plan runs the same extraction, review, and matching
            engine; you're paying for volume and support.
          </p>
        </Reveal>

        <Reveal className="mt-9 flex justify-center">
          <div role="group" aria-label="Billing period" className="glass-panel inline-flex rounded-full p-1">
            {[
              { key: "monthly", label: "Monthly" },
              { key: "annual", label: "Annual" },
            ].map((opt) => {
              const active = (opt.key === "annual") === annual;
              return (
                <button
                  key={opt.key}
                  type="button"
                  onClick={() => setAnnual(opt.key === "annual")}
                  className={`relative flex items-center gap-2 rounded-full px-5 py-2 text-[0.86rem] font-semibold transition-colors ${
                    active ? "text-white" : "text-paper-dim hover:text-paper"
                  }`}
                >
                  {active && (
                    <motion.span
                      layoutId="billing-pill"
                      transition={{ type: "spring", stiffness: 400, damping: 32 }}
                      className="absolute inset-0 rounded-full bg-gradient-to-b from-blue to-blue-deep"
                    />
                  )}
                  <span className="relative">{opt.label}</span>
                  {opt.key === "annual" && (
                    <span className={`relative rounded-full px-1.5 py-0.5 font-mono text-[0.65rem] ${active ? "bg-white/20" : "bg-green/15 text-green"}`}>
                      Save 20%
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </Reveal>

        <div className="mt-12 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {PLANS.map((plan, i) => (
            <Reveal
              key={plan.tag}
              delay={i * 0.05}
              className={`relative flex flex-col rounded-2xl p-7 transition-transform duration-300 ease-brand hover:-translate-y-1 ${
                plan.featured ? "glass-tint scale-[1.03] shadow-lg" : "glass-panel"
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="font-mono text-[0.72rem] font-semibold uppercase tracking-widest text-blue-bright">
                  {plan.tag}
                </span>
                {plan.badge && (
                  <span className="rounded-full bg-blue px-2 py-0.5 font-mono text-[0.62rem] font-semibold uppercase tracking-wide text-white">
                    {plan.badge}
                  </span>
                )}
              </div>
              <h3 className="mt-2 text-[1.1rem]">{plan.title}</h3>

              <PriceTag plan={plan} annual={annual} />

              <div className="mt-1 h-4 text-[0.76rem] text-muted">
                {annual && (
                  <span>
                    {plan.annualTotal}, <span className="text-green">{plan.annualSave}</span>
                  </span>
                )}
              </div>

              <div className="mt-3 font-mono text-[0.78rem] text-paper-dim">{plan.cap}</div>

              <ul className="mt-5 flex flex-1 flex-col gap-2.5">
                {plan.features.map((f) => (
                  <li key={f} className="flex items-start gap-2 text-[0.86rem] text-paper-dim">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" className="mt-0.5 flex-none text-green">
                      <path d="M20 6L9 17l-5-5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    {f}
                  </li>
                ))}
              </ul>

              <a
                href={APP_URL}
                className={`mt-7 rounded-xl px-5 py-3 text-center font-semibold transition-transform duration-150 hover:-translate-y-0.5 ${
                  plan.featured
                    ? "bg-gradient-to-b from-blue to-blue-deep text-white shadow-md hover:shadow-glow"
                    : "border border-line text-paper hover:border-blue hover:text-blue-deep"
                }`}
              >
                Get started
              </a>
            </Reveal>
          ))}
        </div>

        <p className="mt-10 text-center text-[0.82rem] text-muted">
          Paid plans include a 14-day free trial. Card required at signup, first charge after the trial ends.
          Upgrading to a higher tier later bills right away, without a new trial.
        </p>
      </div>
    </section>
  );
}
