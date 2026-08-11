from datetime import date

from app.matching import MatchCandidateEntry, find_best_match


def test_exact_vendor_amount_date_match():
    candidates = [
        MatchCandidateEntry(id="1", vendor="Acme Supplies Inc", amount=1000.00, entry_date=date(2026, 1, 5), reference="PO-100"),
    ]
    outcome = find_best_match("Acme Supplies Inc", 1000.00, date(2026, 1, 5), "", candidates)
    assert outcome.status == "matched"
    assert outcome.entry_id == "1"


def test_amount_within_tolerance_still_matches():
    candidates = [
        MatchCandidateEntry(id="1", vendor="Acme Supplies Inc", amount=1002.00, entry_date=date(2026, 1, 5), reference=""),
    ]
    outcome = find_best_match("Acme Supplies Inc", 1000.00, date(2026, 1, 5), "", candidates)
    assert outcome.status == "matched"


def test_completely_different_vendor_and_amount_is_unmatched():
    candidates = [
        MatchCandidateEntry(id="1", vendor="Totally Different Co", amount=50.00, entry_date=date(2020, 1, 1), reference=""),
    ]
    outcome = find_best_match("Acme Supplies Inc", 1000.00, date(2026, 1, 5), "", candidates)
    assert outcome.status == "unmatched"


def test_vendor_matches_but_amount_way_off_is_partial():
    candidates = [
        MatchCandidateEntry(id="1", vendor="Acme Supplies Inc", amount=50.00, entry_date=date(2026, 1, 5), reference=""),
    ]
    outcome = find_best_match("Acme Supplies Inc", 1000.00, date(2026, 1, 5), "", candidates)
    assert outcome.status == "partial"


def test_no_candidates_is_unmatched():
    outcome = find_best_match("Acme", 100.0, date(2026, 1, 1), "", [])
    assert outcome.status == "unmatched"
    assert outcome.entry_id is None


def test_po_reference_exact_match_boosts_score():
    candidates = [
        MatchCandidateEntry(id="1", vendor="Acme Supplies Inc", amount=1000.00, entry_date=date(2026, 1, 5), reference="PO-42"),
    ]
    outcome = find_best_match("Acme Supplies Inc", 1000.00, date(2026, 1, 5), "PO-42", candidates)
    assert outcome.status == "matched"
    assert "reference" in outcome.reasoning.lower()
