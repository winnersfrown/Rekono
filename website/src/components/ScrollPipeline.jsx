import { useRef, useState } from "react";
import { motion, useScroll, useTransform, useMotionValueEvent, AnimatePresence } from "framer-motion";
import { PIPELINE_STEPS as STEPS } from "../lib/pipelineSteps.js";
import { INVOICE, INVOICE_FIELDS } from "../lib/invoiceExample.js";
import { EASE } from "../lib/constants.js";

// Where each field flies to once it detaches from the document -- the four
// corners, so it reads as the document's own contents fanning outward
// rather than a random scatter. Keyed to INVOICE_FIELDS' own `key`s so
// there's one place (invoiceExample.js) that owns what the fields *are*,
// and one place (here) that owns where they go on screen. Document card is
// 340px wide (half: 170), callouts are 168px wide (half: 84) -- 254 is the
// exact clearance needed; 270 leaves a few px of real daylight.
const FIELD_TARGETS = {
  vendor: { x: -270, y: -98, rot: -3 },
  po: { x: 270, y: -98, rot: 3 },
  due: { x: -270, y: 98, rot: 3 },
  tax: { x: 270, y: 98, rot: -3 },
};

const STAGE_COUNT = STEPS.length; // 5: Upload, Read, Check, Review, Reconcile

function FieldCallout({ field, explode }) {
  const target = FIELD_TARGETS[field.key];
  // Each callout's own position/scale/opacity is a further transform of the
  // *shared* `explode` motion value (0 = still inside the document, 1 =
  // fully detached at its corner) -- not its own independent scroll
  // listener. One shared driver keeps all four in lockstep with each other
  // and with the document, the way genuinely exploded parts move together.
  const x = useTransform(explode, [0, 1], [0, target.x]);
  const y = useTransform(explode, [0, 1], [0, target.y]);
  const rotate = useTransform(explode, [0, 1], [0, target.rot]);
  const scale = useTransform(explode, [0, 0.4, 1], [0.5, 0.85, 1]);
  const opacity = useTransform(explode, [0, 0.25, 1], [0, 1, 1]);

  return (
    // Two elements, not one, and this split matters here specifically:
    // Framer writes x/y/rotate/scale as one combined inline `transform`,
    // which completely replaces (not composes with) a class-based
    // transform like Tailwind's -translate-x-1/2 -translate-y-1/2 -- so a
    // single element trying to do both "center myself on my anchor point"
    // (static, Tailwind's job) and "fly out to my target" (dynamic,
    // Framer's job) silently loses the centering the instant Framer's
    // style takes over, landing the whole card a half-width/half-height
    // off from where it should be. Confirmed by measuring the actual
    // rendered rects during debugging, not just suspected. The outer div
    // owns the static centering; the inner motion.div owns the explode.
    <div className="pointer-events-none absolute left-1/2 top-1/2 w-[168px] -translate-x-1/2 -translate-y-1/2">
      <motion.div style={{ x, y, rotate, scale, opacity }} className="glass-panel-strong rounded-xl p-3">
        <span className="font-mono text-[0.62rem] uppercase tracking-wide text-muted">{field.label}</span>
        <div className="mt-1 flex items-center justify-between gap-2">
          <span className="truncate font-mono text-[0.78rem] font-medium text-paper">{field.value}</span>
          <span
            className={`tabular-nums flex-none rounded-full px-1.5 py-0.5 font-mono text-[0.62rem] font-semibold ${
              field.flag ? "bg-amber/15 text-amber" : "bg-green/15 text-green"
            }`}
          >
            {field.conf}%
          </span>
        </div>
      </motion.div>
    </div>
  );
}

