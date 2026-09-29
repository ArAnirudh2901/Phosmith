"use client"

import { Show, SignInButton, SignUpButton, UserButton, useAuth } from '@clerk/nextjs'
import React from 'react'
import { LayoutDashboard } from 'lucide-react'
import ProBadge from '@/components/pro-badge'
import { useDashboardNavigation } from '@/hooks/useDashboardNavigation'
import NeoButton from '@/components/neo/NeoButton'
import HeaderShell, { AuthSlotSkeleton } from '@/components/header-shell'

// The signed-in header. Only routes that already need Clerk mount this one;
// the marketing route uses landing-header.jsx instead.

function AuthControls() {
  const { isLoaded } = useAuth()
  const { navigateToDashboard, isDashboardRoute, isNavigatingToDashboard } = useDashboardNavigation()

  if (!isLoaded) return <AuthSlotSkeleton />

  return (
    <div className="flex items-center gap-3 min-w-[200px] sm:min-w-[280px] justify-end">
      <Show when="signed-out">
        <div className="flex items-center gap-3">
          <SignInButton>
            <NeoButton variant="ghost" size="md" magnetic={false}>Sign In</NeoButton>
          </SignInButton>
          <SignUpButton>
            <NeoButton variant="primary" size="md">Get Started</NeoButton>
          </SignUpButton>
        </div>
      </Show>

      <Show when="signed-in">
        <div className="flex items-center gap-3">
          <NeoButton
            variant="secondary"
            size="md"
            magnetic={false}
            disabled={isNavigatingToDashboard || isDashboardRoute}
            onClick={navigateToDashboard}
          >
            <LayoutDashboard className="h-4 w-4" strokeWidth={2.5} />
            {isNavigatingToDashboard ? 'Opening' : 'Dashboard'}
          </NeoButton>
          <div className="flex items-center gap-2">
            <ProBadge size="sm" />
            <UserButton
              userProfileMode="modal"
              appearance={{
                elements: {
                  avatarBox: 'ring-2 ring-[#06B8D4]/40',
                },
              }}
            />
          </div>
        </div>
      </Show>
    </div>
  )
}

function DrawerControls() {
  return (
    <>
      <SignInButton>
        <NeoButton variant="ghost" size="md" magnetic={false}>Sign In</NeoButton>
      </SignInButton>
      <SignUpButton>
        <NeoButton variant="primary" size="md" magnetic={false}>Get Started</NeoButton>
      </SignUpButton>
    </>
  )
}

const Header = () => <HeaderShell authSlot={<AuthControls />} drawerAuthSlot={<DrawerControls />} />

export default Header
