import { useId } from "react";

// The brand mark: an "R" traced directly from Bitter Bold's own glyph
// outline (the exact typeface and weight the "Rekono" wordmark next to it
// is set in), not a generic geometric letterform or icon-font glyph. Shipped
// as a static path rather than live <text> so it renders identically
// everywhere -- a favicon or home-screen icon has no guarantee the page's
// own @font-face has loaded, or ever will. Traced with fontTools from
// public/fonts/bitter-600.woff2 instantiated at weight 800 (matching
// .brand's font-weight everywhere else); regenerate the same way if the
// wordmark's weight or typeface ever changes.
export default function Logomark({ className = "h-9 w-9" }) {
  // Nav and Footer both render this on the same page at once, so a literal
  // id="logomark-gradient" would collide -- two elements with the same id
  // is invalid SVG/HTML and leaves which one actually gets referenced up to
  // the browser. useId() makes each instance's gradient genuinely unique.
  const gradientId = `logomark-gradient-${useId()}`;
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true">
      <rect x="1" y="1" width="30" height="30" rx="8" fill={`url(#${gradientId})`} />
      <path
        d="M30.17 0V85.83L118 115.66L96.83 82.67V619.33L127.17 583.84L30.17 616.17V702L277.83 707H365.5Q489 707 551.83 655.5Q614.66 604 614.66 507.5Q614.66 422.5 563.16 366.33Q511.66 310.17 399.16 296.33L400.5 316Q439.5 315.83 464.75 306.08Q490 296.33 506.58 278.67Q523.16 261 536.16 236.33L613.5 90.33L565.17 120.66L659.83 85.83V0H476L386.33 190.33Q369.5 227.17 358.42 245.83Q347.33 264.5 332.25 270.75Q317.17 277 286.67 276.17L243.16 275.33L271 299V82.67L249 116.5L341.83 85.83V0ZM271 352.33 243.16 395.17H319.5Q379.33 395.17 408.5 420.42Q437.67 445.67 437.67 495.67Q437.67 536.67 414.83 560.25Q392 583.84 343.5 583.84H243.16L271 610Z"
        transform="translate(6.728,25.5) scale(0.026874,-0.026874)"
        fill="white"
      />
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="32" y2="32">
          <stop stopColor="#4b86f7" />
          <stop offset="1" stopColor="#1d4ed8" />
        </linearGradient>
      </defs>
    </svg>
  );
}
