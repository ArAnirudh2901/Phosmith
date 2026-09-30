"use client"

import { useCallback, useEffect, useTransition } from "react"
import { usePathname, useRouter } from "next/navigation"
import { hasSessionCookie } from "@/lib/session-hint"
import { preloadDashboard } from "@/lib/query-preload"

export function useDashboardNavigation() {
  const router = useRouter()
  const pathname = usePathname()
  const [isPending, startTransition] = useTransition()
  const isDashboardRoute = pathname === "/dashboard"

  // Prefetching /dashboard pulls the Clerk client SDK with it, so a signed-out
  // visitor on the marketing page must not pay for it.
  useEffect(() => {
    if (hasSessionCookie()) router.prefetch("/dashboard")
  }, [router])

  const navigateToDashboard = useCallback((event) => {
    event?.preventDefault?.()

    if (isPending || isDashboardRoute) {
      return
    }

    preloadDashboard()

    startTransition(() => {
      router.push("/dashboard", { scroll: false })
    })
  }, [isDashboardRoute, isPending, router])

  return {
    navigateToDashboard,
    isDashboardRoute,
    isNavigatingToDashboard: isPending,
  }
}
