import { PRIVACY_URL, TERMS_URL } from "../lib/constants.js";
import Logomark from "./Logomark.jsx";

const LINKS = [
  { href: "#how-it-works", label: "How It Works" },
  { href: "#features", label: "Features" },
  { href: "#pricing", label: "Pricing" },
  { href: "#faq", label: "FAQ" },
  { href: PRIVACY_URL, label: "Privacy" },
  { href: TERMS_URL, label: "Terms" },
];

export default function Footer() {
  return (
    <footer className="border-t border-line-soft py-10">
      <div className="mx-auto flex max-w-content flex-col items-center gap-6 px-7 text-center md:flex-row md:justify-between md:text-left">
        <div className="flex flex-col items-center gap-1.5 md:items-start">
          <a href="#top" className="flex items-center gap-2 font-display text-[1.05rem] font-bold text-paper">
            <Logomark className="h-5 w-5" />
            Rekono
          </a>
          <span className="text-[0.85rem] text-muted">Invoices, read and checked before they hit your books.</span>
        </div>
        <nav className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-[0.85rem] text-paper-dim">
          {LINKS.map((l) => (
            <a key={l.label} href={l.href} className="hover:text-paper">
              {l.label}
            </a>
          ))}
        </nav>
      </div>
    </footer>
  );
}
