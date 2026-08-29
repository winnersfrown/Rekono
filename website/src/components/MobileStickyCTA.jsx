import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { APP_URL } from "../lib/constants.js";
import { trackEvent } from "../lib/analytics.js";

// Only past the hero, and only on small screens (the hero already has its
// own full-size CTA in view there, so a second one stacked on top of it
// would just be noise). Desktop never sees this at all -- see the md:hidden
// on the wrapper below -- there's always a nav CTA in view there instead.
export default function MobileStickyCTA() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const onScroll = () => setVisible(window.scrollY > window.innerHeight * 0.6);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ y: 80, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 80, opacity: 0 }}
          transition={{ duration: 0.25 }}
          className="fixed inset-x-0 bottom-0 z-40 border-t border-rule bg-paper p-md md:hidden"
        >
          <a
            href={APP_URL}
            onClick={() => trackEvent("cta_click", { cta: "mobile_sticky" })}
            className="btn-primary w-full py-md"
          >
            Get started free
          </a>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
