import Reveal from "./Reveal.jsx";
import { APP_URL } from "../lib/constants.js";

export default function FinalCTA({ onOpenContact }) {
  return (
    <section id="final-cta" className="py-16">
      <Reveal className="glass-tint mx-auto flex max-w-content flex-col items-center rounded-3xl px-7 py-12 text-center">
        <span className="font-mono text-[0.78rem] font-semibold uppercase tracking-widest text-blue-bright">
          Get started
        </span>
        <h2 className="mt-4 text-[2.2rem]">Stop retyping invoices.</h2>
        <p className="mt-3 max-w-[520px] text-[1rem] text-paper-dim">
          Get started free, no card required, or talk to us if you've got a real pile of invoices and want to build
          the matching rules around them together.
        </p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-4">
          <a
            href={APP_URL}
            className="rounded-xl bg-gradient-to-b from-blue to-blue-deep px-7 py-3.5 font-semibold text-white shadow-md transition-transform duration-150 hover:-translate-y-0.5 hover:shadow-glow"
          >
            Get started
          </a>
          <button
            type="button"
            onClick={onOpenContact}
            className="font-medium text-blue-bright underline decoration-blue/30 underline-offset-4 hover:text-blue-deep"
          >
            Talk to us about a design partnership →
          </button>
        </div>
      </Reveal>
    </section>
  );
}
