"use client"

import Link from 'next/link'
import dynamic from 'next/dynamic'
import React, { useCallback, useEffect, useState } from 'react'
import { LayoutDashboard } from 'lucide-react'
import NeoButton from '@/components/neo/NeoButton'
import HeaderShell from '@/components/header-shell'
import { hasSessionCookie } from '@/lib/session-hint'
import { preloadDashboard } from '@/lib/query-preload'

// The marketing route's header. Clerk's client SDK is 138 KB of app chunks plus 16
// requests to its CDN, and the only thing this bar needs from it is whether a
// session exists — which the readable __client_uat cookie already answers. Sign in
// and sign up are real routes, so they are plain links: prefetching them would pull
// Clerk back onto this page for the visitors least likely to need it.

const SLOT_CLASS = 'flex items-center gap-3 min-w-[200px] sm:min-w-[280px] justify-end'

// Same footprint as the avatar, so the bar does not shift when it arrives.
const AvatarPlaceholder = () => (
  <span aria-hidden className="inline-block size-7 max-md:size-11 rounded-full bg-white/10 ring-2 ring-[#06B8D4]/20" />
)

const LandingAccount = dynamic(() => import('@/components/landing-account'), {
  ssr: false,
  loading: AvatarPlaceholder,
})

function LandingAuth({ drawer = false }) {
  // Static HTML renders the signed-out links, which is both the common case and
  // what a crawler should see; the cookie check corrects it on hydration.
  const [signedIn, setSignedIn] = useState(false)
  // The account control waits for an idle moment so Clerk never competes with
  // the page's own first paint.
  const [accountReady, setAccountReady] = useState(false)

  useEffect(() => {
    setSignedIn(hasSessionCookie())
  }, [])

  useEffect(() => {
    if (!signedIn || drawer) return undefined
    const idle = window.requestIdleCallback || ((fn) => window.setTimeout(fn, 200))
    const cancel = window.cancelIdleCallback || window.clearTimeout
    const id = idle(() => setAccountReady(true), { timeout: 1500 })
    return () => cancel(id)
  }, [signedIn, drawer])

  const onSignedOut = useCallback(() => setSignedIn(false), [])

  const body = signedIn ? (
    <>
    <NeoButton
      as={Link}
      href="/dashboard"
      variant="secondary"
      size="md"
      magnetic={false}
      // Both dashboard reads wait on Clerk booting there; this page carries no
      // Clerk, so start them on the press instead.
      onPointerDown={preloadDashboard}
    >
      <LayoutDashboard className="h-4 w-4" strokeWidth={2.5} />
      Dashboard
    </NeoButton>
    {!drawer && (accountReady ? <LandingAccount onSignedOut={onSignedOut} /> : <AvatarPlaceholder />)}
    </>
  ) : (
    <>
      <NeoButton variant="ghost" size="md" magnetic={false} href="/sign-in">Sign In</NeoButton>
      <NeoButton variant="primary" size="md" magnetic={!drawer} href="/sign-up">Get Started</NeoButton>
    </>
  )

  return drawer ? body : <div className={SLOT_CLASS}>{body}</div>
}

const LandingHeader = () => (
  <HeaderShell authSlot={<LandingAuth />} drawerAuthSlot={<LandingAuth drawer />} />
)

export default LandingHeader
