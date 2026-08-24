import { motion } from "framer-motion";
import { APP_URL, DEMO_URL, EASE } from "../lib/constants.js";

const FIELDS = [
  { label: "VENDOR_NAME", value: "Dunmore Hardware Co.", conf: 98, flag: false },
  { label: "PO_REFERENCE", value: "PO-4421", conf: 96, flag: false },
  { label: "DUE_DATE", value: "02/14/2026", conf: 61, flag: true },
  { label: "TAX", value: "$4.00", conf: 94, flag: false },
];

function DocMock() {
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.94, y: 30 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      transition={{ duration: 0.7, ease: EASE, delay: 0.15 }}
      className="glass-panel-strong relative w-full max-w-[420px] rounded-2xl p-6"
    >
      {/* A slow, continuous drift once the entrance settles -- the one
          place motion never stops, because this card is the hero's thesis:
          the product itself, always doing something, not a static
          screenshot. A separate element from the one animating entrance
          above, so the two animations (settle once, then drift forever)
          don't fight over the same transform. Handled by the app-wide
          <MotionConfig reducedMotion="user"> in App.jsx under
          prefers-reduced-motion -- an *infinite* animation is exactly the
          kind that preference exists to stop, and MotionConfig turns this
          into a no-op automatically rather than needing a manual check. */}
      <motion.div
        animate={{ y: [0, -8, 0] }}
        transition={{ duration: 5, repeat: Infinity, ease: "easeInOut", delay: 0.9 }}
      >
        <div className="flex items-start justify-between border-b border-line-soft pb-4">
          <div>
            <span className="font-mono text-[0.7rem] uppercase tracking-wide text-muted">Invoice · INV-2026-0007</span>
            <div className="mt-1 font-display text-lg font-bold text-paper">Dunmore Hardware Co.</div>
          </div>
          <span className="font-mono text-[0.7rem] text-muted">01/15/2026</span>
        </div>

        <div className="flex flex-col gap-3 py-4">
          {FIELDS.map((f, i) => (
            <motion.div
              key={f.label}
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.5 + i * 0.12, duration: 0.4, ease: EASE }}
              className="flex items-center justify-between"
            >
              <span className="font-mono text-[0.68rem] uppercase tracking-wide text-muted">{f.label}</span>
              <span className="flex items-center gap-2">
                <span className="tabular-nums font-mono text-[0.86rem] font-medium text-paper">{f.value}</span>
                <span
                  className={`tabular-nums rounded-full px-2 py-0.5 font-mono text-[0.68rem] font-semibold ${
                    f.flag ? "bg-amber/15 text-amber" : "bg-green/15 text-green"
                  }`}
                >
                  {f.conf}%
                </span>
              </span>
            </motion.div>
          ))}
        </div>

        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 1.1, duration: 0.4 }}
          className="flex items-start gap-2 rounded-lg bg-amber/10 px-3 py-2.5 text-[0.78rem] text-paper-dim"
        >
          <span aria-hidden className="text-amber">⚑</span>
          <span>Due date confidence below threshold, routed to review queue for a one-click check.</span>
        </motion.div>

        <div className="mt-4 flex items-center justify-between border-t border-line-soft pt-4">
          <span className="text-[0.8rem] text-muted">Total · cross-checked against line items</span>
          <span className="tabular-nums font-display text-xl font-bold text-paper">$54.00</span>
        </div>
      </motion.div>
    </motion.div>
  );
}

export default function Hero() {
  return (
    <section className="relative overflow-hidden pt-12 pb-16 md:pt-16 md:pb-20">
      <div className="mx-auto grid max-w-content items-center gap-14 px-7 md:grid-cols-[1.05fr_0.95fr] md:gap-10">
        <motion.div initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.65, ease: EASE }}>
          <span className="inline-flex items-center gap-2 rounded-full border border-line bg-white/60 px-3 py-1 font-mono text-[0.76rem] uppercase tracking-widest text-blue-bright">
            Accounts payable, read by a model, checked by you
          </span>
          <h1 className="mt-5 text-[2.6rem] leading-[1.08] md:text-[3.3rem]">
            Every invoice, read, checked, and reconciled before it touches your books.
          </h1>
          <p className="mt-5 max-w-[520px] text-[1.06rem] leading-relaxed text-paper-dim">
            Rekono turns PDFs and scanned invoices into structured, audited records: extracting vendor, totals, and
            line items, flagging anything it isn't confident about, and matching each one against your POs or bank
            statement.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <a
              href={APP_URL}
              className="rounded-xl bg-gradient-to-b from-blue to-blue-deep px-6 py-3.5 font-semibold text-white shadow-md transition-transform duration-150 hover:-translate-y-0.5 hover:shadow-glow"
            >
              Get started free, no card required
            </a>
            <a
              href="#how-it-works"
              className="rounded-xl border border-line px-6 py-3.5 font-semibold text-paper transition-colors hover:border-blue hover:text-blue-deep"
            >
              See how it works
            </a>
          </div>
          <p className="mt-4 font-mono text-[0.78rem] text-muted">AI-powered extraction included, no API key or setup required.</p>
          <p className="mt-1.5">
            <a href={DEMO_URL} className="text-[0.9rem] font-medium text-blue-bright underline decoration-blue/30 underline-offset-4 hover:text-blue-deep">
              Or explore a live demo with sample data, no signup required →
            </a>
          </p>
        </motion.div>

        <div className="flex justify-center md:justify-end">
          <DocMock />
        </div>
      </div>
    </section>
  );
}
