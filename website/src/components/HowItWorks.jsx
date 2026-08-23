import Reveal from "./Reveal.jsx";
import { PIPELINE_STEPS as STEPS } from "../lib/pipelineSteps.js";

// The static, always-scrollable rendering of the five pipeline stages --
// used directly on narrow viewports and under prefers-reduced-motion,
// where ScrollPipeline's pinned scroll-scrub (see App.jsx) is the wrong
// choice rather than a lesser one: no scroll-jacking on touch, and nothing
// that keeps moving once someone's told their OS motion is unwanted.
export default function HowItWorks() {
  return (
    <section id="how-it-works" className="py-24">
      <div className="mx-auto max-w-content px-7">
        <Reveal className="mx-auto max-w-2xl text-center">
          <span className="font-mono text-[0.78rem] font-semibold uppercase tracking-widest text-blue-bright">
            How it works
          </span>
          <h2 className="mt-3 text-[2.1rem]">One pipeline, from inbox to reconciled record.</h2>
          <p className="mt-3 text-[1rem] text-paper-dim">
            Five steps, in order: each one a real stage the document passes through, not a marketing simplification.
          </p>
        </Reveal>

        <div className="relative mt-16 flex flex-col gap-10">
          {/* One continuous rail down the left, behind every step number --
              a single visual thread tying the five stages into one pipeline
              instead of five separate cards that happen to be stacked. */}
          <div className="absolute left-[27px] top-3 bottom-3 hidden w-px bg-line md:block" aria-hidden />

          {STEPS.map((s, i) => (
            <Reveal key={s.n} delay={i * 0.05} className="relative flex gap-6 md:gap-8">
              <div className="relative z-10 flex h-14 w-14 flex-none items-center justify-center rounded-full border border-line bg-white font-display text-lg font-bold text-blue-deep shadow-sm">
                {s.n}
              </div>
              <div className="glass-panel flex-1 rounded-2xl p-6 md:p-7">
                <h3 className="text-[1.3rem]">{s.title}</h3>
                <p className="mt-2 max-w-[620px] text-[0.95rem] leading-relaxed text-paper-dim">{s.body}</p>
                <span className="mt-4 inline-block rounded-full bg-blue/10 px-3 py-1 font-mono text-[0.7rem] font-medium uppercase tracking-wide text-blue-deep">
                  {s.tag}
                </span>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
