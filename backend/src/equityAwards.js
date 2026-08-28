// The option pool: equity that has been promised but not issued, and the
// fully-diluted ownership that falls out of it.
//
// v1.30's register answers "who owns what" in issued shares. That is the
// wrong denominator for almost every question a founder or an investor
// actually asks, because a company with a 15% option pool and a Series A
// warrant does not own the percentages its register shows. Fully diluted
// is the number on the term sheet.
//
// The gap between the two numbers is this module. Three things sit in it:
//
//   granted, unexercised awards   promised to someone, not yet real stock
//   the unallocated pool          reserved by the board, not yet promised
//   (exercised awards)            already real stock, already in the register
//
// The middle one is the one people forget, and it is the one that gets
// negotiated: an unallocated pool dilutes the existing holders and nobody
// else, which is the whole substance of the "pool shuffle" argument in a
// priced round. It is counted here for that reason.
//
// An exercise is the only thing here that reaches either of the other two
// ledgers, and it reaches both: it issues stock onto the register and posts
// the cash paid for it as a capital contribution. Granting an option does
// neither. That is not a simplification, it is the definition, and it is
// why outstanding and fully diluted are different numbers at all.

import { Op } from "sequelize";
import { LedgerError } from "./ledger.js";
import { addMonthsClamped } from "./recurringEntries.js";
import { recordEquityTransaction, voidEquityTransaction } from "./equity.js";
import { computeCapTable, recordShareTransaction } from "./shareRegister.js";
import { AwardEvent, EquityAward, EquityPlan, ShareClass, Shareholder } from "./models/index.js";

const today = () => new Date().toISOString().slice(0, 10);

// An exercise or a cancellation is something that happened, and dating one
// in the future is not merely untidy: vesting is a function of time, and
// every gate in this module is evaluated at the event's own date. Without
// this, someone could exercise a grant that has barely started by typing a
// date four years out, and the pool would report equity nobody holds.
//
// The share register deliberately has no equivalent rule -- a transfer
// between two shareholders has no time-based gate to bypass, so refusing a
// date there would only get in the way of recording paperwork that arrives
// late or early. The asymmetry is the point.
function refuseFutureDate(date, what) {
  if (date > today()) throw new LedgerError(`${what} can't be dated in the future.`);
}

// Whole months from `start` up to and including `asOf`.
//
// Counted by anniversary rather than by day arithmetic, and the
// anniversary uses the same clamping the recurring-entry schedule does: a
// vesting start on the 31st has its February anniversary on the 28th, not
// in March. Getting this wrong shifts a whole month of someone's equity.
export function monthsElapsed(start, asOf) {
  if (asOf < start) return 0;
  const [sy, sm] = start.split("-").map(Number);
  const [ay, am] = asOf.split("-").map(Number);
  let months = (ay - sy) * 12 + (am - sm);
  // The calendar difference overshoots whenever the day-of-month hasn't
  // come round yet; one comparison against the real anniversary fixes it
  // without a second special case for month lengths.
  if (addMonthsClamped(start, months) > asOf) months -= 1;
  return Math.max(months, 0);
}

// How much of an award has vested by `asOf`.
//
// Computed, never stored. A row per vesting month would be a copy of what
// this function already knows exactly, and rows for months that haven't
// happened are claims about the future -- the same argument
// recurringEntries.js makes for keeping a template instead of pre-writing
// future entries.
export function vestedShares(award, asOf = today()) {
  if (award.vestingMonths <= 0) return award.shares;

  const months = monthsElapsed(award.vestingStartDate, asOf);
  // Nothing at all before the cliff, then everything earned up to it lands
  // in one step. An employee who leaves at eleven months has zero, which
  // is the point of a cliff and is not an edge case to smooth over.
  if (months < award.cliffMonths) return 0;

  const capped = Math.min(months, award.vestingMonths);
  // Multiply first, floor once, so the rounding remainder lands on the
  // final month rather than being spread as a fraction of a share nobody
  // can hold. At the last month this is exactly `shares` by construction.
  return Math.floor((award.shares * capped) / award.vestingMonths);
}

