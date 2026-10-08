import { ClerkProvider } from "@clerk/nextjs";
import { clerkAppearance, clerkLocalization } from "@/lib/clerk-appearance";

// ClerkProvider used to sit in the root layout, which made the marketing route
// download the whole Clerk client SDK it never calls. Only the route groups that
// use Clerk mount this.

export default function ClerkShell({ children }) {
  return (
    <ClerkProvider
      afterSignOutUrl="/"
      appearance={clerkAppearance}
      localization={clerkLocalization}
    >
      {children}
    </ClerkProvider>
  );
}
