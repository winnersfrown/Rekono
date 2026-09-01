// Vendor identity for the AP side: turning the free-text `vendorName` an
// invoice arrives with into a stable `Vendor` row, and letting a human say
// "these two are the same vendor" when normalization can't tell.
//
// The problem this exists to solve: AP aging used to group by normalizing
// the extracted vendor name (trim + lowercase). That handles "Acme Inc."
// vs "  ACME Inc. " and nothing else. The moment the same vendor's name
// arrives genuinely differently -- "Acme Inc" one month, "Acme
// Incorporated" the next, which is what OCR and a vendor changing their
// letterhead both produce -- it silently reports one vendor as two, and
// every collections decision made off that report is wrong.
//
// No amount of cleverer normalization fixes that (nothing can know those
// two strings are one company), so the fix is identity plus a merge.

import { Op } from "sequelize";
import { Invoice, Vendor, VendorAlias, VendorExpenseAccount } from "./models/index.js";

export class VendorError extends Error {
  constructor(message, status = 422) {
    super(message);
    this.status = status;
  }
}

// The one normalization every vendor-keyed lookup in this app shares --
// vendorAlias.js and vendorExpenseAccount.js both import it, since a
// vendor key written by one and read by another has to agree exactly.
//
// The line it draws: fold away what carries no information (case,
// surrounding and repeated whitespace, trailing punctuation), and leave
// anything that could conceivably distinguish two companies to a human.
// So "Acme Inc", "  ACME  inc " and "Acme Inc." are one vendor, while
// "Acme Inc" and "Acme Incorporated" stay two until someone merges them.
//
// The asymmetry is what sets that line. A missed normalization costs one
// merge click and is visible on the report; a wrong one silently folds two
// real companies together and is nearly impossible to notice. So anything
// that isn't purely cosmetic stays out: no stripping of Inc/Ltd/LLC, no
// edit-distance matching, no dropping internal punctuation ("Acme, Inc."
// could in principle be a different entity from "Acme Inc").
export function normalizeVendorName(name) {
  return (name || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.,;:]+$/, "")
    .trim();
}

// Loads every vendor and alias for an org once, and returns a resolver
// that maps an invoice to a stable identity without further queries.
//
// Resolution order, most to least specific:
//   1. invoice.vendorId -- set at approval, the explicit link
//   2. an alias for the invoice's raw name that points at a vendor
//   3. a vendor whose own name normalizes to the invoice's raw name
//   4. the normalized name itself, for bills that predate all of this
//
// Steps 2 and 3 are what make a merge retroactive: a merge writes aliases,
// and this resolves through them at read time, so history regroups with no
// invoice rewritten.
export async function buildVendorResolver(orgId) {
  const [vendors, aliases] = await Promise.all([
    Vendor.findAll({ where: { orgId } }),
    VendorAlias.findAll({ where: { orgId, vendorId: { [Op.ne]: null } } }),
  ]);

  const byId = new Map(vendors.map((v) => [v.id, v]));
  const byNormalizedName = new Map();
  for (const v of vendors) byNormalizedName.set(normalizeVendorName(v.name), v);
  const byAlias = new Map();
  for (const a of aliases) byAlias.set(a.rawVendorName, byId.get(a.vendorId));

  // Carries the resolved Vendor's own fields alongside its identity, for
  // callers that need more than a name -- computeApAging's early-payment
  // discount is the first of these, so rather than re-querying Vendor a
  // second time it just reads off the row this function already has.
  function withDiscountTerms(v) {
    return { earlyPayDiscountPct: v.earlyPayDiscountPct, earlyPayDiscountDays: v.earlyPayDiscountDays };
  }

  return function resolve(invoice) {
    const raw = normalizeVendorName(invoice.vendorName);

    const direct = invoice.vendorId ? byId.get(invoice.vendorId) : null;
    if (direct) return { key: `id:${direct.id}`, vendorId: direct.id, name: direct.name, ...withDiscountTerms(direct) };

    const aliased = byAlias.get(raw);
    if (aliased) return { key: `id:${aliased.id}`, vendorId: aliased.id, name: aliased.name, ...withDiscountTerms(aliased) };

    const named = byNormalizedName.get(raw);
    if (named) return { key: `id:${named.id}`, vendorId: named.id, name: named.name, ...withDiscountTerms(named) };

    // No vendor row at all -- a bill approved before this release, or one
    // whose vendor was deleted. Grouped by name so it still appears, which
    // is exactly the pre-v1.25 behavior for exactly the rows that predate
    // v1.25. No terms to offer a discount against either, for the same
    // reason.
    const display = (invoice.vendorName || "").trim() || "(unknown vendor)";
    return { key: `name:${raw}`, vendorId: null, name: display, earlyPayDiscountPct: null, earlyPayDiscountDays: null };
  };
}

