"""Reconciliation engine: fuzzy-matches an invoice against a list of
candidate PO or bank-transaction entries.

Pure functions here (no DB access) so the matching logic is unit-testable
in isolation -- this is the "constraint matching" core of the product.
"""

from dataclasses import dataclass
from datetime import date

from rapidfuzz import fuzz

from .config import get_settings


@dataclass
class MatchCandidateEntry:
    id: str
    vendor: str
    amount: float | None
    entry_date: date | None
    reference: str


@dataclass
class MatchOutcome:
    status: str  # "matched" | "partial" | "unmatched"
    score: float  # 0-100
    reasoning: str
    entry_id: str | None


def find_best_match(
    invoice_vendor: str,
    invoice_amount: float | None,
    invoice_date: date | None,
    invoice_po_reference: str,
    candidates: list[MatchCandidateEntry],
) -> MatchOutcome:
    settings = get_settings()

    if not candidates:
        return MatchOutcome("unmatched", 0.0, "No PO/bank entries uploaded to match against.", None)

    best: MatchOutcome | None = None
    for entry in candidates:
        outcome = _score_pair(
            invoice_vendor, invoice_amount, invoice_date, invoice_po_reference, entry, settings
        )
        if best is None or outcome.score > best.score:
            best = outcome

    return best  # type: ignore[return-value]


def _score_pair(
    invoice_vendor: str,
    invoice_amount: float | None,
    invoice_date: date | None,
    invoice_po_reference: str,
    entry: MatchCandidateEntry,
    settings,
) -> MatchOutcome:
    vendor_score = fuzz.token_sort_ratio(invoice_vendor or "", entry.vendor or "")
    vendor_ok = vendor_score >= settings.match_vendor_score_threshold

    reference_hit = bool(
        invoice_po_reference and entry.reference and invoice_po_reference.strip().lower() == entry.reference.strip().lower()
    )

    amount_ok = None
    amount_detail = "amount not comparable"
    if invoice_amount is not None and entry.amount is not None:
        diff = abs(invoice_amount - entry.amount)
        tolerance = max(settings.match_amount_tolerance_abs, invoice_amount * settings.match_amount_tolerance_pct)
        amount_ok = diff <= tolerance
        amount_detail = f"amount diff ${diff:.2f} ({'within' if amount_ok else 'outside'} tolerance ${tolerance:.2f})"

    date_ok = None
    date_detail = "date not comparable"
    if invoice_date is not None and entry.entry_date is not None:
        day_diff = abs((invoice_date - entry.entry_date).days)
        date_ok = day_diff <= settings.match_date_window_days
        date_detail = f"date diff {day_diff}d ({'within' if date_ok else 'outside'} {settings.match_date_window_days}d window)"

    # Composite score: vendor similarity dominates, amount/date corroborate.
    composite = 0.5 * vendor_score
    composite += 30 if amount_ok else (0 if amount_ok is False else 15)
    composite += 20 if date_ok else (0 if date_ok is False else 10)
    if reference_hit:
        composite = min(100.0, composite + 15)

    reasoning = f"vendor '{invoice_vendor}' vs '{entry.vendor}' = {vendor_score:.0f}/100; {amount_detail}; {date_detail}."
    if reference_hit:
        reasoning += " PO/reference number matches exactly."

    if reference_hit or (vendor_ok and amount_ok and (date_ok is not False)):
        status = "matched"
    elif vendor_ok and (amount_ok or amount_ok is None):
        status = "partial"
    elif vendor_ok or amount_ok:
        status = "partial"
    else:
        status = "unmatched"

    return MatchOutcome(status=status, score=round(composite, 2), reasoning=reasoning, entry_id=entry.id)
