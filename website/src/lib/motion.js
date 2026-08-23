import { EASE } from "./constants.js";

// A single, reused entrance shape: fade up 20px. Applied via
// whileInView/viewport rather than a scroll listener + IntersectionObserver
// hand-rolled in a <script> tag (the previous static site's approach) --
// Framer Motion's viewport prop already debounces this correctly and
// respects prefers-reduced-motion when combined with useReducedMotion,
// which every component that uses this also checks (see Reveal.jsx).
export const fadeUp = {
  hidden: { opacity: 0, y: 22 },
  show: { opacity: 1, y: 0, transition: { duration: 0.6, ease: EASE } },
};

// For a group of siblings (feature cards, pricing tiers, FAQ rows): the
// parent orchestrates a small stagger so items arrive as a wave rather than
// all at once, which reads as considered rather than as a single dump.
export function staggerContainer(staggerChildren = 0.09) {
  return {
    hidden: {},
    show: { transition: { staggerChildren, delayChildren: 0.05 } },
  };
}
