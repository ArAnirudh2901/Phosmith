"use client"

import React, { useEffect } from 'react'
import { ClerkProvider, UserButton, useAuth } from '@clerk/nextjs'
import ProBadge from '@/components/pro-badge'
import { clerkAppearance, clerkLocalization } from '@/lib/clerk-appearance'

// The account control on the marketing page. Its own chunk, loaded only when the
// session cookie says someone is signed in, so a signed-out visitor still
// downloads no Clerk at all.

function SignedOutWatch({ onSignedOut }) {
  const { isLoaded, isSignedIn } = useAuth()
  // Signing out here leaves the header's cookie answer stale; hand it back.
  useEffect(() => {
    if (isLoaded && !isSignedIn) onSignedOut?.()
  }, [isLoaded, isSignedIn, onSignedOut])
  return null
}

export default function LandingAccount({ onSignedOut }) {
  return (
    <ClerkProvider afterSignOutUrl="/" appearance={clerkAppearance} localization={clerkLocalization}>
      <SignedOutWatch onSignedOut={onSignedOut} />
      <div className="flex items-center gap-2">
        <ProBadge size="sm" />
        <UserButton
          userProfileMode="modal"
          appearance={{ elements: { avatarBox: 'ring-2 ring-[#06B8D4]/40' } }}
        />
      </div>
    </ClerkProvider>
  )
}
