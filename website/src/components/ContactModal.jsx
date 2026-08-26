import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { APP_URL } from "../lib/constants.js";
import { trackEvent } from "../lib/analytics.js";

const MAILTO_FALLBACK = "mailto:wfrownusa@yahoo.com?subject=Rekono%20contact%20form";

export default function ContactModal({ open, onClose }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  // Honeypot: a field real visitors never see or fill in (aria-hidden,
  // tabindex -1, autocomplete off), but a naive bot filling every input on
  // the page will. Any submission with this non-empty is silently treated
  // as spam server-side -- see routes/contact.js -- so this just has to
  // exist and stay wired up, not do anything clever itself.
  const [company, setCompany] = useState("");
  const [status, setStatus] = useState(null); // { kind: 'ok' | 'error', text }
  const [submitting, setSubmitting] = useState(false);
  const nameRef = useRef(null);

  useEffect(() => {
    if (open) {
      setStatus(null);
      // Focus the first field on open, same as the modal it replaces --
      // matters for anyone opening it with a keyboard or screen reader.
      setTimeout(() => nameRef.current?.focus(), 50);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  async function handleSubmit(e) {
    e.preventDefault();
    setSubmitting(true);
    setStatus(null);
    try {
      const res = await fetch(`${APP_URL}/api/contact`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), email: email.trim(), message: message.trim(), company }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        // The one genuine lead-conversion event on this page -- distinct
        // from a cta_click, which only proves a button was clicked, not
        // that a real message went through.
        trackEvent("generate_lead", { form: "contact" });
        setStatus({ kind: "ok", text: "Message sent — we'll get back to you within 1 business day." });
        setName("");
        setEmail("");
        setMessage("");
      } else {
        setStatus({ kind: "error", text: body?.detail || "Something went wrong." });
      }
    } catch {
      setStatus({ kind: "error", text: "Couldn't reach the server." });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="absolute inset-0 bg-paper/40 backdrop-blur-sm"
          />
          <motion.div
            initial={{ opacity: 0, scale: 0.96, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 10 }}
            transition={{ duration: 0.2 }}
            role="dialog"
            aria-modal="true"
            aria-labelledby="contact-modal-title"
            className="glass-panel-strong relative w-full max-w-[440px] rounded-2xl p-7"
          >
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="absolute right-4 top-4 flex h-8 w-8 items-center justify-center rounded-full text-muted hover:bg-ink-850 hover:text-paper"
            >
              ×
            </button>
            <h2 id="contact-modal-title" className="text-[1.3rem]">Talk to us</h2>
            <p className="mt-1.5 text-[0.88rem] text-muted">
              Tell us a bit about what you're looking for. We reply within 1 business day.
            </p>

            <form onSubmit={handleSubmit} className="mt-5 flex flex-col gap-4">
              <label className="flex flex-col gap-1.5 text-[0.82rem] font-medium text-paper-dim">
                Name
                <input
                  ref={nameRef}
                  type="text"
                  required
                  maxLength={256}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="rounded-lg border border-line bg-white px-3 py-2 text-[0.92rem] text-paper focus:border-blue focus:outline-none focus:ring-2 focus:ring-blue/20"
                />
              </label>
              <label className="flex flex-col gap-1.5 text-[0.82rem] font-medium text-paper-dim">
                Email
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="rounded-lg border border-line bg-white px-3 py-2 text-[0.92rem] text-paper focus:border-blue focus:outline-none focus:ring-2 focus:ring-blue/20"
                />
              </label>
              <label className="flex flex-col gap-1.5 text-[0.82rem] font-medium text-paper-dim">
                Message
                <textarea
                  required
                  rows={4}
                  maxLength={5000}
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  className="resize-y rounded-lg border border-line bg-white px-3 py-2 text-[0.92rem] text-paper focus:border-blue focus:outline-none focus:ring-2 focus:ring-blue/20"
                />
              </label>
              {/* Off-screen, not display:none -- a screen reader still needs
                  to be told to skip it (aria-hidden), but a bot's DOM
                  scraper that ignores CSS visibility would still find and
                  fill a display:none field just as easily as a visible one. */}
              <div className="absolute -left-[9999px]" aria-hidden="true">
                <label>
                  Company
                  <input type="text" tabIndex={-1} autoComplete="off" value={company} onChange={(e) => setCompany(e.target.value)} />
                </label>
              </div>
              <button
                type="submit"
                disabled={submitting}
                className="mt-1 rounded-xl bg-gradient-to-b from-blue to-blue-deep px-5 py-3 font-semibold text-white shadow-md transition-opacity disabled:opacity-60"
              >
                {submitting ? "Sending…" : "Send message"}
              </button>
            </form>

            {status && (
              <div
                className={`mt-4 rounded-lg px-3.5 py-2.5 text-[0.85rem] ${
                  status.kind === "ok" ? "bg-green/10 text-green" : "bg-amber/10 text-amber"
                }`}
              >
                {status.text}
                {status.kind === "error" && (
                  <>
                    {" "}
                    <a href={MAILTO_FALLBACK} className="font-semibold underline">
                      Email us directly instead →
                    </a>
                  </>
                )}
              </div>
            )}
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
