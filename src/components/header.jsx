"use client"

import { Show, SignInButton, SignUpButton, UserButton, useAuth } from '@clerk/nextjs'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import React, { useEffect, useState } from 'react'
import { LayoutDashboard, Sparkles, Menu, X, ArrowRight } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { useDashboardNavigation } from '@/hooks/useDashboardNavigation'
import InkDropLogo from '@/components/ink-drop-logo'
import { duration, easeOut } from '@/lib/motion'

const NavPill = ({ label, href, onClick }) => {
  if (href) {
    return (
      <a
        href={href}
        className="glass-nav-pill relative inline-flex items-center justify-center px-4 py-2 rounded-full text-sm font-medium"
        style={{ color: 'var(--text-secondary)' }}
      >
        {label}
      </a>
    )
  }

  return (
    <button
      type="button"
      onClick={onClick}
      className="glass-nav-pill relative inline-flex items-center justify-center px-4 py-2 rounded-full text-sm font-medium"
      style={{ color: 'var(--text-secondary)' }}
    >
      {label}
    </button>
  )
}

function AuthSkeleton() {
  return (
    <div
      className="flex items-center gap-2 min-w-[200px] sm:min-w-[280px] justify-end"
      aria-hidden="true"
    >
      <div className="hidden sm:block h-9 w-[88px] rounded-full bg-white/[0.06] border border-white/10 animate-pulse" />
      <div className="h-9 w-[118px] sm:w-[132px] rounded-full bg-white/[0.08] border border-white/10 animate-pulse" />
      <div className="md:hidden h-9 w-9 rounded-full bg-white/[0.06] border border-white/10 animate-pulse shrink-0" />
    </div>
  )
}

function AuthControls({
  navigateToDashboard,
  isDashboardRoute,
  isNavigatingToDashboard,
}) {
  return (
    <div className="flex items-center gap-2 min-w-[200px] sm:min-w-[280px] justify-end">
      <Show when="signed-out">
        <div className="flex items-center gap-2">
          <SignInButton>
            <button
              type="button"
              className="glass-action px-5 py-2 text-sm rounded-full font-medium hidden sm:block"
              style={{ color: 'var(--text-secondary)' }}
            >
              Sign In
            </button>
          </SignInButton>
          <SignUpButton>
            <button
              type="button"
              className="glass-action glass-action-primary px-5 py-2 text-sm font-semibold rounded-full flex items-center gap-1.5"
              style={{ color: '#F4E8D8' }}
            >
              <Sparkles className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Get Started</span>
              <span className="sm:hidden">Start</span>
              <ArrowRight className="h-3 w-3 hidden sm:block" />
            </button>
          </SignUpButton>
        </div>
      </Show>

      <Show when="signed-in">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={navigateToDashboard}
            disabled={isNavigatingToDashboard || isDashboardRoute}
            className="glass-action hidden sm:flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-full disabled:cursor-default disabled:opacity-80"
            style={{
              background: isDashboardRoute ? 'rgba(200,149,108,0.12)' : undefined,
              borderColor: isDashboardRoute ? 'rgba(200,149,108,0.22)' : undefined,
            }}
          >
            <LayoutDashboard className="h-4 w-4" />
            {isNavigatingToDashboard ? 'Opening...' : 'Dashboard'}
          </button>
          <div className="flex items-center">
            <UserButton
              userProfileMode="modal"
              appearance={{
                elements: {
                  avatarBox: 'ring-2 ring-[#00E5FF]/30 rounded-full',
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
      <header className="fixed top-0 left-0 right-0 z-50 flex justify-center pt-4 sm:pt-6 px-4">
        <nav
          className="transmission-glass flex items-center gap-3 sm:gap-6 px-4 py-2.5 sm:px-5 sm:py-3 rounded-full w-full max-w-6xl"
          style={{
            background: scrolled ? 'rgba(9, 12, 18, 0.52)' : 'rgba(9, 12, 18, 0.32)',
            borderColor: scrolled ? 'rgba(255,255,255,0.16)' : 'rgba(255,255,255,0.10)',
            transition: 'background 280ms cubic-bezier(0.16, 1, 0.3, 1), border-color 280ms cubic-bezier(0.16, 1, 0.3, 1)',
          }}
        >
          <Link href="/" className="flex items-center gap-2 shrink-0">
            <div
              className="glass-icon-surface w-8 h-8 sm:w-9 sm:h-9 rounded-xl flex items-center justify-center relative overflow-hidden transition-transform duration-200 hover:scale-[1.03]"
              style={{
                background: 'linear-gradient(135deg, rgba(0,229,255,0.12), rgba(200,149,108,0.08))',
                borderColor: 'rgba(255,255,255,0.12)',
              }}
            >
              <InkDropLogo />
            </div>
            <span className="text-lg sm:text-xl font-bold text-white tracking-tight relative">
              Pixxel
              <span
                className="absolute -bottom-0.5 left-0 w-full h-0.5"
                style={{ background: 'linear-gradient(90deg, transparent, var(--accent-warm-gold), var(--accent-ink), transparent)' }}
              />
            </span>
          </Link>

          <div className="hidden md:flex items-center gap-1 min-w-[180px]">
            {pathname === '/' ? (
              <>
                <NavPill href="#features" label="Features" />
                <NavPill href="#pricing" label="Pricing" />
              </>
            ) : (
              <span className="inline-block w-full" aria-hidden="true" />
            )}
          </div>

          <div className="flex-1 min-w-2" />

          <div className="flex items-center gap-2">
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
                  className="glass-action md:hidden inline-flex items-center justify-center p-2 text-[var(--text-secondary)] hover:text-white -mr-1"
                  aria-label="Open menu"
                >
                  <Menu className="h-5 w-5" />
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
              className="transmission-glass fixed top-0 right-0 w-64 h-full z-[70] p-6 flex flex-col rounded-none"
              style={{ borderRadius: 0, borderLeft: '1px solid rgba(255,255,255,0.12)' }}
              initial={{ x: '100%' }}
              animate={{ x: 0 }}
              exit={{ x: '100%' }}
              transition={{ duration: duration.normal, ease: easeOut }}
            >
              <div className="flex justify-between items-center mb-8">
                <span className="text-lg font-bold text-white">Menu</span>
                <button
                  type="button"
                  onClick={() => setMobileMenuOpen(false)}
                  className="p-2 text-[var(--text-muted)] hover:text-white rounded-lg transition-colors"
                  aria-label="Close menu"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
              <nav className="flex flex-col gap-2 flex-1">
                {pathname === '/' && (
                  <>
                    <a
                      href="#features"
                      onClick={() => setMobileMenuOpen(false)}
                      className="glass-nav-pill px-4 py-3 rounded-xl text-[var(--text-secondary)] hover:text-white"
                    >
                      Features
                    </a>
                    <a
                      href="#pricing"
                      onClick={() => setMobileMenuOpen(false)}
                      className="glass-nav-pill px-4 py-3 rounded-xl text-[var(--text-secondary)] hover:text-white"
                    >
                      Pricing
                    </a>
                  </>
                )}
              </nav>
              <div className="flex flex-col gap-2">
                <SignInButton>
                  <button
                    type="button"
                    className="glass-action w-full px-4 py-2.5 rounded-xl text-sm font-medium text-[var(--text-secondary)]"
                  >
                    Sign In
                  </button>
                </SignInButton>
                <SignUpButton>
                  <button
                    type="button"
                    className="glass-action glass-action-primary w-full px-4 py-2.5 rounded-xl text-sm font-semibold"
                    style={{ color: '#F4E8D8' }}
                  >
                    Get Started
                  </button>
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
