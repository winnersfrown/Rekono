// A shared org-name validator for every place a name becomes visible to
// someone who hasn't signed up or logged in -- today that's the invite-
// accept page (GET /api/team/invite/:token, unauthenticated by design so an
// invitee can see who's inviting them before creating an account).
//
// Self-serve signup means anyone can set an organization's name to
// anything, and that name then renders on a public page immediately above
// a form asking for a name and password -- the exact shape of a classic
// phishing page ("verify your account"), just hosted on Rekono's own,
// otherwise-legitimate domain. This can't be closed by input validation
// alone (see index.html's invite-accept markup for the structural half of
// the fix -- the org name is framed as quoted third-party text, not a
// first-party notice, regardless of what it says), but rejecting the most
// mechanical version of the attack -- a name that's itself a URL, meant to
// bait a click -- is a cheap, zero-false-positive-risk layer worth having
// on top of that.
import { z } from "zod";

const URL_LIKE = /(https?:\/\/|www\.|\b[a-z0-9-]{2,63}\.(com|net|org|io|co|info|biz|xyz|link|click)\b)/i;

export const orgNameSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((name) => !URL_LIKE.test(name), {
    message: "Organization name can't contain a web address.",
  });
