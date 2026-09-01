// The brand mark: a ledger cell with its top-right corner cut like a
// closed page, closed off by the same two rules a real statement ends
// on -- a thin one, then the heavier rule beneath it -- with the accent
// spent on exactly that closing rule. White fill with an ink outline
// rather than a filled badge, so it reads as paper sitting on the page
// instead of a colored tile floating over it, and holds its shape down
// to favicon size (the chamfer and corner radius are sized for that).
export default function Logomark({ className = "h-9 w-9" }) {
  return (
    <svg viewBox="0 0 200 200" className={className} aria-hidden="true">
      <path
        d="M44,16 L124,16 L184,76 L184,156 A28,28 0 0 1 156,184 L44,184 A28,28 0 0 1 16,156 L16,44 A28,28 0 0 1 44,16 Z"
        fill="#FFFFFF"
        stroke="#101A33"
        strokeWidth="7"
      />
      <line x1="48" y1="128" x2="152" y2="128" stroke="#101A33" strokeWidth="5" strokeLinecap="round" />
      <line x1="48" y1="150" x2="152" y2="150" stroke="#4B86F7" strokeWidth="11" strokeLinecap="round" />
    </svg>
  );
}
