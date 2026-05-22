"use client"

import { useEffect, useRef } from 'react'
import { usePathname } from 'next/navigation'
import Lenis from 'lenis'
import { useReducedMotion } from '@/lib/motion'

const NATIVE_SCROLL_ROUTES = ['/dashboard', '/editor']

function shouldUseNativeScroll(pathname) {
  if (!pathname) return false
  return NATIVE_SCROLL_ROUTES.some(
    (route) => pathname === route || pathname.startsWith(`${route}/`)
  )
}

export function SmoothScrollProvider({ children }) {
  const pathname = usePathname()
  const reduced = useReducedMotion()
  const lenisRef = useRef(null)
  const frameRef = useRef(null)

  useEffect(() => {
    if (reduced || shouldUseNativeScroll(pathname)) {
      if (lenisRef.current) {
        lenisRef.current.destroy()
        lenisRef.current = null
      }
      if (frameRef.current) {
        cancelAnimationFrame(frameRef.current)
        frameRef.current = null
      }
      return undefined
    }

    const lenis = new Lenis({
      duration: 0.85,
      easing: (t) => Math.min(1, 1.001 - Math.pow(2, -10 * t)),
      smoothWheel: true,
      syncTouch: false,
    })

    lenisRef.current = lenis

    function raf(time) {
      lenis.raf(time)
      frameRef.current = requestAnimationFrame(raf)
    }

    frameRef.current = requestAnimationFrame(raf)

    return () => {
      if (frameRef.current) cancelAnimationFrame(frameRef.current)
      frameRef.current = null
      lenisRef.current = null
      lenis.destroy()
    }
  }, [pathname, reduced])

  useEffect(() => {
    const lenis = lenisRef.current
    if (!lenis) return undefined

    const handleClick = (e) => {
      if (!(e.target instanceof Element)) return
      const anchor = e.target.closest('a[href^="#"]')
      if (!anchor) return
      const target = document.querySelector(anchor.getAttribute('href'))
      if (!target) return

      e.preventDefault()
      lenis.scrollTo(target, { offset: -80 })
    }

    window.addEventListener('click', handleClick)
    return () => window.removeEventListener('click', handleClick)
  }, [pathname, reduced])

  return children
}
