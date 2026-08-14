// Shared by routes/team.js (enforcing the cap when inviting) and
// routes/auth.js (surfacing seat usage on GET /api/auth/me) -- pulled out
// on its own so both agree on exactly what counts as a used seat.
import { Invite, User } from "./models/index.js";

// A pending invite reserves a seat -- otherwise an owner could send invites
// past the plan's limit and only find out when invitees start accepting
// them, in whatever order they happen to click the link.
export async function seatsUsed(orgId) {
  const [userCount, pendingInviteCount] = await Promise.all([
    User.count({ where: { orgId } }),
    Invite.count({ where: { orgId, status: "pending" } }),
  ]);
  return userCount + pendingInviteCount;
}

// null seat limit (plans.js) means unlimited.
export function hasSeatAvailable(seatLimit, used) {
  return seatLimit === null || seatLimit === undefined || used < seatLimit;
}
