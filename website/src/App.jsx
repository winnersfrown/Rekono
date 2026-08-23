import { useState } from "react";
import { MotionConfig, useReducedMotion } from "framer-motion";
import Nav from "./components/Nav.jsx";
import Hero from "./components/Hero.jsx";
import ProofStrip from "./components/ProofStrip.jsx";
import HowItWorks from "./components/HowItWorks.jsx";
import ScrollPipeline from "./components/ScrollPipeline.jsx";
import Features from "./components/Features.jsx";
import Pricing from "./components/Pricing.jsx";
import FAQ from "./components/FAQ.jsx";
import FinalCTA from "./components/FinalCTA.jsx";
import Footer from "./components/Footer.jsx";
import MobileStickyCTA from "./components/MobileStickyCTA.jsx";
import ContactModal from "./components/ContactModal.jsx";
import useIsDesktop from "./lib/useIsDesktop.js";

export default function App() {
  const [contactOpen, setContactOpen] = useState(false);
  const isDesktop = useIsDesktop();
  const reducedMotion = useReducedMotion();
  // ScrollPipeline's pinned scroll-scrub is an enhancement for the viewport
  // and motion preference it actually works well in -- not the default with
  // a lesser fallback for everyone else. Below 1024px it doesn't have room
  // for four corner callouts around the document without crowding; under
  // prefers-reduced-motion, a sequence whose entire point is continuous
  // scroll-linked movement is exactly what that preference exists to skip.
  // HowItWorks (the plain static list) is the right choice in both cases,
  // not a downgrade.
  const showScrollPipeline = isDesktop && !reducedMotion;

  return (
    // reducedMotion="user" is the one global switch every animated
    // component in this tree relies on: it makes every motion.* element
    // resolve straight to its end state, with no transition, whenever the
    // OS-level prefers-reduced-motion is set -- so no individual component
    // needs its own manual check (see Reveal.jsx and Hero.jsx's comments).
    <MotionConfig reducedMotion="user">
      <div className="bg-field" aria-hidden />
      <div className="bg-grid" aria-hidden />
      <div id="top" className="relative z-[1]">
        <Nav />
        <main>
          <Hero />
          <ProofStrip />
          {showScrollPipeline ? <ScrollPipeline /> : <HowItWorks />}
          <Features />
          <Pricing />
          <FAQ />
          <FinalCTA onOpenContact={() => setContactOpen(true)} />
        </main>
        <Footer />
      </div>
      <MobileStickyCTA />
      <ContactModal open={contactOpen} onClose={() => setContactOpen(false)} />
    </MotionConfig>
  );
}
