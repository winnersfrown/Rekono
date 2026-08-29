import Reveal from "./Reveal.jsx";
import { staggerContainer } from "../lib/motion.js";
import { motion } from "framer-motion";

// Three claims about the ledger itself, because they are the ones a
// controller is actually deciding on. Each is a property of the code, not a
// posture: postJournalEntry is the single write path and it refuses an
// entry that doesn't balance; posted entries have no update path at all;
// and the three figures nobody can derive for you are the three the product
// refuses to invent.
const ITEMS = [
  {
    tag: "Nothing posts unbalanced",
    body: "Every write goes through one path. It refuses an entry whose debits and credits differ by a cent, and it refuses any entry dated into a closed period.",
  },
  {
    tag: "Corrections are reversals",
    body: "A posted entry is never edited or deleted. A fix is a reversing entry, and both sides stay in the statements, so the history reads the way an auditor expects to find it.",
  },
  {
    tag: "It will not guess on your behalf",
    body: "Grant-date fair value, useful life, effective tax rate. Rekono does the arithmetic once you supply the judgement, and declines to invent the judgement.",
  },
];

export default function ProofStrip() {
  return (
    <section className="border-y border-rule bg-paper-sunk py-2xl md:py-3xl">
      <motion.div
        variants={staggerContainer()}
        initial="hidden"
        whileInView="show"
        viewport={{ once: true, amount: 0.3 }}
        className="mx-auto grid max-w-content gap-xl px-lg md:grid-cols-3 md:gap-0 md:px-xl"
      >
        {ITEMS.map((it, i) => (
          <Reveal
            key={it.tag}
            // Vertical hairlines between the columns, not cards around
            // them. Same job, one line instead of four.
            className={`md:px-xl ${i === 0 ? "md:pl-0" : "md:border-l md:border-rule"} ${
              i === ITEMS.length - 1 ? "md:pr-0" : ""
            }`}
          >
            <h3 className="panel-title">{it.tag}</h3>
            <p className="mt-md text-[0.92rem] leading-relaxed text-ink-soft">{it.body}</p>
          </Reveal>
        ))}
      </motion.div>
    </section>
  );
}
