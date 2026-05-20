"use client"

import { useCallback, useEffect, useTransition } from "react"
import { usePathname, useRouter } from "next/navigation"

export function useDashboardNavigation() {
  const router = useRouter()
  const pathname = usePathname()
  const [isPending, startTransition] = useTransition()
  const isDashboardRoute = pathname === "/dashboard"

  useEffect(() => {
    router.prefetch("/dashboard")
  }, [router])

  const navigateToDashboard = useCallback((event) => {
    event?.preventDefault?.()

    if (isPending || isDashboardRoute) {
      return
    }

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
