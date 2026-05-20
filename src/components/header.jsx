"use client"

import { Show, SignInButton, SignUpButton, UserButton } from '@clerk/nextjs'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import React, { useEffect, useState } from 'react'
import { LayoutDashboard, Sparkles, Menu, X, ArrowRight } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { useDashboardNavigation } from '@/hooks/useDashboardNavigation'
import InkDropLogo from '@/components/ink-drop-logo'

const NavPill = ({ label, href, isActive, onClick }) => {
  const MotionTag = href ? motion.a : motion.button

  return (
  <MotionTag
    href={href}
    onClick={onClick || undefined}
    className="glass-nav-pill relative group inline-flex items-center justify-center px-4 py-2 rounded-full text-sm font-medium"
    style={{
      color: 'var(--text-secondary)',
      background: isActive ? 'rgba(255, 255, 255, 0.06)' : 'rgba(0, 0, 0, 0)',
    }}
    whileTap={{ scale: 0.98 }}
  >
    <span
      className="relative z-10"
      style={{ color: isActive ? 'var(--accent-ink)' : 'var(--text-secondary)' }}
    >
      {label}
    </span>
    {isActive && (
      <motion.div
        className="absolute inset-0 rounded-full"
        style={{
          background: 'linear-gradient(135deg, rgba(255,255,255,0.08), rgba(200,149,108,0.06))',
          border: '1px solid rgba(255,255,255,0.14)',
          boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.12)',
        }}
        layoutId="navPill"
        transition={{ type: 'spring', stiffness: 360, damping: 32 }}
      />
    )}
  </MotionTag>
  )
}