// Finds the Vendor an extracted name belongs to, creating one if this is
// the first time the org has seen it. Called when a bill is approved --
// the point where it becomes a payable and its vendor starts mattering --
// rather than at extraction, so OCR noise on a document nobody ever
// approves doesn't litter the vendor list.
export async function resolveVendorForInvoice(orgId, invoice) {
  const raw = normalizeVendorName(invoice.vendorName);
  if (!raw) return null;

  const alias = await VendorAlias.findOne({ where: { orgId, rawVendorName: raw, vendorId: { [Op.ne]: null } } });
  if (alias) {
    const aliased = await Vendor.findOne({ where: { id: alias.vendorId, orgId } });
    if (aliased) return aliased;
  }

  const vendors = await Vendor.findAll({ where: { orgId } });
  const existing = vendors.find((v) => normalizeVendorName(v.name) === raw);
  if (existing) return existing;

  return Vendor.create({
    orgId,
    name: (invoice.vendorName || "").trim(),
    autoCreated: true,
  });
}

function addDaysIso(fromIso, days) {
  const d = new Date(`${fromIso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Sets invoice.vendorId if it isn't already set, and backfills a missing
// due date from the vendor's payment terms -- the AP mirror of how
// receivables.js already inherits Customer.paymentTermsDays for a customer
// invoice with no due date given. Safe to call more than once (invoice
// approval is itself idempotent), and never overwrites a vendorId a human
// assigned by hand or a dueDate the document (or a human) already
// supplied. Bills with no invoice date extracted have nothing to count
// days from, so they're left as-is, same as before this existed.
export async function attachVendorToInvoice(orgId, invoice) {
  let vendor = null;
  if (!invoice.vendorId) {
    vendor = await resolveVendorForInvoice(orgId, invoice);
    if (vendor) invoice.vendorId = vendor.id;
  }

  if (!invoice.dueDate && invoice.invoiceDate) {
    if (!vendor && invoice.vendorId) vendor = await Vendor.findByPk(invoice.vendorId);
    if (vendor) invoice.dueDate = addDaysIso(invoice.invoiceDate, vendor.paymentTermsDays);
  }

  if (invoice.changed()) await invoice.save();
  return invoice.vendorId;
}

// Folds `loserId` into `winnerId`: every bill, alias, and remembered
// expense account moves across, and the loser's own name is written as an
// alias of the winner so future invoices carrying that spelling resolve
// correctly on their own.
//
// The loser row is deleted rather than deactivated -- unlike a vendor
// someone stopped using, a merged-away duplicate should not stay
// selectable, and nothing references it any more by the time this
// finishes. Its name survives as the alias, which is the part that
// actually needed keeping.
export async function mergeVendors(orgId, { loserId, winnerId }) {
  if (loserId === winnerId) throw new VendorError("A vendor can't be merged into itself.");

  const [loser, winner] = await Promise.all([
    Vendor.findOne({ where: { id: loserId, orgId } }),
    Vendor.findOne({ where: { id: winnerId, orgId } }),
  ]);
  if (!loser) throw new VendorError("Vendor to merge not found.", 404);
  if (!winner) throw new VendorError("Vendor to merge into not found.", 404);

  // `unscoped` so this catches sample invoices and soft-deleted ones too:
  // leaving either pointing at a vendor row that's about to be deleted
  // would strand them with an id that resolves to nothing. Payments need
  // no equivalent -- a BillPayment reaches its vendor through its invoice.
  const [invoicesMoved] = await Invoice.unscoped().update(
    { vendorId: winner.id },
    { where: { orgId, vendorId: loser.id } }
  );

  // Existing aliases pointing at the loser now point at the winner.
  await VendorAlias.update({ vendorId: winner.id }, { where: { orgId, vendorId: loser.id } });

  // ...and the loser's own spelling becomes an alias, so the next invoice
  // that arrives spelled that way resolves to the winner instead of
  // recreating the duplicate this merge just removed.
  const loserRaw = normalizeVendorName(loser.name);
  if (loserRaw && loserRaw !== normalizeVendorName(winner.name)) {
    const [alias] = await VendorAlias.findOrCreate({
      where: { orgId, rawVendorName: loserRaw },
      defaults: { canonicalVendorName: winner.name, vendorId: winner.id },
    });
    if (alias.vendorId !== winner.id || alias.canonicalVendorName !== winner.name) {
      alias.vendorId = winner.id;
      alias.canonicalVendorName = winner.name;
      await alias.save();
    }
  }

  // A remembered expense account is keyed by vendor name, so the loser's
  // memory has to follow it -- otherwise the next bill under the merged
  // spelling loses the categorization a human already confirmed once.
  const loserMemory = await VendorExpenseAccount.findOne({ where: { orgId, vendorName: loserRaw } });
  if (loserMemory) {
    const winnerRaw = normalizeVendorName(winner.name);
    const winnerMemory = await VendorExpenseAccount.findOne({ where: { orgId, vendorName: winnerRaw } });
    if (!winnerMemory) {
      await VendorExpenseAccount.create({
        orgId,
        vendorName: winnerRaw,
        expenseAccountId: loserMemory.expenseAccountId,
        expenseAccountName: loserMemory.expenseAccountName,
      });
    }
  }

  await loser.destroy();

  return { winner, invoicesMoved };
}
