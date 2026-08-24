import Reveal from "./Reveal.jsx";
import { staggerContainer } from "../lib/motion.js";
import { motion } from "framer-motion";

const ITEMS = [
  {
    tag: "Cross-checked",
    title: "Line items vs. totals, every time",
    body: "Every extraction is checked against its own math before it reaches you: not just scored, verified.",
  },
  {
    tag: "Confidence-scored",
    title: "Nothing is silently guessed",
    body: "Fields the model isn't sure about are flagged for a human, not shipped straight to your ledger.",
  },
  {
    tag: "Fully audited",
    title: "Every decision, attributable",
    body: "Corrections, approvals, and matches are logged with who, when, and what changed.",
  },
];

export default function ProofStrip() {
  return (
    <section className="border-y border-line-soft bg-white/40 py-10">
      <motion.div
        variants={staggerContainer()}
        initial="hidden"
        whileInView="show"
        viewport={{ once: true, amount: 0.3 }}
        className="mx-auto grid max-w-content gap-8 px-7 md:grid-cols-3"
      >
        {ITEMS.map((it) => (
          <Reveal key={it.tag}>
            <span className="font-mono text-[0.74rem] font-semibold uppercase tracking-widest text-blue-bright">
              {it.tag}
            </span>
            <h3 className="mt-2 text-[1.15rem]">{it.title}</h3>
            <p className="mt-2 text-[0.92rem] leading-relaxed text-paper-dim">{it.body}</p>
          </Reveal>
        ))}
      </motion.div>
    </section>
  );
}
