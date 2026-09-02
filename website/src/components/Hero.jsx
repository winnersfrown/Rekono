import { motion } from "framer-motion";
import { APP_URL, DEMO_URL, EASE } from "../lib/constants.js";
import { trackEvent } from "../lib/analytics.js";

// The hero's artifact is the workpaper, not a product screenshot and not a
// floating invoice card: a period's trial balance tying out, with the two
// exceptions the close found underneath it. That is the thesis of the whole
// product in one panel -- the books balance, and the software says what is
// missing rather than deciding for you -- and it is the one thing in this
// category nobody else puts on their homepage.
const TRIAL_BALANCE = [
  { code: "1000", name: "Cash", debit: "412,880.00", credit: "" },
  { code: "1200", name: "Accounts Receivable", debit: "186,240.00", credit: "" },
  { code: "2000", name: "Accounts Payable", debit: "", credit: "94,310.00" },
  { code: "3100", name: "Common Stock", debit: "", credit: "12,500.00" },
  { code: "4000", name: "Revenue", debit: "", credit: "638,410.00" },
  { code: "6100", name: "Operating Expenses", debit: "146,100.00", credit: "" },
];

const EXCEPTIONS = [
  {
    kind: "MISSING_EXPENSE",
    text: "Rent posted in 4 of the last 4 months (typically $4,000.00) and has nothing in 2026-05.",
  },
  {
    kind: "UNDEPRECIATED_ASSET",
    text: "Equipment holds $60,000.00 and no recurring entry posts against it.",
  },
];

function Workpaper() {
  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: EASE, delay: 0.1 }}
      className="panel w-full max-w-[560px] overflow-hidden"
    >
      <div className="flex items-baseline justify-between border-b border-rule px-lg py-md">
        <span className="label">Trial balance · 2026-05</span>
        <span className="label">Unadjusted</span>
      </div>

      <table className="w-full border-collapse text-[0.86rem]">
        <thead>
          <tr className="border-b border-rule-soft">
            <th className="label px-md py-sm text-left font-medium">Account</th>
            <th className="label py-sm pr-sm text-right font-medium">Debit</th>
            <th className="label py-sm pr-md text-right font-medium">Credit</th>
          </tr>
        </thead>
        <tbody>
          {/* max-w-0 w-full + truncate: the panel sits at a fixed 560px cap
              on a wide screen but shares the row with the copy column from
              768px up, and narrows further on a phone -- at both of the
              narrow widths "Accounts Receivable" used to wrap to a second
              line while the figures stayed put on the first, exactly the
              kind of misalignment this artifact's whole thesis (a ledger
              that ties out, precisely) can't afford. Truncating instead
              keeps every row one line at any panel width; the padding is
              fixed rather than widening past a breakpoint because the
              panel's own width depends on the two-column grid, not the
              viewport, so a viewport-keyed breakpoint re-tightens the
              account column exactly when the panel is narrowest (~768px). */}
          {TRIAL_BALANCE.map((row) => (
            <tr key={row.code} className="border-b border-rule-soft">
              <td className="max-w-0 w-full overflow-hidden text-ellipsis whitespace-nowrap px-md py-sm">
                <span className="code mr-sm text-muted">{row.code}</span>
                <span className="text-ink-soft">{row.name}</span>
              </td>
              <td className="figures py-sm pr-sm text-right text-ink">{row.debit}</td>
              <td className="figures py-sm pr-md text-right text-ink">{row.credit}</td>
            </tr>
          ))}
          {/* The double rule under a total is a real convention, not
              decoration: it is how a ruled statement says "this line is
              the sum of everything above it and nothing is missing". */}
          <tr className="border-b-4 border-double border-ink/70">
            <td className="px-md py-sm">
              <span className="label">Total</span>
            </td>
            <td className="figures py-sm pr-sm text-right font-medium text-ink">745,220.00</td>
            <td className="figures py-sm pr-md text-right font-medium text-ink">745,220.00</td>
          </tr>
        </tbody>
      </table>

      <div className="flex items-center gap-sm px-lg py-md text-[0.82rem] text-pos">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden className="flex-none">
          <path d="M20 6L9 17l-5-5" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        In balance to the cent.
      </div>

      <div className="border-t border-rule bg-paper-sunk px-lg py-md">
        <span className="label">Close found 2 exceptions</span>
        {/* No per-item entrance here. The panel as a whole already fades in
            once, and staggering two lines of text inside something that is
            itself still arriving is motion competing with motion. */}
        <ul className="mt-sm flex flex-col gap-sm">
          {EXCEPTIONS.map((e) => (
            <li key={e.kind} className="text-[0.82rem] leading-relaxed text-ink-soft">
              <span className="code mr-sm text-[0.72rem] text-accent-text">{e.kind}</span>
              {e.text}
            </li>
          ))}
        </ul>
      </div>
    </motion.div>
  );
}

export default function Hero() {
  return (
    <section className="pb-2xl pt-2xl md:pb-3xl md:pt-3xl">
      <div className="mx-auto grid max-w-content items-start gap-3xl px-lg md:grid-cols-[1.02fr_0.98fr] md:gap-2xl md:px-xl">
        <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, ease: EASE }}>
          <span className="label">Accrual accounting · Financial close</span>
          <h1 className="display mt-md">Close the books without guessing.</h1>
          <p className="mt-lg max-w-measure text-[1.08rem] leading-relaxed text-ink-soft">
            Rekono is a real double-entry general ledger with the accounts-payable work sitting in front of it.
            Invoices are read and checked before they post, revenue is recognised on a schedule, and the close tells
            you what the month is missing before you sign it off.
          </p>

          <div className="mt-xl flex flex-wrap items-center gap-md">
            <a
              href={APP_URL}
              onClick={() => trackEvent("cta_click", { cta: "hero_primary" })}
              className="btn-primary px-xl py-md"
            >
              Get started free
            </a>
            <a href="#the-month" className="btn-secondary px-xl py-md">
              See a month, end to end
            </a>
          </div>

          <p className="mt-lg max-w-measure text-[0.86rem] leading-relaxed text-muted">
            No card required. AI extraction included, no API key to supply.{" "}
            <a
              href={DEMO_URL}
              onClick={() => trackEvent("cta_click", { cta: "hero_demo" })}
              className="text-accent-text underline decoration-rule underline-offset-4 transition-colors hover:decoration-accent"
            >
              Or open the live demo with sample data
            </a>
            .
          </p>
        </motion.div>

        <div className="flex justify-center md:justify-end">
          <Workpaper />
        </div>
      </div>
    </section>
  );
}
