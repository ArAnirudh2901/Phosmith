import { Suspense } from "react";
import ClerkShell from "@/app/clerk-shell";
import Header from "@/components/header";
import { HeaderFallback } from "@/components/header-shell";

export default function MainLayout({ children }) {
  return (
    <ClerkShell>
      <Suspense fallback={<HeaderFallback />}>
        <Header />
      </Suspense>
      {children}
    </ClerkShell>
  );
}
