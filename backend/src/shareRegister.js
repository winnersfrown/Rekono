// The share register: who owns how much of the company.
//
// v1.29 gave equity transactions a share count, which was enough to split
// par from premium on an issuance and no more. A count on a transaction
// cannot answer the questions a register exists for -- how many shares are
// outstanding right now, who holds them, what percentage each holder owns,
// and whether the charter's authorized limit has been used up. Those are
// positions, and positions need their own ledger.
//
// So this is a second ledger sitting beside the financial one, denominated
// in shares instead of dollars. It is deliberately *not* derived from the
// journal: a transfer between two shareholders moves no company money and
// posts nothing at all, and it is still the single most common event in a
// real register. Deriving positions from dollars would miss it entirely.
//
// The two ledgers meet in one place -- reconcile() below -- where the
// Common Stock balance divided by par value has to equal the shares this
// register says were issued. That is the tie-out, and it is the reason a
// share transaction can name the equity transaction that paid for it.

import { Op } from "sequelize";
import { LedgerError, centsToDollars } from "./ledger.js";
import { EQUITY_SUBTYPES, accountBalanceCents } from "./equity.js";
import { Account, EquityTransaction, ShareClass, ShareTransaction, Shareholder } from "./models/index.js";

// Which ends of a transaction name a shareholder, and what each type does
// to the three counts a class carries. Written out rather than inferred so
// that adding a type later forces a decision about all five columns.
//
// `issued` is cumulative and never comes back down: shares the company
// bought back are still issued, they are just no longer outstanding. That
// is not bookkeeping pedantry -- it is why treasury shares keep consuming
// authorized capital, and why the ledger tie-out below divides Common
// Stock by par to get *issued* rather than outstanding.
const MOVEMENT = {
  issue: { from: false, to: true, issued: +1, treasury: 0 },
  transfer: { from: true, to: true, issued: 0, treasury: 0 },
  repurchase: { from: true, to: false, issued: 0, treasury: +1 },
  reissue: { from: false, to: true, issued: 0, treasury: -1 },
};

// Outstanding is never stored. It is issued minus treasury, always, and a
// stored copy is a second source of truth waiting to drift.
function outstanding(counts) {
  return counts.issued - counts.treasury;
}

// The equity transaction type that pays for each kind of share movement.
// A transfer is absent on purpose: the money changes hands between two
// shareholders, not through the company, so there is nothing for the
// company's ledger to record and nothing to link to.
const FUNDING_TYPE = {
  issue: "contribution",
  repurchase: "treasury_purchase",
  reissue: "treasury_reissue",
};

