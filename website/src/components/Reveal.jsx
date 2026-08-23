import { motion } from "framer-motion";
import { fadeUp } from "../lib/motion.js";

// A scroll-triggered fade-up, once, with a floor under how far into the
// viewport it needs to be before firing (amount + margin below) so content
// already visible on load doesn't play a pointless animation on scroll 0.
// prefers-reduced-motion is handled globally, not per-component: App.jsx
// wraps the whole tree in <MotionConfig reducedMotion="user">, which makes
// every motion.* element (this one included) resolve straight to its "show"
// state with no transition when that OS preference is set -- content still
// appears, it just doesn't animate in. That matches what the old static
// site's own IntersectionObserver script did (reveal immediately, skip the
// motion), so there's no regression for anyone who set that preference.
export default function Reveal({ children, as: Tag = "div", className = "", delay = 0, ...rest }) {
  const MotionTag = motion[Tag] || motion.div;
  return (
    <MotionTag
      className={className}
      variants={fadeUp}
      initial="hidden"
      whileInView="show"
      viewport={{ once: true, amount: 0.2, margin: "0px 0px -8% 0px" }}
      transition={{ delay }}
      {...rest}
    >
      {children}
    </MotionTag>
  );
}
