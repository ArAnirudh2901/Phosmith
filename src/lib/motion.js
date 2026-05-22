"use client"

import { useReducedMotion as useFramerReducedMotion } from "framer-motion"

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

export function useReducedMotion() {
  return useFramerReducedMotion() ?? false
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
