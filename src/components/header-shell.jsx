"use client"

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import React, { useEffect, useState } from 'react'
import { Menu, X } from 'lucide-react'
import PhosmithWordmark from '@/components/phosmith-wordmark'

// Header chrome with no auth dependency, so the marketing route can use it
// without the Clerk client bundle. Callers pass the auth controls in.

export const NEO_NAV_STYLE = {
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

const DRAWER_LINK_STYLE = {
  padding: '14px 16px',
  border: '2px solid #F4F4F5',
  background: '#0E1118',
  color: '#F4F4F5',
  fontFamily: 'var(--font-mono, ui-monospace, "SF Mono", Menlo, monospace)',
  fontSize: 12,
  fontWeight: 700,
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
}

export const NavPill = ({ label, href, onClick }) => {
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

/** Matches the real bar's box, so the Suspense swap does not shift the page. */
export function HeaderFallback() {
  return (
    <div
      className="fixed top-0 left-0 right-0 z-50 h-16"
      style={{ background: 'rgba(7,9,14,0.92)', borderBottom: '2px solid #F4F4F5' }}
      aria-hidden="true"
    />
  )
}

export function AuthSlotSkeleton() {
  return (
    <div
      className="flex items-center gap-2 min-w-[200px] sm:min-w-[280px] justify-end"
      aria-hidden="true"
    >
      <div className="hidden sm:block h-9 w-[88px] bg-[#0E1118] border-2 border-[#F4F4F5] animate-pulse" />
      <div className="h-9 w-[118px] sm:w-[132px] bg-[#0E1118] border-2 border-[#F4F4F5] animate-pulse" />
    </div>
  )
}

const HeaderShell = ({ authSlot, drawerAuthSlot }) => {
  const pathname = usePathname()
  const [scrolled, setScrolled] = useState(false)
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)

  useEffect(() => {
    const handleScroll = () => setScrolled(window.scrollY > 20)
    window.addEventListener('scroll', handleScroll, { passive: true })
    return () => window.removeEventListener('scroll', handleScroll)
  }, [])

  if (pathname.includes('/editor')) {
    return null
  }

  const onMarketing = pathname === '/'

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
            <PhosmithWordmark height={30} markScale={1.5} showText={false} />
          </Link>

          <div className="hidden md:flex items-center gap-1 ml-4">
            {onMarketing ? (
              <>
                <NavPill href="#features" label="Features" />
                <NavPill href="#pricing" label="Pricing" />
              </>
            ) : null}
          </div>

          <div className="flex-1" />

          <div className="flex items-center gap-3">
            {authSlot}
            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              className="md:hidden inline-flex items-center justify-center"
              style={{
                width: 36,
                height: 36,
                minWidth: 44,
                minHeight: 44,
                background: '#0E1118',
                border: '2px solid #F4F4F5',
                color: '#F4F4F5',
              }}
              aria-label="Open menu"
            >
              <Menu className="h-5 w-5" strokeWidth={2.5} />
            </button>
          </div>
        </nav>
      </header>

      <div
        className="nav-drawer-scrim fixed inset-0 bg-black/35 backdrop-blur-sm z-[60]"
        data-open={mobileMenuOpen}
        onClick={() => setMobileMenuOpen(false)}
        aria-hidden="true"
      />
      <div
        className="nav-drawer fixed top-0 right-0 w-72 h-full z-[70] flex flex-col"
        data-open={mobileMenuOpen}
        // Stays mounted to animate both ways in CSS; visibility:hidden when closed,
        // so it is never an invisible click target.
        // React 19 reads inert as a boolean, and the empty string it used to get is
        // falsy — so the closed drawer kept its links focusable.
        inert={!mobileMenuOpen}
        style={{
          background: '#07090E',
          borderLeft: '2px solid #F4F4F5',
          padding: 24,
        }}
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
          {onMarketing ? (
            <>
              <a href="#features" onClick={() => setMobileMenuOpen(false)} style={DRAWER_LINK_STYLE}>
                Features
              </a>
              <a href="#pricing" onClick={() => setMobileMenuOpen(false)} style={DRAWER_LINK_STYLE}>
                Pricing
              </a>
            </>
          ) : null}
        </nav>
        <div className="flex flex-col gap-3">{drawerAuthSlot}</div>
      </div>
    </>
  )
}

export default HeaderShell
