"use client"

import { useEffect, useState } from "react"

export const easeOut = [0.16, 1, 0.3, 1]

export const duration = {
  fast: 0.2,
  normal: 0.35,
  slow: 0.5,
}

export const transition = {
  fast: { duration: duration.fast, ease: easeOut },
  normal: { duration: duration.normal, ease: easeOut },
  slow: { duration: duration.slow, ease: easeOut },
}

export const viewport = {
  once: true,
  margin: "-10%",
}

export const fadeUp = {
  hidden: { opacity: 0, y: 12 },
  visible: {
    opacity: 1,
    y: 0,
    transition: transition.normal,
  },
}

export const fadeIn = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: transition.fast,
  },
}

export const staggerContainer = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      staggerChildren: 0.06,
      delayChildren: 0.04,
    },
  },
}

export const staggerItem = {
  hidden: { opacity: 0, y: 12 },
  visible: {
    opacity: 1,
    y: 0,
    transition: transition.normal,
  },
}

/** Cap per-item delay for indexed lists (e.g. grid cards). */
export function staggerDelay(index, step = 0.04, max = 0.2) {
  return Math.min(index * step, max)
}

// Reads the media query directly rather than through framer-motion: this module
// is imported by the root layout, so a framer import here puts the whole library
// in the shared bundle every route pays for before first paint.
export function useReducedMotion() {
  const [reduced, setReduced] = useState(false)

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)")
    setReduced(query.matches)
    const onChange = (event) => setReduced(event.matches)
    query.addEventListener("change", onChange)
    return () => query.removeEventListener("change", onChange)
  }, [])

  return reduced
}

export function motionVariants(variants, reduced) {
  if (!reduced) return variants
  return {
    hidden: { opacity: 1, y: 0, scale: 1 },
    visible: { opacity: 1, y: 0, scale: 1, transition: { duration: 0 } },
  }
}

export function whileInViewProps(reduced) {
  if (reduced) {
    return { initial: false, animate: { opacity: 1, y: 0 } }
  }
  return {
    initial: "hidden",
    whileInView: "visible",
    viewport,
  }
}
