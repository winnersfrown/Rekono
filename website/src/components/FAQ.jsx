import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import Reveal from "./Reveal.jsx";

const ITEMS = [
  {
    q: "What file types does Rekono accept?",
    a: "PDF and common image formats: PNG, JPG, TIFF, BMP, WEBP. If you can scan it or photograph it, Rekono can read it.",
  },
  {
    q: "What happens to invoices Rekono isn't confident about?",
    a: "They're routed to the review queue instead of auto-approved. You see the source document and the extracted fields side by side, correct whatever's off, and the correction is written to the audit log.",
  },
  {
    q: "How does matching actually work?",
    a: "Rekono fuzzy-matches vendor name, amount (within a tolerance you set: percentage or flat dollar), and a date window against an uploaded PO list or bank statement, plus an exact PO/reference check when one is present on the invoice.",
  },
  {
    q: "Do you integrate with QuickBooks, Xero, or NetSuite?",
    a: "QuickBooks Online is live: connect your account and push an approved invoice to QuickBooks as a Bill in one click. Xero and NetSuite are next on the roadmap, along with deeper QuickBooks automation (bulk push, sync-back).",
  },
  {
    q: "Can I self-host it?",
    a: "Yes. Rekono runs on Postgres or SQLite and ships with a Dockerfile and docker-compose setup for running it entirely on your own infrastructure.",
  },
  {
    q: "What happens if I go over my document cap?",
    a: "Uploads pause once you hit your plan's cap for the month, and you're prompted to upgrade right there if you want to keep going — no surprise per-document charges. Your cap resets automatically at the start of the next month either way.",
  },
];

function FaqRow({ item, open, onToggle }) {
  return (
    <div className="glass-panel overflow-hidden rounded-xl">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left"
      >
        <span className="text-[0.98rem] font-medium text-paper">{item.q}</span>
        <motion.span
          animate={{ rotate: open ? 45 : 0 }}
          transition={{ duration: 0.2 }}
          className="flex h-6 w-6 flex-none items-center justify-center rounded-full bg-blue/10 font-mono text-blue-deep"
        >
          +
        </motion.span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
            className="overflow-hidden"
          >
            <p className="px-5 pb-4 text-[0.9rem] leading-relaxed text-paper-dim">{item.a}</p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default function FAQ() {
  // Single-open accordion rather than plain <details> (the old static
  // site's approach): a smooth height animation only Framer Motion + real
  // state can drive, since <details> jumps open/closed with no transition
  // hook to animate against.
  const [openIndex, setOpenIndex] = useState(null);

  return (
    <section id="faq" className="py-16">
      <div className="mx-auto max-w-content px-7">
        <Reveal className="mx-auto max-w-2xl text-center">
          <span className="font-mono text-[0.78rem] font-semibold uppercase tracking-widest text-blue-bright">FAQ</span>
          <h2 className="mt-3 text-[2.1rem]">Questions worth answering before you upload anything.</h2>
        </Reveal>

        <div className="mx-auto mt-12 flex max-w-[720px] flex-col gap-3">
          {ITEMS.map((item, i) => (
            <Reveal key={item.q} delay={i * 0.04}>
              <FaqRow item={item} open={openIndex === i} onToggle={() => setOpenIndex(openIndex === i ? null : i)} />
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
