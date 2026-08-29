import Reveal from "./Reveal.jsx";
import { APP_URL } from "../lib/constants.js";
import { trackEvent } from "../lib/analytics.js";

export default function FinalCTA({ onOpenContact }) {
  return (
    <section id="final-cta" className="py-2xl md:py-3xl">
      <Reveal className="mx-auto max-w-content px-lg md:px-xl">
        <div className="border-t border-rule pt-2xl">
          <div className="grid gap-xl md:grid-cols-[1fr_auto] md:items-end md:gap-3xl">
            <div>
              <span className="label">Get started</span>
              <h2 className="section-title mt-md max-w-[18ch]">Close the month with nothing left unexplained.</h2>
              <p className="mt-md max-w-measure text-[1rem] leading-relaxed text-ink-soft">
                Free to start, no card required. Or talk to us if you have a real set of books to move across and
                want the chart of accounts and matching rules built around them.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-md md:flex-col md:items-stretch">
              <a
                href={APP_URL}
                onClick={() => trackEvent("cta_click", { cta: "final_cta_primary" })}
                className="btn-primary px-xl py-md"
              >
                Get started free
              </a>
              <button
                type="button"
                onClick={() => {
                  trackEvent("cta_click", { cta: "final_cta_contact" });
                  onOpenContact();
                }}
                className="btn-secondary px-xl py-md"
              >
                Talk to us
              </button>
            </div>
          </div>
        </div>
      </Reveal>
    </section>
  );
}
