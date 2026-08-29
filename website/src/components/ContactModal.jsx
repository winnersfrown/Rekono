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
            className="absolute inset-0 bg-ink/25"
          />
          <motion.div
            initial={{ opacity: 0, scale: 0.96, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 10 }}
            transition={{ duration: 0.2 }}
            role="dialog"
            aria-modal="true"
            aria-labelledby="contact-modal-title"
            className="panel relative w-full max-w-[440px] p-xl shadow-modal"
          >
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="absolute right-md top-md flex h-8 w-8 items-center justify-center rounded text-muted transition-colors hover:text-ink"
            >
              ×
            </button>
            <h2 id="contact-modal-title" className="panel-title">Talk to us</h2>
            <p className="mt-sm text-[0.88rem] text-ink-soft">
              Tell us a bit about what you're looking for. We reply within 1 business day.
            </p>

            <form onSubmit={handleSubmit} className="mt-lg flex flex-col gap-md">
              <label className="flex flex-col gap-xs text-[0.82rem] font-medium text-ink-soft">
                Name
                <input
                  ref={nameRef}
                  type="text"
                  required
                  maxLength={256}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="rounded border border-rule bg-paper-rise px-md py-sm text-[0.92rem] text-ink transition-colors focus:border-accent focus:outline-none"
                />
              </label>
              <label className="flex flex-col gap-xs text-[0.82rem] font-medium text-ink-soft">
                Email
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="rounded border border-rule bg-paper-rise px-md py-sm text-[0.92rem] text-ink transition-colors focus:border-accent focus:outline-none"
                />
              </label>
              <label className="flex flex-col gap-xs text-[0.82rem] font-medium text-ink-soft">
                Message
                <textarea
                  required
                  rows={4}
                  maxLength={5000}
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  className="resize-y rounded border border-rule bg-paper-rise px-md py-sm text-[0.92rem] text-ink transition-colors focus:border-accent focus:outline-none"
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
                className="btn-primary mt-xs py-md transition-opacity disabled:opacity-60"
              >
                {submitting ? "Sending…" : "Send message"}
              </button>
            </form>

            {status && (
              <div
                className={`mt-md border px-md py-sm text-[0.85rem] ${
                  status.kind === "ok" ? "border-pos/30 bg-pos/5 text-pos" : "border-neg/30 bg-neg/5 text-neg"
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
