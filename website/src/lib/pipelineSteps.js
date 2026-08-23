// Five real stages a document passes through, not a marketing
// simplification -- shared between the two ways this gets rendered:
// ScrollPipeline (the pinned, scroll-scrubbed version) and HowItWorks (the
// static list it falls back to on mobile and under prefers-reduced-motion).
// Kept in one place so the two never drift out of sync with each other.
export const PIPELINE_STEPS = [
  {
    n: "01",
    title: "Upload",
    body: "Drop in a PDF or a photo of an invoice, one at a time or as a batch. It's queued immediately and processed in the background; nothing blocks on the upload.",
    tag: "async job queue",
  },
  {
    n: "02",
    title: "Read",
    body: "OCR lifts the raw text from the page, then a language model parses it into a fixed schema: vendor, dates, PO reference, line items, tax, and totals.",
    tag: "OCR + structured extraction",
  },
  {
    n: "03",
    title: "Check",
    body: "Line items are summed and compared against the stated total. Every field also carries its own self-reported confidence score.",
    tag: "automatic cross-check",
  },
  {
    n: "04",
    title: "Review",
    body: "Anything below the confidence bar, or that fails the cross-check, lands in the review queue. Source document and extracted fields sit side by side; corrections are one click and get logged.",
    tag: "human-in-the-loop",
  },
  {
    n: "05",
    title: "Reconcile & export",
    body: "Approved invoices are fuzzy-matched against your PO list or bank statement (vendor name, amount tolerance, date window), then exported to CSV or Excel, or synced onward.",
    tag: "matching engine + export",
  },
];