export default function ScrollPipeline() {
  const containerRef = useRef(null);
  const [activeStage, setActiveStage] = useState(0);

  // The pin is CSS position:sticky on a tall (380vh) ancestor, not a JS
  // scroll-hijack -- native scroll, trackpad momentum, and scrollbar
  // dragging all keep working exactly as they should; only *what's drawn*
  // inside the sticky viewport responds to how far through that tall
  // ancestor the page has scrolled.
  const { scrollYProgress } = useScroll({ target: containerRef, offset: ["start start", "end end"] });

  // One continuous 0..STAGE_COUNT position (e.g. 2.4 = 40% through stage
  // index 2, "Check"). Every other motion value below is a transform of
  // this one number, so the whole sequence is driven by a single source of
  // truth instead of STAGE_COUNT separate scroll listeners drifting out of
  // sync with each other.
  const stageProgress = useTransform(scrollYProgress, [0, 1], [0, STAGE_COUNT]);

  // The text panel (title/body/tag) can't be a CSS transform -- it's a
  // content swap -- so it needs real React state. Only set on the integer
  // part actually changing, not on every scroll-frame update of
  // stageProgress, or this would re-render on literally every scroll pixel.
  useMotionValueEvent(stageProgress, "change", (v) => {
    const idx = Math.min(STAGE_COUNT - 1, Math.max(0, Math.floor(v)));
    setActiveStage((prev) => (prev === idx ? prev : idx));
  });

  const docOpacity = useTransform(stageProgress, [0, 0.4], [0, 1]);
  const docY = useTransform(stageProgress, [0, 0.4], [22, 0]);

  // The OCR "reading" sweep -- visible only during stage 1 (Read), a
  // horizontal highlight moving down the document.
  const scanOpacity = useTransform(stageProgress, [0.85, 1.05, 1.85, 2.05], [0, 1, 1, 0]);
  const scanY = useTransform(stageProgress, [1, 2], ["6%", "94%"]);

  // The disassembly itself: rises through the back half of "Read" into
  // "Check" (so the fields feel like they're being *pulled out* by the
  // scan rather than popping the instant stage 2 begins), holds fully
  // detached through "Check" and "Review", then retracts during
  // "Reconcile" as the document closes back up around its now-verified
  // data.
  const explode = useTransform(stageProgress, [1.5, 2.3, 3.85, 4.5], [0, 1, 1, 0]);

  // The flagged field (due date, 61%) gets its own extra emphasis during
  // "Review" -- a ring pulse -- since that's the one stage that's
  // specifically about *this* field, not all four equally.
  const reviewRing = useTransform(stageProgress, [2.6, 3.0, 3.5, 3.9], [0, 1, 1, 0]);

  // The match confirmation that closes the sequence: a "PO-4421 matched"
  // chip fading in as the fields retract, standing in for the reconciliation
  // step without trying to animate an actual matching algorithm.
  const matchOpacity = useTransform(stageProgress, [3.75, 4.05, 4.85, 5], [0, 1, 1, 0]);

  // A soft glow behind the document at the moment of disassembly -- the one
  // purely decorative touch, kept subtle (peaks at 0.4 opacity) so it reads
  // as emphasis, not a light show.
  const glowOpacity = useTransform(stageProgress, [1.6, 2.2, 3.9, 4.4], [0, 0.4, 0.4, 0]);

  // The flagged field's own pulse ring rides on top of its normal explode
  // position -- same x/y transform as its FieldCallout, computed here too
  // (rather than passed down) since the ring is a sibling overlay, not a
  // child of that callout.
  const reviewX = useTransform(explode, [0, 1], [0, FIELD_TARGETS.due.x]);
  const reviewY = useTransform(explode, [0, 1], [0, FIELD_TARGETS.due.y]);
  const reviewScale = useTransform(reviewRing, [0, 1], [0.85, 1.15]);

  // The rail fill tracks raw scroll progress directly (not stageProgress),
  // so it's perfectly smooth rather than jumping in five discrete steps
  // like the dots themselves do.
  const railFill = useTransform(scrollYProgress, [0, 1], ["0%", "100%"]);

  const step = STEPS[activeStage];

  return (
    <section id="how-it-works" ref={containerRef} className="relative" style={{ height: "380vh" }}>
      <div className="sticky top-0 flex h-screen flex-col items-center justify-center overflow-hidden px-7 py-10">
        <div className="mx-auto w-full max-w-2xl text-center">
          <span className="font-mono text-[0.78rem] font-semibold uppercase tracking-widest text-blue-bright">
            How it works
          </span>
          <h2 className="mt-3 text-[2.1rem]">Watch a real invoice move through the pipeline.</h2>
        </div>

        {/* Progress rail -- five numbered dots on a filling line, echoing
            the same rail-and-numbered-circle motif the static fallback
            list uses, so switching between them (resize, motion
            preference) doesn't feel like two unrelated designs. */}
        <div className="relative mt-10 flex w-full max-w-md items-center justify-between">
          <div className="absolute left-5 right-5 top-1/2 h-px -translate-y-1/2 bg-line" aria-hidden />
          <motion.div
            className="absolute left-5 top-1/2 h-px -translate-y-1/2 bg-blue-bright"
            style={{ width: railFill, maxWidth: "calc(100% - 2.5rem)" }}
            aria-hidden
          />
          {STEPS.map((s, i) => (
            <div key={s.n} className="relative z-10 flex flex-col items-center gap-1.5">
              <div
                className={`flex h-10 w-10 items-center justify-center rounded-full border font-display text-sm font-bold transition-colors duration-300 ${
                  i <= activeStage
                    ? "border-blue-bright bg-blue-bright text-white shadow-glow"
                    : "border-line bg-white text-muted"
                }`}
              >
                {s.n}
              </div>
            </div>
          ))}
        </div>

        {/* The document + exploded fields. Fixed pixel dimensions (not
            responsive units) on purpose -- the four callouts' target
            positions in FIELD_TARGETS are pixel offsets from this box's own
            center, so the box and its callouts have to scale together as
            one unit or the callouts drift off their corners. Taller than
            the doc card itself needs, with real margin to the corner
            targets: the callouts are position:absolute, which takes them
            out of flow entirely -- a sibling's margin-top is computed
            against *this box's* fixed height, not against wherever an
            absolutely-positioned child visually ends up, so if a callout's
            bottom edge went past this box's own edge it would silently
            overlap the stage text below no matter how much margin that
            text had. */}
        <div className="relative mt-10 flex h-[360px] w-full items-center justify-center">
          <motion.div
            style={{ opacity: glowOpacity }}
            className="pointer-events-none absolute h-[280px] w-[280px] rounded-full bg-blue blur-[80px]"
            aria-hidden
          />

          <motion.div
            style={{ opacity: docOpacity, y: docY }}
            className="glass-panel-strong relative w-[340px] rounded-2xl p-5"
          >
            <div className="flex items-start justify-between border-b border-line-soft pb-3">
              <div>
                <span className="font-mono text-[0.64rem] uppercase tracking-wide text-muted">
                  Invoice · {INVOICE.number}
                </span>
                <div className="mt-1 font-display text-base font-bold text-paper">{INVOICE.vendor}</div>
              </div>
              <span className="font-mono text-[0.64rem] text-muted">{INVOICE.date}</span>
            </div>
            <div className="flex flex-col gap-2 py-3">
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-2 rounded-full bg-line-soft" style={{ width: `${88 - i * 14}%` }} />
              ))}
            </div>
            <div className="flex items-center justify-between border-t border-line-soft pt-3">
              <span className="text-[0.72rem] text-muted">Total</span>
              <span className="tabular-nums font-display text-base font-bold text-paper">{INVOICE.total}</span>
            </div>

            {/* The OCR sweep -- a soft highlighted band, not a literal laser
                line, so it reads as "reading this row" rather than a scanner
                prop. */}
            <motion.div
              style={{ top: scanY, opacity: scanOpacity }}
              className="pointer-events-none absolute left-3 right-3 h-7 -translate-y-1/2 rounded-md bg-blue/15 ring-1 ring-blue/30"
              aria-hidden
            />
          </motion.div>

          {INVOICE_FIELDS.map((f) => (
            <FieldCallout key={f.key} field={f} explode={explode} />
          ))}

          {/* The one field the "Review" stage is actually about gets a
              pulse ring the other three don't -- singling it out rather
              than treating all four as equally in need of a human. Same
              outer-static/inner-motion split as FieldCallout, for the same
              reason: Framer's x/y/scale would otherwise silently clobber
              the -translate-x/y-1/2 centering. */}
          <div className="pointer-events-none absolute left-1/2 top-1/2 h-[74px] w-[168px] -translate-x-1/2 -translate-y-1/2">
            <motion.div
              style={{ x: reviewX, y: reviewY, opacity: reviewRing, scale: reviewScale }}
              className="h-full w-full rounded-xl ring-2 ring-amber"
              aria-hidden
            />
          </div>

          <motion.div
            style={{ opacity: matchOpacity }}
            className="pointer-events-none absolute bottom-0 flex items-center gap-1.5 rounded-full bg-green/15 px-3 py-1.5 font-mono text-[0.72rem] font-semibold text-green"
          >
            <span aria-hidden>✓</span> Matched to PO-4421
          </motion.div>
        </div>

        {/* Stage copy: a real content swap (not a CSS transform), crossfaded
            on activeStage change. This is the one part of the sequence that
            can't just interpolate -- five sentences don't have a meaningful
            "60% between them" the way a position does. */}
        <div className="relative mt-8 h-[92px] w-full max-w-lg text-center">
          <AnimatePresence mode="wait">
            <motion.div
              key={activeStage}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.3, ease: EASE }}
              className="absolute inset-0"
            >
              <h3 className="text-[1.15rem]">{step.title}</h3>
              <p className="mx-auto mt-1.5 max-w-md text-[0.88rem] leading-relaxed text-paper-dim">{step.body}</p>
              <span className="mt-2 inline-block rounded-full bg-blue/10 px-2.5 py-0.5 font-mono text-[0.66rem] font-medium uppercase tracking-wide text-blue-deep">
                {step.tag}
              </span>
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
    </section>
  );
}