const Header = () => {
  const pathname = usePathname()
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
        <motion.nav
          initial={{ y: -20, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ delay: 0.3, duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
          className="transmission-glass flex items-center gap-3 sm:gap-6 px-4 py-2.5 sm:px-5 sm:py-3 rounded-full"
          style={{
            background: scrolled ? 'rgba(9, 12, 18, 0.52)' : 'rgba(9, 12, 18, 0.32)',
            borderColor: scrolled ? 'rgba(255,255,255,0.16)' : 'rgba(255,255,255,0.10)',
            transition: 'background 360ms cubic-bezier(0.22, 1, 0.36, 1), border-color 360ms cubic-bezier(0.22, 1, 0.36, 1)',
          }}
        >
          <Link href="/" className="flex items-center gap-2 shrink-0">
            <motion.div whileHover={{ rotate: -8, scale: 1.05 }} transition={{ type: 'spring', stiffness: 300 }}>
              <div
                className="glass-icon-surface w-8 h-8 sm:w-9 sm:h-9 rounded-xl flex items-center justify-center relative overflow-hidden"
                style={{
                  background: 'linear-gradient(135deg, rgba(0,229,255,0.12), rgba(200,149,108,0.08))',
                  borderColor: 'rgba(255,255,255,0.12)',
                }}
              >
                <InkDropLogo />
              </div>
            </motion.div>
            <span className="text-lg sm:text-xl font-bold text-white tracking-tight relative">
              Pixxel
              <span
                className="absolute -bottom-0.5 left-0 w-full h-0.5"
                style={{ background: 'linear-gradient(90deg, transparent, var(--accent-warm-gold), var(--accent-ink), transparent)' }}
              />
            </span>
          </Link>

          {/* Desktop Navigation */}
          <div className="hidden md:flex items-center gap-1">
            {pathname === '/' && (
              <>
                <NavPill href="#features" label="Features" />
                <NavPill href="#pricing" label="Pricing" />
              </>
            )}
          </div>

          <div className="flex-1" />

          {/* Auth buttons */}
          <div className="flex items-center gap-2">
            <Show when="signed-out">
              <motion.div
                key="signed-out"
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.2 }}
                className="flex items-center gap-2"
              >
                <SignInButton>
                  <button
                    className="glass-action px-5 py-2 text-sm rounded-full font-medium hidden sm:block"
                    style={{
                      color: 'var(--text-secondary)',
                    }}
                  >
                    Sign In
                  </button>
                </SignInButton>
                <SignUpButton>
                  <motion.button
                    whileTap={{ scale: 0.97 }}
                    className="glass-action glass-action-primary px-5 py-2 text-sm font-semibold rounded-full flex items-center gap-1.5"
                    style={{
                      color: '#F4E8D8',
                    }}
                  >
                    <Sparkles className="h-3.5 w-3.5" />
                    <span className="hidden sm:inline">Get Started</span>
                    <span className="sm:hidden">Start</span>
                    <div>
                      <ArrowRight className="h-3 w-3 hidden sm:block" />
                    </div>
                  </motion.button>
                </SignUpButton>
              </motion.div>
            </Show>

            <Show when="signed-in">
              <motion.div
                key="signed-in"
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.2 }}
                className="flex items-center gap-2"
              >
                <motion.button
                  type="button"
                  onClick={navigateToDashboard}
                  disabled={isNavigatingToDashboard || isDashboardRoute}
                  whileTap={{ scale: 0.97 }}
                  className="glass-action hidden sm:flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-full disabled:cursor-default disabled:opacity-80"
                  style={{
                    background: isDashboardRoute ? 'rgba(200,149,108,0.12)' : undefined,
                    borderColor: isDashboardRoute ? 'rgba(200,149,108,0.22)' : undefined,
                  }}
                >
                  <LayoutDashboard className="h-4 w-4" />
                  {isNavigatingToDashboard ? 'Opening...' : 'Dashboard'}
                </motion.button>

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
              </motion.div>
            </Show>

            {/* Mobile menu toggle */}
            <motion.button
              onClick={() => setMobileMenuOpen(true)}
              className="glass-action md:hidden inline-flex items-center justify-center p-2 text-[var(--text-secondary)] hover:text-white"
              whileTap={{ scale: 0.9 }}
            >
              <Menu className="h-5 w-5" />
            </motion.button>
          </div>
        </motion.nav>
      </header>

      {/* Mobile Menu Drawer */}
      <AnimatePresence>
        {mobileMenuOpen && (
          <>
            <motion.div
              className="fixed inset-0 bg-black/35 backdrop-blur-sm z-[60]"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setMobileMenuOpen(false)}
            />
            <motion.div
              className="transmission-glass fixed top-0 right-0 w-64 h-full z-[70] p-6 flex flex-col rounded-none"
              style={{ borderRadius: 0, borderLeft: '1px solid rgba(255,255,255,0.12)' }}
              initial={{ x: '100%' }}
              animate={{ x: 0 }}
              exit={{ x: '100%' }}
              transition={{ type: 'spring', damping: 25 }}
            >
              <div className="flex justify-between items-center mb-8">
                <span className="text-lg font-bold text-white">Menu</span>
                <motion.button
                  onClick={() => setMobileMenuOpen(false)}
                  whileTap={{ scale: 0.9 }}
                  className="p-2 text-[var(--text-muted)] hover:text-white rounded-lg transition-colors"
                >
                  <X className="h-5 w-5" />
                </motion.button>
              </div>
              <nav className="flex flex-col gap-2 flex-1">
                {pathname === '/' && (
                  <>
                    <a href="#features" onClick={() => setMobileMenuOpen(false)}
                      className="glass-nav-pill px-4 py-3 rounded-xl text-[var(--text-secondary)] hover:text-white">
                      Features
                    </a>
                    <a href="#pricing" onClick={() => setMobileMenuOpen(false)}
                      className="glass-nav-pill px-4 py-3 rounded-xl text-[var(--text-secondary)] hover:text-white">
                      Pricing
                    </a>
                  </>
                )}
              </nav>
              <div className="flex flex-col gap-2">
                <SignInButton>
                  <button className="glass-action w-full px-4 py-2.5 rounded-xl text-sm font-medium text-[var(--text-secondary)]">
                    Sign In
                  </button>
                </SignInButton>
                <SignUpButton>
                  <button className="glass-action glass-action-primary w-full px-4 py-2.5 rounded-xl text-sm font-semibold"
                    style={{ color: '#F4E8D8' }}>
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