// One award's position: what was granted, what has happened to it, and
// what the holder could exercise today.
export function summarizeAward(award, events, asOf = today()) {
  let exercised = 0;
  let cancelled = 0;
  for (const e of events) {
    if (e.eventDate > asOf) continue;
    if (e.type === "exercise") exercised += e.shares;
    else if (e.type === "cancel") cancelled += e.shares;
  }

  const live = award.shares - exercised - cancelled;
  // Capped at what survives cancellation. Without the cap a forfeited
  // award goes on reporting a *rising* vested count forever -- the date
  // keeps advancing and the raw curve knows nothing about the
  // cancellation -- which reads as though someone who left two years ago
  // is still earning equity.
  const vested = Math.min(vestedShares(award, asOf), live + exercised);
  return {
    granted: award.shares,
    exercised,
    cancelled,
    // Still promised and still capable of becoming stock. This is the
    // number that dilutes.
    outstanding: live,
    vested,
    // Vesting counts against the whole grant, so shares already cancelled
    // eat into what's left to exercise. Clamped at the live balance:
    // someone whose unvested half was cancelled can still exercise the
    // vested half, and no more.
    exercisable: Math.max(Math.min(vested - exercised, live), 0),
    unvested: Math.max(live - Math.max(vested - exercised, 0), 0),
  };
}

async function loadPlan(orgId, id) {
  const plan = await EquityPlan.findOne({ where: { id, orgId } });
  if (!plan) throw new LedgerError("Equity plan not found.", 404);
  return plan;
}

async function loadAward(orgId, id) {
  const award = await EquityAward.findOne({ where: { id, orgId } });
  if (!award) throw new LedgerError("Award not found.", 404);
  return award;
}

export async function awardsWithEvents(orgId, where = {}, asOf = null) {
  const awards = await EquityAward.findAll({ where: { orgId, ...where } });
  if (!awards.length) return [];
  const events = await AwardEvent.findAll({ where: { orgId, equityAwardId: { [Op.in]: awards.map((a) => a.id) } } });

  const byAward = new Map(awards.map((a) => [a.id, []]));
  for (const e of events) byAward.get(e.equityAwardId)?.push(e);

  return awards.map((award) => ({ award, events: byAward.get(award.id) ?? [], summary: summarizeAward(award, byAward.get(award.id) ?? [], asOf || today()) }));
}

// What a plan has left to grant.
//
// Cancelled shares come back to the pool and can be granted again, which
// is what almost every plan document says. Exercised shares do not: they
// left the pool permanently the moment they became real stock, and are
// counted by the share register from then on. Counting them in both places
// is the double-count this arithmetic exists to avoid.
export async function computePlanStatus(orgId, { asOf = null } = {}) {
  const on = asOf || today();
  const [plans, classes] = await Promise.all([
    EquityPlan.findAll({ where: { orgId }, order: [["adoptedDate", "ASC"], ["name", "ASC"]] }),
    ShareClass.findAll({ where: { orgId } }),
  ]);
  if (!plans.length) return [];

  const classById = new Map(classes.map((c) => [c.id, c]));
  const rows = await awardsWithEvents(orgId, {}, on);

  return plans.map((plan) => {
    const planAwards = rows.filter((r) => r.award.equityPlanId === plan.id && r.award.grantDate <= on);
    const granted = planAwards.reduce((s, r) => s + r.summary.granted, 0);
    const cancelled = planAwards.reduce((s, r) => s + r.summary.cancelled, 0);
    const exercised = planAwards.reduce((s, r) => s + r.summary.exercised, 0);
    const live = planAwards.reduce((s, r) => s + r.summary.outstanding, 0);

    return {
      id: plan.id,
      name: plan.name,
      share_class_id: plan.shareClassId,
      share_class_name: classById.get(plan.shareClassId)?.name ?? null,
      adopted_date: plan.adoptedDate,
      reserved: plan.reservedShares,
      granted,
      cancelled,
      exercised,
      outstanding: live,
      available: plan.reservedShares - (granted - cancelled),
      active: plan.active,
    };
  });
}

