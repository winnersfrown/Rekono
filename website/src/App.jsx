import { useState } from "react";
import { MotionConfig } from "framer-motion";
import Nav from "./components/Nav.jsx";
import Hero from "./components/Hero.jsx";
import ProofStrip from "./components/ProofStrip.jsx";
import HowItWorks from "./components/HowItWorks.jsx";
import Features from "./components/Features.jsx";
import Pricing from "./components/Pricing.jsx";
import FAQ from "./components/FAQ.jsx";
import FinalCTA from "./components/FinalCTA.jsx";
import Footer from "./components/Footer.jsx";
import MobileStickyCTA from "./components/MobileStickyCTA.jsx";
import ContactModal from "./components/ContactModal.jsx";

export default function App() {
  const [contactOpen, setContactOpen] = useState(false);

  return (
    // reducedMotion="user" is the one global switch every animated
    // component in this tree relies on: it makes every motion.* element
    // resolve straight to its end state, with no transition, whenever the
    // OS-level prefers-reduced-motion is set -- so no individual component
    // needs its own manual check (see Reveal.jsx).
    //
    // The decorative colour blobs and blueprint grid that used to sit
    // behind everything here are gone. They existed to give the glass
    // panels something to refract; there are no glass panels now, and a
    // ruled page on warm paper wants nothing floating behind it.
    <MotionConfig reducedMotion="user">
      <div id="top">
        <Nav />
        <main>
          <Hero />
          <ProofStrip />
          <HowItWorks />
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
