// The brand mark: an "R" traced directly from Fraunces' own outline at the
// optical size and weight the "Rekono" wordmark beside it is set in (opsz
// 120, wght 600), not a generic geometric letterform or an icon-font glyph.
// Shipped as a static path rather than live <text> so it renders identically
// everywhere -- a favicon or home-screen icon has no guarantee the page's
// own @font-face has loaded, or ever will.
//
// Regenerate the same way if the wordmark's typeface, weight, or optical
// size changes: instantiate public/fonts/fraunces.woff2 at that location
// with fontTools, draw the R through SVGPathPen, round the coordinates to
// whole font units (upm 2000 drawn at 32px, so a unit is far under a pixel),
// and keep website/public/favicon.svg in step with it.
//
// No gradient, deliberately. A gradient fill was the previous identity's
// tell; this one is a flat oxblood field with the letter knocked out of it,
// which is what a seal or a ledger binding actually looks like.
const R_PATH =
  "M1242 911Q1242 810 1197 729Q1152 648 1071 596Q989 543 877 523Q857 520 835 517Q814 515 792 513Q770 512 746 512Q668 512 609 522Q551 532 506 551Q462 570 425 599L435 616Q469 588 506 572Q544 556 586 549Q628 542 674 542Q803 542 881 629Q959 717 959 899Q959 1038 908 1147Q857 1256 768 1318Q680 1380 569 1380H481V68Q481 49 490 40Q499 31 520 27L601 15Q607 14 610 13Q613 11 613 7Q613 0 603 0H79Q74 0 71 2Q69 4 69 7Q69 13 81 15L162 27Q182 31 191 40Q201 49 201 68V1345Q201 1357 191 1363Q182 1370 162 1373L81 1385Q69 1387 69 1393Q69 1396 71 1398Q74 1400 79 1400H568Q779 1400 930 1339Q1081 1279 1161 1169Q1242 1059 1242 911ZM684 530 945 560 1233 80Q1254 46 1278 34Q1301 22 1331 15Q1338 13 1341 12Q1343 11 1343 7Q1343 4 1341 2Q1338 0 1333 0H875Q865 0 865 7Q865 11 868 12Q871 12 877 15L919 23Q944 31 949 46Q955 60 937 92Z";

export default function Logomark({ className = "h-9 w-9" }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true">
      <rect width="32" height="32" rx="3" fill="var(--accent)" />
      <path d={R_PATH} transform="translate(7.43,24.5) scale(0.012143,-0.012143)" fill="var(--paper)" />
    </svg>
  );
}
