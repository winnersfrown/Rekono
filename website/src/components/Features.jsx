import Reveal from "./Reveal.jsx";

// A ruled index of what the ledger actually does, in two columns of rows
// rather than a bento of tinted cards. A card grid asks you to read six
// boxes in no particular order; a ruled list asks you to scan a schedule,
// which is the thing this audience does all day.
const GROUPS = [
  {
    heading: "The ledger",
    items: [
      {
        title: "Double-entry general ledger",
        body: "Your own chart of accounts, journal entries that cannot post out of balance, a trial balance, and financial statements built from the entries rather than from a running total kept alongside them.",
      },
      {
        title: "Revenue recognition",
        body: "ASC 606 performance obligations recognised over their own schedules. The deferred balance is what the schedule says is unrecognised, not a figure maintained by hand.",
      },
      {
        title: "Adjusting and closing entries",
        body: "Accruals, prepaid amortisation, straight-line depreciation on a schedule, recurring templates, and a year-end close that rolls the P&L into retained earnings and locks the period.",
      },
      {
        title: "Income tax provision",
        body: "Current tax computed on pre-tax income at your effective rate, never on net income. On a loss the provision floors at zero rather than booking a benefit nobody has agreed to.",
      },
    ],
  },
  {
    heading: "Equity and payables",
    items: [
      {
        title: "Share register and cap table",
        body: "Issues, transfers, repurchases and reissues replayed in date order, so a backdated movement is re-derived rather than patched. The register ties out against Common Stock at par.",
      },
      {
        title: "Options and stock compensation",
        body: "An option pool with fully-diluted ownership, and ASC 718 expense that accrues for service through a cliff even though nothing has vested yet. Forfeiture reverses what was never earned.",
      },
      {
        title: "Invoice and receipt capture",
        body: "OCR plus structured extraction with per-field confidence and a line-items-against-total cross-check. Low confidence routes to review; a correction teaches the vendor alias for next time.",
      },
      {
        title: "Reconciliation and audit trail",
        body: "Fuzzy matching against POs and bank statements, a three-way check once goods receipts are uploaded, and an audit log of every extraction, correction, approval and match decision.",
      },
    ],
  },
];

export default function Features() {
  return (
    <section id="ledger" className="border-t border-rule bg-paper-sunk py-2xl md:py-3xl">
      <div className="mx-auto max-w-content px-lg md:px-xl">
        <Reveal>
          <div className="rule-head">
            <span className="label">What's underneath</span>
          </div>
          {/* Same masthead shape as "The month": heading and lede share the
              row instead of stacking down the left edge. */}
          <div className="mt-lg grid gap-lg md:grid-cols-[1fr_minmax(0,28rem)] md:items-end md:gap-3xl">
            <h2 className="section-title max-w-[22ch]">A ledger first, with the AI in front of it.</h2>
            <p className="text-[1rem] leading-relaxed text-ink-soft">
              The model reads documents and suggests. It never decides what posts. Everything below is ordinary
              accounting, done properly, with the extraction feeding it rather than replacing it.
            </p>
          </div>
        </Reveal>

        <div className="mt-3xl grid gap-3xl md:grid-cols-2 md:gap-2xl">
          {GROUPS.map((group, gi) => (
            <div key={group.heading} className={gi === 1 ? "md:border-l md:border-rule md:pl-2xl" : ""}>
              <span className="label">{group.heading}</span>
              <div className="mt-md flex flex-col">
                {group.items.map((f, i) => (
                  <Reveal key={f.title} delay={i * 0.03} className="border-t border-rule py-xl">
                    <h3 className="panel-title">{f.title}</h3>
                    <p className="mt-sm text-[0.92rem] leading-relaxed text-ink-soft">{f.body}</p>
                  </Reveal>
                ))}
                <div className="border-t border-rule" aria-hidden />
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
