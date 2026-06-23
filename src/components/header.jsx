"use client"

import { Show, SignInButton, SignUpButton, UserButton, useAuth } from '@clerk/nextjs'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import React, { useEffect, useState } from 'react'
import { LayoutDashboard, Menu, X } from 'lucide-react'
import ProBadge from '@/components/pro-badge'
import PixxelWordmark from '@/components/phosmith-wordmark'
import { motion, AnimatePresence } from 'framer-motion'
import { useDashboardNavigation } from '@/hooks/useDashboardNavigation'
import { duration, easeOut } from '@/lib/motion'
import NeoButton from '@/components/neo/NeoButton'

const NEO_NAV_STYLE = {
  position: 'relative',
  display: 'inline-flex',
  alignItems: 'center',
  padding: '8px 16px',
  fontFamily: 'var(--font-mono, ui-monospace, "SF Mono", Menlo, monospace)',
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: '0.16em',
  textTransform: 'uppercase',
  color: '#F4F4F5',
  background: 'transparent',
  border: '2px solid transparent',
  cursor: 'pointer',
  transition: 'border-color 120ms ease, background 120ms ease',
}

const NavPill = ({ label, href, onClick }) => {
  const Tag = href ? 'a' : 'button'
  return (
    <Tag
      {...(href ? { href } : { type: 'button', onClick })}
      style={NEO_NAV_STYLE}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = '#F4F4F5'
        e.currentTarget.style.background = '#0E1118'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = 'transparent'
        e.currentTarget.style.background = 'transparent'
      }}
    >
      {label}
    </Tag>
  )
}

function AuthSkeleton() {
  return (
    <div
      className="flex items-center gap-2 min-w-[200px] sm:min-w-[280px] justify-end"
      aria-hidden="true"
    >
      <div className="hidden sm:block h-9 w-[88px] bg-[#0E1118] border-2 border-[#F4F4F5] animate-pulse" />
      <div className="h-9 w-[118px] sm:w-[132px] bg-[#0E1118] border-2 border-[#F4F4F5] animate-pulse" />
      <div className="md:hidden h-9 w-9 bg-[#0E1118] border-2 border-[#F4F4F5] animate-pulse shrink-0" />
    </div>
  )
}

