import { findBestMatch } from "../src/matching.js";

function entry(id, vendor, amount, entryDate, reference = "") {
  return { id, vendor, amount, entryDate, reference };
}

test("exact vendor amount date match", () => {
  const candidates = [entry("1", "Acme Supplies Inc", 1000.0, "2026-01-05", "PO-100")];
  const outcome = findBestMatch("Acme Supplies Inc", 1000.0, "2026-01-05", "", candidates);
  expect(outcome.status).toBe("matched");
  expect(outcome.entryId).toBe("1");
});

test("amount within tolerance still matches", () => {
  const candidates = [entry("1", "Acme Supplies Inc", 1002.0, "2026-01-05")];
  const outcome = findBestMatch("Acme Supplies Inc", 1000.0, "2026-01-05", "", candidates);
  expect(outcome.status).toBe("matched");
});

test("completely different vendor and amount is unmatched", () => {
  const candidates = [entry("1", "Totally Different Co", 50.0, "2020-01-01")];
  const outcome = findBestMatch("Acme Supplies Inc", 1000.0, "2026-01-05", "", candidates);
  expect(outcome.status).toBe("unmatched");
});

test("vendor matches but amount way off is partial", () => {
  const candidates = [entry("1", "Acme Supplies Inc", 50.0, "2026-01-05")];
  const outcome = findBestMatch("Acme Supplies Inc", 1000.0, "2026-01-05", "", candidates);
  expect(outcome.status).toBe("partial");
});

test("no candidates is unmatched", () => {
  const outcome = findBestMatch("Acme", 100.0, "2026-01-01", "", []);
  expect(outcome.status).toBe("unmatched");
  expect(outcome.entryId).toBeNull();
});

test("po reference exact match boosts score", () => {
  const candidates = [entry("1", "Acme Supplies Inc", 1000.0, "2026-01-05", "PO-42")];
  const outcome = findBestMatch("Acme Supplies Inc", 1000.0, "2026-01-05", "PO-42", candidates);
  expect(outcome.status).toBe("matched");
  expect(outcome.reasoning.toLowerCase()).toContain("reference");
});
