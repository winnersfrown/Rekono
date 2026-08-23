import Reveal from "./Reveal.jsx";

const FEATURES = [
  {
    tag: "Trust",
    title: "Confidence scoring",
    body: "Every field carries its own score. A cross-check of line items against the stated total catches what confidence alone misses.",
    span: "md:col-span-5",
    tint: true,
  },
  {
    tag: "Compliance",
    title: "Full audit trail",
    body: "Every extraction, correction, approval, and match decision is logged: who made it, when, and exactly what changed.",
    span: "md:col-span-7",
    tint: true,
  },
  {
    tag: "Extraction",
    title: "Structured, every time",
    body: "Vendor, invoice number, dates, PO reference, line items, tax, and totals: pulled into one consistent schema regardless of layout.",
    span: "md:col-span-3",
  },
  {
    tag: "Review",
    title: "Human review queue",
    body: "Low-confidence fields are flagged, not shipped. Correct them side by side with the source document in a single pass.",
    span: "md:col-span-5",
  },
  {
    tag: "Reconciliation",
    title: "Fuzzy matching engine",
    body: "Vendor names, amounts, and dates matched against your POs or bank statement, with tolerance rules instead of exact-string demands.",
    span: "md:col-span-4",
  },
  {
    tag: "Output",
    title: "Export & sync",
    body: "CSV and Excel today, built on the same data your ledger needs next. QuickBooks, Xero, and NetSuite sync are on the roadmap.",
    span: "md:col-span-12",
  },
];

export default function Features() {
  return (
    <section id="features" className="py-24">
      <div className="mx-auto max-w-content px-7">
        <Reveal className="mx-auto max-w-2xl text-center">
          <span className="font-mono text-[0.78rem] font-semibold uppercase tracking-widest text-blue-bright">
            Features
          </span>
          <h2 className="mt-3 text-[2.1rem]">Built for the part of AP automation people don't trust yet.</h2>
          <p className="mt-3 text-[1rem] text-paper-dim">
            Every feature here exists because "fully autonomous" isn't a real option for your books. "Flags what
            needs a human" is.
          </p>
        </Reveal>

        <div className="mt-16 grid grid-cols-1 gap-4 md:grid-cols-12">
          {FEATURES.map((f, i) => (
            <Reveal
              key={f.tag}
              delay={(i % 3) * 0.06}
              className={`group relative overflow-hidden rounded-2xl p-7 transition-transform duration-300 ease-brand hover:-translate-y-1 ${f.span} ${
                f.tint ? "glass-tint" : "glass-panel"
              }`}
            >
              {/* A quiet glow that only appears on hover -- interactive
                  affordance without a persistent gradient competing with
                  the copy the rest of the time. */}
              <div className="pointer-events-none absolute -right-10 -top-10 h-40 w-40 rounded-full bg-blue/0 blur-3xl transition-colors duration-300 group-hover:bg-blue/20" aria-hidden />
              <span className="relative font-mono text-[0.7rem] font-semibold uppercase tracking-widest text-blue-bright">
                {f.tag}
              </span>
              <h3 className={`relative mt-2 ${f.tint ? "text-[1.4rem]" : "text-[1.15rem]"}`}>{f.title}</h3>
              <p className="relative mt-2 max-w-[520px] text-[0.92rem] leading-relaxed text-paper-dim">{f.body}</p>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