function AuthControls({
  navigateToDashboard,
  isDashboardRoute,
  isNavigatingToDashboard,
}) {
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

const Header = () => {
  const pathname = usePathname()
  const { isLoaded } = useAuth()
  const [scrolled, setScrolled] = useState(false)
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const {
    navigateToDashboard,
    isDashboardRoute,
    isNavigatingToDashboard,
  } = useDashboardNavigation()

  useEffect(() => {
    const handleScroll = () => setScrolled(window.scrollY > 20)
    window.addEventListener('scroll', handleScroll, { passive: true })
    return () => window.removeEventListener('scroll', handleScroll)
  }, [])

  if (pathname.includes('/editor')) {
    return null
  }

  return (
    <>
      <header
        className="fixed top-0 left-0 right-0 z-50"
        style={{
          background: scrolled ? '#07090E' : 'rgba(7,9,14,0.92)',
          borderBottom: '2px solid #F4F4F5',
          transition: 'background 200ms ease',
          backdropFilter: scrolled ? 'none' : 'blur(6px)',
        }}
      >
        <nav className="flex items-center gap-3 sm:gap-6 pl-4 pr-4 sm:pr-6 h-16 w-full max-w-7xl mx-auto">
          <Link href="/" className="flex items-center shrink-0 group transition-opacity group-hover:opacity-90">
            <PixxelWordmark height={24} markScale={1.2} showText={false} />
          </Link>

          <div className="hidden md:flex items-center gap-1 ml-4">
            {pathname === '/' ? (
              <>
                <NavPill href="#features" label="Features" />
                <NavPill href="#pricing" label="Pricing" />
              </>
            ) : null}
          </div>

          <div className="flex-1" />

          <div className="flex items-center gap-3">
            {!isLoaded ? (
              <AuthSkeleton />
            ) : (
              <>
                <AuthControls
                  navigateToDashboard={navigateToDashboard}
                  isDashboardRoute={isDashboardRoute}
                  isNavigatingToDashboard={isNavigatingToDashboard}
                />
                <button
                  type="button"
                  onClick={() => setMobileMenuOpen(true)}
                  className="md:hidden inline-flex items-center justify-center"
                  style={{
                    width: 36,
                    height: 36,
                    background: '#0E1118',
                    border: '2px solid #F4F4F5',
                    color: '#F4F4F5',
                  }}
                  aria-label="Open menu"
                >
                  <Menu className="h-5 w-5" strokeWidth={2.5} />
                </button>
              </>
            )}
          </div>
        </nav>
      </header>

      <AnimatePresence>
        {mobileMenuOpen && (
          <>
            <motion.div
              className="fixed inset-0 bg-black/35 backdrop-blur-sm z-[60]"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: duration.fast, ease: easeOut }}
              onClick={() => setMobileMenuOpen(false)}
            />
            <motion.div
              className="fixed top-0 right-0 w-72 h-full z-[70] flex flex-col"
              style={{
                background: '#07090E',
                borderLeft: '2px solid #F4F4F5',
                padding: 24,
              }}
              initial={{ x: '100%' }}
              animate={{ x: 0 }}
              exit={{ x: '100%' }}
              transition={{ duration: duration.normal, ease: easeOut }}
            >
              <div className="flex justify-between items-center mb-8">
                <span
                  style={{
                    fontFamily: 'var(--font-mono, ui-monospace, "SF Mono", Menlo, monospace)',
                    fontSize: 12,
                    fontWeight: 700,
                    color: '#F4F4F5',
                    letterSpacing: '0.18em',
                    textTransform: 'uppercase',
                  }}
                >
                  Menu
                </span>
                <button
                  type="button"
                  onClick={() => setMobileMenuOpen(false)}
                  style={{
                    width: 32,
                    height: 32,
                    background: '#0E1118',
                    border: '2px solid #F4F4F5',
                    color: '#F4F4F5',
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                  aria-label="Close menu"
                >
                  <X className="h-4 w-4" strokeWidth={2.5} />
                </button>
              </div>
              <nav className="flex flex-col gap-2 flex-1">
                {pathname === '/' && (
                  <>
                    <a
                      href="#features"
                      onClick={() => setMobileMenuOpen(false)}
                      style={{
                        padding: '14px 16px',
                        border: '2px solid #F4F4F5',
                        background: '#0E1118',
                        color: '#F4F4F5',
                        fontFamily: 'var(--font-mono, ui-monospace, "SF Mono", Menlo, monospace)',
                        fontSize: 12,
                        fontWeight: 700,
                        letterSpacing: '0.14em',
                        textTransform: 'uppercase',
                      }}
                    >
                      Features
                    </a>
                    <a
                      href="#pricing"
                      onClick={() => setMobileMenuOpen(false)}
                      style={{
                        padding: '14px 16px',
                        border: '2px solid #F4F4F5',
                        background: '#0E1118',
                        color: '#F4F4F5',
                        fontFamily: 'var(--font-mono, ui-monospace, "SF Mono", Menlo, monospace)',
                        fontSize: 12,
                        fontWeight: 700,
                        letterSpacing: '0.14em',
                        textTransform: 'uppercase',
                      }}
                    >
                      Pricing
                    </a>
                  </>
                )}
              </nav>
              <div className="flex flex-col gap-3">
                <SignInButton>
                  <NeoButton variant="ghost" size="md" magnetic={false}>Sign In</NeoButton>
                </SignInButton>
                <SignUpButton>
                  <NeoButton variant="primary" size="md" magnetic={false}>Get Started</NeoButton>
                </SignUpButton>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </>
  )
}

export default Header