export async function recordAwardGrant(orgId, input) {
  const { equityPlanId, shareholderId, type, grantDate, shares, vestingStartDate } = input;

  if (!Number.isInteger(shares) || shares <= 0) throw new LedgerError("Share count must be a whole number above zero.");

  const vestingMonths = input.vestingMonths ?? 48;
  const cliffMonths = input.cliffMonths ?? 12;
  if (cliffMonths > vestingMonths) {
    // A cliff past the end of vesting means nothing ever vests, which is
    // never what anyone meant to type.
    throw new LedgerError("The cliff can't be longer than the vesting period.");
  }

  const plan = await loadPlan(orgId, equityPlanId);
  if (!plan.active) throw new LedgerError(`${plan.name} is closed, so no new grants can be made from it.`);

  const holder = await Shareholder.findOne({ where: { id: shareholderId, orgId } });
  if (!holder) throw new LedgerError("That grantee is not on file.", 404);
  if (!holder.active) throw new LedgerError(`${holder.name} is no longer active and can't receive a grant.`);

  // An RSU has no exercise price -- there is nothing to pay. Accepting one
  // anyway would put a number on the cap table that means nothing and that
  // an exercise would then try to charge.
  const strike = input.strikePriceMicros ?? null;
  if (type === "rsu" && strike) throw new LedgerError("An RSU has no strike price -- there's nothing to pay on settlement.");

  const status = (await computePlanStatus(orgId)).find((p) => p.id === plan.id);
  if (status && shares > status.available) {
    // Refused rather than flagged, for the same reason the register
    // refuses issuing past the authorized ceiling: a grant the plan
    // doesn't have shares for isn't a data-entry slip, it's a promise the
    // company can't keep without a board amendment.
    throw new LedgerError(
      `${plan.name} has ${status.available.toLocaleString("en-US")} shares left to grant, and this grant is for ${shares.toLocaleString("en-US")}.`
    );
  }

  return EquityAward.create({
    orgId,
    equityPlanId,
    shareholderId,
    type: type || "option",
    grantDate,
    shares,
    strikePriceMicros: strike,
    grantDateFairValueMicros: input.grantDateFairValueMicros ?? null,
    // Vesting normally starts on the grant date, and starts earlier when a
    // grant is approved after someone's start date -- which is common
    // enough that defaulting to the grant date and allowing an override is
    // the right shape.
    vestingStartDate: vestingStartDate || grantDate,
    vestingMonths,
    cliffMonths,
    memo: input.memo || "",
  });
}

