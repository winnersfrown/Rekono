import { PRIVACY_URL, TERMS_URL } from "../lib/constants.js";
import Logomark from "./Logomark.jsx";

const LINKS = [
  { href: "#the-month", label: "The month" },
  { href: "#ledger", label: "Ledger" },
  { href: "#pricing", label: "Pricing" },
  { href: "#faq", label: "FAQ" },
  { href: PRIVACY_URL, label: "Privacy" },
  { href: TERMS_URL, label: "Terms" },
];

export default function Footer() {
  return (
    <footer className="border-t border-rule bg-paper-sunk py-xl">
      <div className="mx-auto flex max-w-content flex-col gap-lg px-lg md:flex-row md:items-center md:justify-between md:px-xl">
        <div className="flex flex-col gap-xs">
          <a href="#top" className="flex items-center gap-sm font-display text-[1.05rem] font-semibold text-ink">
            <Logomark className="h-5 w-5" />
            Rekono
          </a>
          <span className="text-[0.84rem] text-muted">Accrual accounting and the financial close.</span>
        </div>
        <nav className="flex flex-wrap items-center gap-x-lg gap-y-sm text-[0.84rem] text-ink-soft">
          {LINKS.map((l) => (
            <a key={l.label} href={l.href} className="transition-colors hover:text-accent-text">
              {l.label}
            </a>
          ))}
        </nav>
      </div>
    </footer>
  );
}
