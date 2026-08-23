import Reveal from "./Reveal.jsx";

const STEPS = [
  {
    n: "01",
    title: "Upload",
    body: "Drop in a PDF or a photo of an invoice, one at a time or as a batch. It's queued immediately and processed in the background; nothing blocks on the upload.",
    tag: "async job queue",
  },
  {
    n: "02",
    title: "Read",
    body: "OCR lifts the raw text from the page, then a language model parses it into a fixed schema: vendor, dates, PO reference, line items, tax, and totals.",
    tag: "OCR + structured extraction",
  },
  {
    n: "03",
    title: "Check",
    body: "Line items are summed and compared against the stated total. Every field also carries its own self-reported confidence score.",
    tag: "automatic cross-check",
  },
  {
    n: "04",
    title: "Review",
    body: "Anything below the confidence bar, or that fails the cross-check, lands in the review queue. Source document and extracted fields sit side by side; corrections are one click and get logged.",
    tag: "human-in-the-loop",
  },
  {
    n: "05",
    title: "Reconcile & export",
    body: "Approved invoices are fuzzy-matched against your PO list or bank statement (vendor name, amount tolerance, date window), then exported to CSV or Excel, or synced onward.",
    tag: "matching engine + export",
  },
];

export default function HowItWorks() {
  return (
    <section id="how-it-works" className="py-24">
      <div className="mx-auto max-w-content px-7">
        <Reveal className="mx-auto max-w-2xl text-center">
          <span className="font-mono text-[0.78rem] font-semibold uppercase tracking-widest text-blue-bright">
            How it works
          </span>
          <h2 className="mt-3 text-[2.1rem]">One pipeline, from inbox to reconciled record.</h2>
          <p className="mt-3 text-[1rem] text-paper-dim">
            Five steps, in order: each one a real stage the document passes through, not a marketing simplification.
          </p>
        </Reveal>

        <div className="relative mt-16 flex flex-col gap-10">
          {/* One continuous rail down the left, behind every step number --
              a single visual thread tying the five stages into one pipeline
              instead of five separate cards that happen to be stacked. */}
          <div className="absolute left-[27px] top-3 bottom-3 hidden w-px bg-line md:block" aria-hidden />

          {STEPS.map((s, i) => (
            <Reveal key={s.n} delay={i * 0.05} className="relative flex gap-6 md:gap-8">
              <div className="relative z-10 flex h-14 w-14 flex-none items-center justify-center rounded-full border border-line bg-white font-display text-lg font-bold text-blue-deep shadow-sm">
                {s.n}
              </div>
              <div className="glass-panel flex-1 rounded-2xl p-6 md:p-7">
                <h3 className="text-[1.3rem]">{s.title}</h3>
                <p className="mt-2 max-w-[620px] text-[0.95rem] leading-relaxed text-paper-dim">{s.body}</p>
                <span className="mt-4 inline-block rounded-full bg-blue/10 px-3 py-1 font-mono text-[0.7rem] font-medium uppercase tracking-wide text-blue-deep">
                  {s.tag}
                </span>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
