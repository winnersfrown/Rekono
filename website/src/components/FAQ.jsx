import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import Reveal from "./Reveal.jsx";

const ITEMS = [
  {
    q: "Is this a real general ledger, or a layer on top of one?",
    a: "A real one. Rekono keeps its own chart of accounts and posts double-entry journal entries through a single write path that refuses anything out of balance and refuses any date inside a closed period. The trial balance and financial statements are derived from those entries, not maintained alongside them.",
  },
  {
    q: "What happens when a posted entry is wrong?",
    a: "You void it, which posts a reversing entry dated the same day. The original stays exactly as it was and both appear in the statements. Nothing in the system edits or deletes a posted entry, because an audit trail with a hole in it is worse than no audit trail.",
  },
  {
    q: "What does the AI actually decide?",
    a: "Nothing that posts. It reads documents into a fixed schema and reports how confident it is per field, with a cross-check of line items against the stated total. Low confidence and failed cross-checks route to a review queue. The close suggestions are the same shape: derived from the ledger, presented as questions, never posted for you.",
  },
  {
    q: "What file types can it read?",
    a: "PDF and common image formats: PNG, JPG, TIFF, BMP, WEBP. If you can scan it or photograph it, Rekono can read it.",
  },
  {
    q: "How does matching work?",
    a: "Fuzzy vendor name, an amount tolerance you set (percentage or flat dollar) and a date window against an uploaded PO list or bank statement, plus an exact PO reference check when the invoice carries one. Upload goods receipts as well and it switches to a three-way check: ordered, received, billed, scored as separate legs.",
  },
  {
    q: "Do you integrate with QuickBooks, Xero, or NetSuite?",
    a: "QuickBooks Online is live: connect your account and push an approved invoice across as a Bill in one click. Xero and NetSuite are next, along with deeper QuickBooks automation.",
  },
  {
    q: "Can I self-host it?",
    a: "Yes. Rekono runs on Postgres or SQLite and ships with a Dockerfile and a docker-compose setup for running it entirely on your own infrastructure. On Postgres it can also enforce tenant isolation in the database with row-level security, underneath the application-level scoping.",
  },
  {
    q: "What happens if I go over my document cap?",
    a: "Uploads pause once you hit the month's cap and you're prompted to upgrade right there, with no surprise per-document charges. The cap resets at the start of the next month either way, and nothing already in the ledger is affected.",
  },
];

function FaqRow({ item, open, onToggle }) {
  return (
    <div className="border-t border-rule">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-lg py-lg text-left"
      >
        <span className="text-[1rem] font-medium text-ink">{item.q}</span>
        <motion.span
          animate={{ rotate: open ? 45 : 0 }}
          transition={{ duration: 0.16 }}
          className="code flex-none text-[1.1rem] leading-none text-accent-text"
          aria-hidden
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
            transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
            className="overflow-hidden"
          >
            <p className="max-w-[62ch] pb-lg pr-2xl text-[0.94rem] leading-relaxed text-ink-soft">{item.a}</p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default function FAQ() {
  // Single-open accordion rather than plain <details>: a height animation
  // needs real state to animate against, and <details> gives no hook for it.
  const [openIndex, setOpenIndex] = useState(null);

  return (
    <section id="faq" className="border-t border-rule bg-paper-sunk py-2xl md:py-3xl">
      <div className="mx-auto grid max-w-content gap-2xl px-lg md:grid-cols-[18rem_1fr] md:gap-3xl md:px-xl">
        <Reveal>
          <div className="rule-head">
            <span className="label">Questions</span>
          </div>
          <h2 className="section-title mt-lg">Worth answering before you post anything.</h2>
        </Reveal>

        <div className="flex flex-col">
          {ITEMS.map((item, i) => (
            <Reveal key={item.q} delay={i * 0.02}>
              <FaqRow item={item} open={openIndex === i} onToggle={() => setOpenIndex(openIndex === i ? null : i)} />
            </Reveal>
          ))}
          <div className="border-t border-rule" aria-hidden />
        </div>
      </div>
    </section>
  );
}