// Exercising is the one place an award touches the share register: the
// shares stop being a promise and become stock, through the same
// `recordShareTransaction` path a founder issuance uses. That means an
// exercise inherits the register's authorized-capital check for free, and
// it means the cap table and the pool can't drift apart -- they are
// updated by one call, not by two that have to agree.
export async function exerciseAward(orgId, awardId, { shares, eventDate, equityTransactionId = null, cashAccountId = null, memo = "" } = {}) {
  const award = await loadAward(orgId, awardId);
  const on = eventDate || today();
  refuseFutureDate(on, "An exercise");
  if (on < award.grantDate) throw new LedgerError("An award can't be exercised before it was granted.");

  if (!Number.isInteger(shares) || shares <= 0) throw new LedgerError("Share count must be a whole number above zero.");

  const events = await AwardEvent.findAll({ where: { orgId, equityAwardId: awardId } });
  const summary = summarizeAward(award, events, on);

  if (shares > summary.exercisable) {
    // Early exercise -- buying unvested shares subject to repurchase -- is
    // a real plan feature, but it's a plan-level election with an 83(b)
    // filing attached, not a default. Allowing it silently would let
    // someone exercise equity they haven't earned.
    throw new LedgerError(
      `${summary.exercisable.toLocaleString("en-US")} shares are exercisable on ${on}, and this exercise is for ${shares.toLocaleString("en-US")}.`
    );
  }

  const plan = await loadPlan(orgId, award.equityPlanId);
  const shareClass = await ShareClass.findOne({ where: { id: plan.shareClassId, orgId } });

  // Exercising an option is a capital contribution: cash comes in and
  // stock goes out. Posting it is what keeps the register's tie-out to the
  // ledger intact -- without it, Common Stock stays where it was while the
  // register's issued count climbs, and the reconciliation starts
  // reporting a difference that nothing can close.
  //
  // Optional rather than required, because a historical exercise being
  // typed in for the record may already have its own journal entry (name
  // it with equityTransactionId) or may predate the books entirely. When
  // it's skipped the reconciliation says so, which is the honest outcome
  // rather than a silent one.
  let posted = null;
  if (!equityTransactionId && cashAccountId) {
    if (!award.strikePriceMicros) {
      // An RSU settles for services, not cash. The expense side of that is
      // ASC 718 stock compensation -- grant-date fair value recognized
      // over the vesting period -- which Rekono does not compute, and
      // guessing at it would be worse than leaving it to a human.
      throw new LedgerError("This award has no strike price, so exercising it moves no cash and there's nothing to post.");
    }
    const { transaction } = await recordEquityTransaction(orgId, {
      type: "contribution",
      transactionDate: on,
      amountCents: Math.round((shares * award.strikePriceMicros) / 10000),
      cashAccountId,
      shares,
      parValueMicros: shareClass?.parValueMicros ?? 0,
      memo: memo || `Exercise of ${plan.name} award`,
    });
    posted = transaction;
    equityTransactionId = transaction.id;
  }

  let shareTransaction;
  try {
    shareTransaction = await recordShareTransaction(orgId, {
      type: "issue",
      shareClassId: plan.shareClassId,
      transactionDate: on,
      shares,
      toShareholderId: award.shareholderId,
      pricePerShareMicros: award.strikePriceMicros,
      equityTransactionId,
      memo: memo || `Exercise of ${plan.name} award`,
    });
  } catch (err) {
    // The register refused -- past the authorized ceiling, most likely.
    // The contribution we just posted was for shares that will never
    // exist, so it has to come back off the books rather than sit there
    // as cash raised against nothing.
    if (posted) await voidEquityTransaction(orgId, posted.id);
    throw err;
  }

  // Recorded only once the issuance is on the register. The reverse order
  // would leave an exercise recorded against shares that the register
  // refused, and the pool would report equity nobody holds.
  return AwardEvent.create({
    orgId,
    equityAwardId: awardId,
    type: "exercise",
    eventDate: on,
    shares,
    shareTransactionId: shareTransaction.id,
    memo: memo || "",
  });
}

// Forfeiture on departure, or a straight cancellation. Either way the
// shares go back to the plan and can be granted again.
export async function cancelAward(orgId, awardId, { shares = null, eventDate, memo = "" } = {}) {
  const award = await loadAward(orgId, awardId);
  const on = eventDate || today();
  refuseFutureDate(on, "A cancellation");
  if (on < award.grantDate) throw new LedgerError("An award can't be cancelled before it was granted.");

  const events = await AwardEvent.findAll({ where: { orgId, equityAwardId: awardId } });
  const summary = summarizeAward(award, events, on);

  // Cancelling the whole remaining balance is the overwhelmingly common
  // case (someone left), so it's the default rather than something the
  // caller has to compute and pass in.
  const amount = shares ?? summary.outstanding;
  if (!Number.isInteger(amount) || amount <= 0) throw new LedgerError("Share count must be a whole number above zero.");
  if (amount > summary.outstanding) {
    throw new LedgerError(
      `${summary.outstanding.toLocaleString("en-US")} shares are still outstanding on this award, and this would cancel ${amount.toLocaleString("en-US")}.`
    );
  }

  return AwardEvent.create({ orgId, equityAwardId: awardId, type: "cancel", eventDate: on, shares: amount, memo });
}

