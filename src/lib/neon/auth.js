import { auth, currentUser } from "@clerk/nextjs/server";

const displayNameFrom = (user, claims) =>
  user?.fullName?.trim?.() ||
  user?.username?.trim?.() ||
  user?.primaryEmailAddress?.emailAddress?.split("@")[0] ||
  claims?.name ||
  claims?.email?.split?.("@")?.[0] ||
  "Anonymous";

export const getNeonAuthContext = async () => {
  const session = await auth();
  if (!session?.userId) return null;

  let user = null;
  try {
    user = await currentUser();
  } catch {
    user = null;
  }

  const claims = session.sessionClaims || {};
  const email =
    user?.primaryEmailAddress?.emailAddress ||
    claims.email ||
    claims.primary_email_address ||
    null;

  return {
    clerkUserId: session.userId,
    tokenIdentifier: `clerk:${session.userId}`,
    name: displayNameFrom(user, claims),
    email,
    imageUrl: user?.imageUrl || claims.picture || null,
  };
};