// Transactions in the order they actually happened. Date is the real
// ordering key; id breaks ties within a day so that two transactions
// entered on the same date replay deterministically instead of in
// whatever order the database felt like returning them.
function chronological(transactions) {
  return [...transactions].sort((a, b) => {
    if (a.transactionDate !== b.transactionDate) return a.transactionDate < b.transactionDate ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

// Replays a class's transactions and reports the counts at the end, plus
// every point at which a holder's position or the treasury went negative.
//
// Replaying rather than summing is what makes backdating safe. A transfer
// dated last March can be perfectly valid against today's positions and
// still be impossible -- the holder may not have owned the shares yet in
// March, or may have sold them in April. Only a replay sees that; a net
// sum of everything cannot.
function replay(transactions) {
  const positions = new Map();
  const counts = { issued: 0, treasury: 0 };
  const violations = [];

  for (const t of chronological(transactions)) {
    const move = MOVEMENT[t.type];
    if (!move) throw new LedgerError(`Unknown share transaction type: ${t.type}`);

    counts.issued += move.issued * t.shares;
    counts.treasury += move.treasury * t.shares;

    if (t.fromShareholderId) {
      const next = (positions.get(t.fromShareholderId) ?? 0) - t.shares;
      positions.set(t.fromShareholderId, next);
      if (next < 0) {
        violations.push({ shareholderId: t.fromShareholderId, date: t.transactionDate, shortBy: -next });
      }
    }
    if (t.toShareholderId) {
      positions.set(t.toShareholderId, (positions.get(t.toShareholderId) ?? 0) + t.shares);
    }

    // Reissuing more than the company holds is the treasury equivalent of
    // a holder selling shares they don't own, and is caught the same way.
    if (counts.treasury < 0) {
      violations.push({ shareholderId: null, date: t.transactionDate, shortBy: -counts.treasury });
    }
  }

  return { positions, counts, violations };
}

async function loadClass(orgId, shareClassId) {
  const shareClass = await ShareClass.findOne({ where: { id: shareClassId, orgId } });
  if (!shareClass) throw new LedgerError("Share class not found.", 404);
  if (!shareClass.active) throw new LedgerError(`${shareClass.name} is no longer active, so shares of it can't be moved.`);
  return shareClass;
}

// `receiving` is the asymmetry that makes deactivation usable at all. A
// deactivated holder must still be able to give shares up -- selling out
// is exactly how someone stops being a shareholder, and refusing it would
// strand their position on the cap table forever. Only handing them *more*
// shares is refused.
async function loadHolder(orgId, id, label, { receiving = false } = {}) {
  const holder = await Shareholder.findOne({ where: { id, orgId } });
  if (!holder) throw new LedgerError(`${label} is not a shareholder on file.`, 404);
  if (receiving && !holder.active) throw new LedgerError(`${holder.name} is no longer an active shareholder and can't receive shares.`);
  return holder;
}

// Checks the shape of a transaction against its type before anything is
// written: right ends filled in, right ends left empty.
function validateShape({ type, fromShareholderId, toShareholderId }) {
  const move = MOVEMENT[type];
  if (!move) throw new LedgerError(`Unknown share transaction type: ${type}`);

  if (move.from && !fromShareholderId) throw new LedgerError("This transaction needs a shareholder to move shares from.");
  if (!move.from && fromShareholderId) throw new LedgerError("Shares of this kind come from the company, not from a shareholder.");
  if (move.to && !toShareholderId) throw new LedgerError("This transaction needs a shareholder to move shares to.");
  if (!move.to && toShareholderId) throw new LedgerError("Shares of this kind go back to the company, not to a shareholder.");
  if (fromShareholderId && fromShareholderId === toShareholderId) {
    throw new LedgerError("A transfer needs two different shareholders.");
  }
}

// Confirms that the equity transaction a share movement names really did
// pay for it. Without this the link is decorative and the reconciliation
// below has nothing to stand on.
async function validateFundingLink(orgId, { type, shares, equityTransactionId }) {
  if (!equityTransactionId) return;

  const expected = FUNDING_TYPE[type];
  if (!expected) {
    throw new LedgerError("A transfer between shareholders moves no company money, so it has no equity transaction.");
  }

  const funding = await EquityTransaction.findOne({ where: { id: equityTransactionId, orgId } });
  if (!funding) throw new LedgerError("Equity transaction not found.", 404);
  if (funding.type !== expected) {
    throw new LedgerError(`This share movement is paid for by a ${expected.replace(/_/g, " ")}, not a ${funding.type.replace(/_/g, " ")}.`);
  }
  if (!funding.journalEntryId) {
    throw new LedgerError("That equity transaction was voided, so it can't fund a share movement.");
  }
  if (funding.shares !== null && funding.shares !== shares) {
    throw new LedgerError(`That equity transaction covers ${funding.shares} shares, not ${shares}.`);
  }

  // One equity transaction pays for one share movement. Two share
  // movements pointing at the same one would each claim the full dollar
  // amount, and the reconciliation would then disagree with itself.
  const claimed = await ShareTransaction.findOne({ where: { orgId, equityTransactionId } });
  if (claimed) throw new LedgerError("That equity transaction is already linked to a share movement.");
}

export async function recordShareTransaction(orgId, input) {
  const { type, shareClassId, transactionDate, shares, memo } = input;
  const fromShareholderId = input.fromShareholderId || null;
  const toShareholderId = input.toShareholderId || null;
  const equityTransactionId = input.equityTransactionId || null;

  if (!Number.isInteger(shares) || shares <= 0) throw new LedgerError("Share count must be a whole number above zero.");

  validateShape({ type, fromShareholderId, toShareholderId });

  const shareClass = await loadClass(orgId, shareClassId);
  await Promise.all([
    fromShareholderId ? loadHolder(orgId, fromShareholderId, "The shareholder transferring shares") : null,
    toShareholderId ? loadHolder(orgId, toShareholderId, "The shareholder receiving shares", { receiving: true }) : null,
    validateFundingLink(orgId, { type, shares, equityTransactionId }),
  ]);

  // Validate against the class's whole history with this transaction
  // spliced in, rather than against its current end state -- see replay().
  const existing = await ShareTransaction.findAll({ where: { orgId, shareClassId } });
  const proposed = { id: "~pending", type, transactionDate, shares, fromShareholderId, toShareholderId };
  const { counts, violations } = replay([...existing, proposed]);

  if (violations.length) {
    const first = violations[0];
    // Grouped, because these are share counts and the tables that show
    // them are: "short by 91750000" is a different reading experience from
    // "short by 91,750,000" at the exact moment someone is checking a
    // number against a certificate.
    const short = first.shortBy.toLocaleString("en-US");
    if (first.shareholderId === null) {
      throw new LedgerError(`The company doesn't hold enough treasury shares of this class on ${first.date} -- short by ${short}.`);
    }
    const holder = await Shareholder.findOne({ where: { id: first.shareholderId, orgId } });
    throw new LedgerError(`${holder?.name || "That shareholder"} doesn't hold enough shares of this class on ${first.date} -- short by ${short}.`);
  }

  // Issuing beyond what the charter authorizes is void as a matter of
  // corporate law, not merely untidy, so it is refused rather than
  // flagged. Treasury shares still count: they were issued once and buying
  // them back does not hand the authorization back to the company.
  if (shareClass.authorizedShares !== null && counts.issued > shareClass.authorizedShares) {
    throw new LedgerError(
      `${shareClass.name} is authorized for ${shareClass.authorizedShares.toLocaleString("en-US")} shares and this would put ` +
        `${counts.issued.toLocaleString("en-US")} into issue.`
    );
  }

  return ShareTransaction.create({
    orgId,
    shareClassId,
    type,
    transactionDate,
    shares,
    fromShareholderId,
    toShareholderId,
    pricePerShareMicros: input.pricePerShareMicros ?? null,
    equityTransactionId,
    memo: memo || "",
  });
}

// Deleting rather than voiding, and the one place in this app where that
// is the right call. A journal entry is a claim about money that moved and
// has to be corrected by a second entry that says so; a share register
// entry is a claim about who owns what, and a wrong one leaves the wrong
// holder on the register. Removing it is not hiding history -- the funding
// equity transaction, if there was one, keeps its own immutable journal
// entry, and that is where the dollars live.
export async function deleteShareTransaction(orgId, id) {
  const transaction = await ShareTransaction.findOne({ where: { id, orgId } });
  if (!transaction) return null;

  const later = await ShareTransaction.findAll({
    where: { orgId, shareClassId: transaction.shareClassId, id: { [Op.ne]: id } },
  });
  const { violations } = replay(later);
  if (violations.length) {
    throw new LedgerError("Removing this would leave a later transaction moving shares its holder never received.");
  }

  await transaction.destroy();
  return transaction;
}

async function loadRegister(orgId, { asOf = null } = {}) {
  const where = { orgId };
  if (asOf) where.transactionDate = { [Op.lte]: asOf };

  const [classes, holders, transactions] = await Promise.all([
    ShareClass.findAll({ where: { orgId }, order: [["name", "ASC"]] }),
    Shareholder.findAll({ where: { orgId }, order: [["name", "ASC"]] }),
    ShareTransaction.findAll({ where }),
  ]);
  return { classes, holders, transactions };
}

// Counts per class: authorized, issued, held in treasury, outstanding.
export async function computeShareCounts(orgId, { asOf = null } = {}) {
  const { classes, transactions } = await loadRegister(orgId, { asOf });
  const byClass = new Map(classes.map((c) => [c.id, []]));
  for (const t of transactions) byClass.get(t.shareClassId)?.push(t);

  return classes.map((c) => {
    const { counts } = replay(byClass.get(c.id) ?? []);
    return {
      id: c.id,
      name: c.name,
      par_value: c.parValueMicros / 1000000,
      authorized: c.authorizedShares,
      issued: counts.issued,
      treasury: counts.treasury,
      outstanding: outstanding(counts),
      // Null when the charter states no ceiling, which is not the same as
      // a ceiling of zero and must not render as "0 remaining".
      available: c.authorizedShares === null ? null : c.authorizedShares - counts.issued,
      active: c.active,
    };
  });
}

// The cap table: every holder, their position in each class, and what
// share of the company that is.
export async function computeCapTable(orgId, { asOf = null } = {}) {
  const { classes, holders, transactions } = await loadRegister(orgId, { asOf });

  const byClass = new Map(classes.map((c) => [c.id, []]));
  for (const t of transactions) byClass.get(t.shareClassId)?.push(t);

  const classResults = classes.map((c) => ({ shareClass: c, ...replay(byClass.get(c.id) ?? []) }));
  const totalOutstanding = classResults.reduce((sum, r) => sum + outstanding(r.counts), 0);

  const rows = holders
    .map((h) => {
      const positions = classResults
        .map((r) => {
          const shares = r.positions.get(h.id) ?? 0;
          const classOutstanding = outstanding(r.counts);
          return {
            share_class_id: r.shareClass.id,
            share_class_name: r.shareClass.name,
            shares,
            percent: classOutstanding > 0 ? round4((shares / classOutstanding) * 100) : 0,
          };
        })
        .filter((p) => p.shares !== 0);

      const total = positions.reduce((sum, p) => sum + p.shares, 0);
      return {
        shareholder_id: h.id,
        shareholder_name: h.name,
        email: h.email,
        positions,
        total_shares: total,
        // Every share counted as one share. That is what people mean by
        // "percent of the company", and it is exactly right for a company
        // with one class -- which is most of them. With preferred stock in
        // the picture it is a rough guide and nothing more: economic and
        // voting rights differ by class, so the per-class percentages
        // above are the ones that mean something precise.
        percent: totalOutstanding > 0 ? round4((total / totalOutstanding) * 100) : 0,
      };
    })
    // A former holder who has sold out entirely stays on file but off the
    // cap table -- a row of zeroes is noise, and the transaction history
    // is where they remain visible.
    .filter((row) => row.total_shares !== 0)
    .sort((a, b) => b.total_shares - a.total_shares || a.shareholder_name.localeCompare(b.shareholder_name));

  return {
    as_of: asOf,
    total_outstanding: totalOutstanding,
    classes: classResults.map((r) => ({
      id: r.shareClass.id,
      name: r.shareClass.name,
      issued: r.counts.issued,
      treasury: r.counts.treasury,
      outstanding: outstanding(r.counts),
    })),
    holders: rows,
  };
}

// Percentages are display values, not money -- four decimals is enough to
// keep a 10,000-share position out of a 100,000,000-share company from
// rounding to zero, without pretending to more precision than that.
function round4(n) {
  return Math.round(n * 10000) / 10000;
}

// The tie-out between the two ledgers.
//
// Common Stock is credited with par value on every issuance, so its
// balance divided by par is the number of shares issued -- and this
// register knows that number independently. If they disagree, either a
// share issuance never made it into the ledger or an equity contribution
// never made it onto the register, and someone's ownership percentage is
// wrong.
//
// Issued, not outstanding, is the right side of that equation: equity.js
// uses the cost method, where a buyback debits Treasury Stock and leaves
// Common Stock exactly where it was.
export async function reconcileShareRegister(orgId, { asOf = null } = {}) {
  const { classes, transactions } = await loadRegister(orgId, { asOf });
  const classById = new Map(classes.map((c) => [c.id, c]));

  const commonStock = await Account.findOne({
    where: { orgId, type: "equity", subtype: EQUITY_SUBTYPES.COMMON_STOCK },
  });

  // Only true issuances credit Common Stock. A reissue credits Treasury
  // Stock instead, which is why it is excluded here even though it does
  // put shares into a holder's hands.
  const issuances = transactions.filter((t) => t.type === "issue");

  let registerParCents = 0;
  const noParClasses = new Set();
  for (const t of issuances) {
    const shareClass = classById.get(t.shareClassId);
    if (!shareClass) continue;
    // Rounded per transaction, matching equity.js line for line. Summing
    // the shares first and rounding once would drift by up to a cent per
    // issuance against the ledger it is being checked against.
    const parCents = Math.round((t.shares * shareClass.parValueMicros) / 10000);
    // equity.js's own no-par branch: when a whole issuance rounds to less
    // than a cent of par, the full proceeds go to Common Stock instead.
    // The account then holds dollars raised, not par value, and dividing
    // it by par answers nothing.
    if (parCents === 0) noParClasses.add(shareClass.name);
    registerParCents += parCents;
  }

  const ledgerParCents = commonStock ? await accountBalanceCents(orgId, commonStock.id, { asOf }) : 0;

  // Equity transactions that say shares changed hands but that no share
  // movement claims. These are the usual cause of a discrepancy, and
  // naming them turns "you are off by $4,000" into a list to go fix.
  const linkedIds = new Set(transactions.map((t) => t.equityTransactionId).filter(Boolean));
  const fundingWhere = { orgId, type: { [Op.in]: Object.values(FUNDING_TYPE) }, shares: { [Op.ne]: null } };
  if (asOf) fundingWhere.transactionDate = { [Op.lte]: asOf };
  const funding = await EquityTransaction.findAll({ where: fundingWhere, order: [["transactionDate", "ASC"]] });
  const unlinked = funding
    .filter((t) => t.journalEntryId && !linkedIds.has(t.id))
    .map((t) => ({
      id: t.id,
      type: t.type,
      transaction_date: t.transactionDate,
      shares: t.shares,
      amount: centsToDollars(t.amountCents),
    }));

  const applicable = Boolean(commonStock) && noParClasses.size === 0;

  return {
    as_of: asOf,
    applicable,
    // Said plainly rather than left for the caller to infer, because "not
    // applicable" and "reconciles" look identical from a difference of
    // zero and mean completely different things.
    reason: !commonStock
      ? "No shares have been issued through an equity transaction yet, so there is nothing in Common Stock to check against."
      : noParClasses.size
      ? `${[...noParClasses].join(", ")} carries no stated par value, so Common Stock holds proceeds rather than par and can't be divided by par.`
      : null,
    register_par_value: centsToDollars(registerParCents),
    ledger_common_stock: centsToDollars(ledgerParCents),
    difference: centsToDollars(ledgerParCents - registerParCents),
    reconciles: applicable ? ledgerParCents === registerParCents : null,
    unlinked_equity_transactions: unlinked,
  };
}

export function serializeShareClass(c) {
  return {
    id: c.id,
    name: c.name,
    // Dollars per share, as it reads in a certificate of incorporation.
    // $0.0001 is the Delaware default and survives the round trip because
    // the column is millionths, not cents.
    par_value: c.parValueMicros / 1000000,
    authorized_shares: c.authorizedShares,
    active: c.active,
  };
}

export function serializeShareholder(h) {
  return { id: h.id, name: h.name, email: h.email, notes: h.notes, active: h.active };
}

export function serializeShareTransaction(t, { holdersById = null, classesById = null } = {}) {
  return {
    id: t.id,
    type: t.type,
    share_class_id: t.shareClassId,
    share_class_name: classesById?.get(t.shareClassId)?.name ?? null,
    transaction_date: t.transactionDate,
    shares: t.shares,
    from_shareholder_id: t.fromShareholderId,
    from_shareholder_name: t.fromShareholderId ? holdersById?.get(t.fromShareholderId)?.name ?? null : null,
    to_shareholder_id: t.toShareholderId,
    to_shareholder_name: t.toShareholderId ? holdersById?.get(t.toShareholderId)?.name ?? null : null,
    price_per_share: t.pricePerShareMicros === null ? null : t.pricePerShareMicros / 1000000,
    equity_transaction_id: t.equityTransactionId,
    memo: t.memo,
  };
}