// The fully-diluted cap table.
//
// Denominator is issued-and-outstanding shares, plus every unexercised
// award, plus every share still sitting unallocated in a plan. The last
// term is why this exists: it belongs to nobody and dilutes everybody, and
// leaving it out produces percentages that look better than the ones a
// term sheet will show.
export async function computeFullyDiluted(orgId, { asOf = null } = {}) {
  const on = asOf || today();
  const [capTable, plans, rows] = await Promise.all([
    computeCapTable(orgId, { asOf }),
    computePlanStatus(orgId, { asOf: on }),
    awardsWithEvents(orgId, {}, on),
  ]);

  const live = rows.filter((r) => r.award.grantDate <= on);
  const awardSharesByHolder = new Map();
  for (const r of live) {
    const prev = awardSharesByHolder.get(r.award.shareholderId) ?? 0;
    awardSharesByHolder.set(r.award.shareholderId, prev + r.summary.outstanding);
  }

  const unallocated = plans.reduce((sum, p) => sum + Math.max(p.available, 0), 0);
  const awardTotal = [...awardSharesByHolder.values()].reduce((s, n) => s + n, 0);
  const denominator = capTable.total_outstanding + awardTotal + unallocated;

  const pct = (n) => (denominator > 0 ? Math.round((n / denominator) * 1000000) / 10000 : 0);

  // Everyone with either real shares or a live award. A grantee who has
  // never exercised holds nothing on the register and still belongs on
  // this table -- that difference is the entire point of the report.
  const byHolder = new Map();
  for (const h of capTable.holders) {
    byHolder.set(h.shareholder_id, { name: h.shareholder_name, shares: h.total_shares, awards: 0 });
  }
  for (const [shareholderId, shares] of awardSharesByHolder) {
    if (!shares) continue;
    const existing = byHolder.get(shareholderId);
    if (existing) existing.awards += shares;
    else byHolder.set(shareholderId, { name: null, shares: 0, awards: shares });
  }

  const missingNames = [...byHolder.entries()].filter(([, v]) => v.name === null).map(([id]) => id);
  if (missingNames.length) {
    const holders = await Shareholder.findAll({ where: { orgId, id: { [Op.in]: missingNames } } });
    for (const h of holders) {
      const row = byHolder.get(h.id);
      if (row) row.name = h.name;
    }
  }

  const holders = [...byHolder.entries()]
    .map(([id, v]) => ({
      shareholder_id: id,
      shareholder_name: v.name ?? "Unknown",
      shares: v.shares,
      award_shares: v.awards,
      fully_diluted_shares: v.shares + v.awards,
      percent: pct(v.shares + v.awards),
      // What the register alone would have said. Shown beside the diluted
      // figure because the difference between the two is the thing this
      // report is for, and a reader comparing tabs shouldn't have to.
      outstanding_percent: capTable.total_outstanding > 0 ? Math.round((v.shares / capTable.total_outstanding) * 1000000) / 10000 : 0,
    }))
    .filter((h) => h.fully_diluted_shares !== 0)
    .sort((a, b) => b.fully_diluted_shares - a.fully_diluted_shares || a.shareholder_name.localeCompare(b.shareholder_name));

  return {
    as_of: on,
    outstanding_shares: capTable.total_outstanding,
    award_shares: awardTotal,
    unallocated_pool_shares: unallocated,
    fully_diluted_shares: denominator,
    // Held by nobody, dilutes everybody. Its own line rather than a
    // holder row, because assigning it to a person would be a lie and
    // dropping it would overstate every percentage above.
    unallocated_pool_percent: pct(unallocated),
    holders,
    plans,
  };
}

export function serializeEquityPlan(plan) {
  return {
    id: plan.id,
    name: plan.name,
    share_class_id: plan.shareClassId,
    reserved_shares: plan.reservedShares,
    adopted_date: plan.adoptedDate,
    active: plan.active,
  };
}

export function serializeAward({ award, summary }, { holdersById = null, plansById = null } = {}) {
  return {
    id: award.id,
    equity_plan_id: award.equityPlanId,
    equity_plan_name: plansById?.get(award.equityPlanId)?.name ?? null,
    shareholder_id: award.shareholderId,
    shareholder_name: holdersById?.get(award.shareholderId)?.name ?? null,
    type: award.type,
    grant_date: award.grantDate,
    strike_price: award.strikePriceMicros === null ? null : award.strikePriceMicros / 1000000,
    grant_date_fair_value: award.grantDateFairValueMicros === null ? null : award.grantDateFairValueMicros / 1000000,
    vesting_start_date: award.vestingStartDate,
    vesting_months: award.vestingMonths,
    cliff_months: award.cliffMonths,
    memo: award.memo,
    ...(summary
      ? {
          shares: summary.granted,
          vested: summary.vested,
          exercised: summary.exercised,
          cancelled: summary.cancelled,
          outstanding: summary.outstanding,
          exercisable: summary.exercisable,
          unvested: summary.unvested,
        }
      : { shares: award.shares }),
  };
}
