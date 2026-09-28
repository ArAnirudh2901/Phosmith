import { auth, currentUser } from "@clerk/nextjs/server";

const displayNameFrom = (user, claims) =>
  user?.fullName?.trim?.() ||
  user?.username?.trim?.() ||
  user?.primaryEmailAddress?.emailAddress?.split("@")[0] ||
  claims?.name ||
  claims?.email?.split?.("@")?.[0] ||
  "Anonymous";

const emailFrom = (user, claims) =>
  user?.primaryEmailAddress?.emailAddress ||
  claims?.email ||
  claims?.primary_email_address ||
  null;

/**
 * Auth context for a Neon call, built from the SESSION CLAIMS alone.
 *
 * `auth()` verifies the session JWT locally; `currentUser()` is a network round
 * trip to Clerk's API, and it was being made on every single query — roughly
 * 400ms added to every read, on a page that makes a dozen of them. Almost none
 * of them need it: the user row is found by `clerk:<id>`, which the claims
 * already carry. The profile is only required when a row has to be WRITTEN, so
 * it is fetched lazily through `loadProfile()` and cached for the request.
 */
export const getNeonAuthContext = async () => {
  const session = await auth();
  if (!session?.userId) return null;

  const claims = session.sessionClaims || {};
  let profile;

  const ctx = {
    clerkUserId: session.userId,
    tokenIdentifier: `clerk:${session.userId}`,
    name: displayNameFrom(null, claims),
    email: emailFrom(null, claims),
    imageUrl: claims.picture || null,
    /** Fill name/email/imageUrl from Clerk — only worth it before a write. */
    loadProfile: async () => {
      if (profile === undefined) {
        try {
          profile = await currentUser();
        } catch {
          profile = null;
        }
        if (profile) {
          ctx.name = displayNameFrom(profile, claims);
          ctx.email = emailFrom(profile, claims);
          ctx.imageUrl = profile.imageUrl || ctx.imageUrl;
        }
      }
      return ctx;
    },
  };

  return ctx;
};
