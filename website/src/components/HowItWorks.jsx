import Reveal from "./Reveal.jsx";

// Numbered because this genuinely is a sequence: a month runs in this
// order, and step 5 cannot happen before step 4. Numbers that encode
// nothing are decoration; these encode the order the work has to happen in.
const STEPS = [
  {
    n: "01",
    title: "Capture",
    body: "Invoices and expense receipts come in as PDFs or photographs. OCR lifts the text, a model parses it into a fixed schema, and every field carries its own confidence. Anything the model is unsure about, or that fails the line-items-against-total cross-check, goes to a review queue instead of straight to the books.",
    tag: "Extraction · review queue · learned vendor aliases",
  },
  {
    n: "02",
    title: "Post",
    body: "Approving an invoice posts a balanced journal entry against your own chart of accounts. Bills and invoices carry their AP and AR sides, recurring templates post rent and subscriptions on schedule, and revenue contracts recognise on their own ASC 606 schedules rather than in one lump.",
    tag: "Double-entry GL · AR / AP · ASC 606",
  },
  {
    n: "03",
    title: "Reconcile",
    body: "Approved documents are fuzzy-matched against uploaded POs and bank statements on vendor name, an amount tolerance you set, and a date window. Upload goods receipts too and the check becomes three-way: ordered, received, billed, with a verdict for each leg.",
    tag: "Matching engine · three-way check",
  },
  {
    n: "04",
    title: "Adjust",
    body: "The entries that only exist at month-end: accruals and prepaid amortisation, straight-line depreciation, stock compensation under ASC 718, and an income tax provision computed on pre-tax income at the rate you supply.",
    tag: "Adjusting entries · ASC 718 · tax provision",
  },
  {
    n: "05",
    title: "Close",
    body: "The checklist reads the ledger, not the queue. An expense that posted in three of the last four months and not this one is flagged. So is a fixed asset with nothing depreciating it. Neither blocks the close; both make sure the exception is one somebody actually saw. Then the period locks.",
    tag: "Close suggestions · period lock · year-end close",
  },
];

export default function HowItWorks() {
  return (
    <section id="the-month" className="py-2xl md:py-3xl">
      <div className="mx-auto max-w-content px-lg md:px-xl">
        {/* Masthead: heading left, lede in its own column on the baseline
            rather than stacked under it. Stacked, the section opened with
            two short paragraphs down the left and half the row empty. */}
        <Reveal>
          <div className="rule-head">
            <span className="label">The month</span>
          </div>
          <div className="mt-lg grid gap-lg md:grid-cols-[1fr_minmax(0,28rem)] md:items-end md:gap-3xl">
            <h2 className="section-title max-w-[20ch]">Five stages, in the order the work happens.</h2>
            <p className="text-[1rem] leading-relaxed text-ink-soft">
              Not a marketing simplification of the pipeline. These are the real stages a document and a period pass
              through, and each one is a screen you can open today.
            </p>
          </div>
        </Reveal>

        <div className="mt-3xl flex flex-col">
          {STEPS.map((s, i) => (
            <Reveal
              key={s.n}
              delay={i * 0.04}
              // A ruled schedule: one hairline per row, the number in its
              // own narrow column on the left. No cards, no rail, no
              // circles -- the alignment does the work a container used to.
              //
              // Three columns, all of them carrying something. The previous
              // shape was [number][prose][tag] with the prose capped at 54ch
              // inside a 1fr that was twice that wide, so every row had a
              // 400px hole in the middle and the tag hung on its own at the
              // far right edge. Title and tag now share a fixed spine and the
              // prose takes the rest of the measure.
              className="grid gap-md border-t border-rule py-2xl md:grid-cols-[4rem_minmax(0,20rem)_minmax(0,1fr)] md:gap-xl"
            >
              <span className="code text-[1.6rem] leading-none text-accent-text">{s.n}</span>
              <div>
                <h3 className="panel-title">{s.title}</h3>
                <span className="label mt-sm block leading-relaxed">{s.tag}</span>
              </div>
              <p className="max-w-[68ch] text-[1rem] leading-relaxed text-ink-soft">{s.body}</p>
            </Reveal>
          ))}
          <div className="border-t border-rule" aria-hidden />
        </div>
      </div>
    </section>
  );
}
