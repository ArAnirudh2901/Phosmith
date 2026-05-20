"use client"

import { useEffect, useRef } from 'react'
import Lenis from 'lenis'

export function SmoothScrollProvider({ children }) {
  const lenisRef = useRef(null)
  const frameRef = useRef(null)

  useEffect(() => {
    const lenis = new Lenis({
      duration: 1.2,
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
  }, [])

  useEffect(() => {
    const lenis = lenisRef.current
    if (!lenis) return

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
  }, [])

  return children
}
