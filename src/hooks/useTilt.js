"use client"

import { useRef, useCallback, useEffect } from 'react'

export function useTilt(options = {}) {
  const {
    maxTilt = 15,
    perspective = 1000,
    scale = 1.03,
    speed = 400,
    glare = true,
    glareOpacity = 0.08,
    glareClassName = 'tilt-glare',
  } = options

  const ref = useRef(null)

  const handleMouseMove = useCallback(
    (e) => {
      const el = ref.current
      if (!el) return

      const rect = el.getBoundingClientRect()
      const x = e.clientX - rect.left
      const y = e.clientY - rect.top
      const centerX = rect.width / 2
      const centerY = rect.height / 2
      const percentX = (x - centerX) / centerX
      const percentY = (y - centerY) / centerY

      const tiltX = percentY * -maxTilt
      const tiltY = percentX * maxTilt

      el.style.transform = `perspective(${perspective}px) rotateX(${tiltX}deg) rotateY(${tiltY}deg) scale3d(${scale}, ${scale}, ${scale})`
      el.style.transition = `transform ${speed}ms cubic-bezier(0.03, 0.98, 0.52, 0.99)`

      if (glare) {
        const glareEl = el.querySelector(`.${glareClassName}`)
        if (glareEl) {
          glareEl.style.background = `radial-gradient(circle at ${(x / rect.width) * 100}% ${(y / rect.height) * 100}%, rgba(255,255,255,${glareOpacity}) 0%, transparent 60%)`
        }
      }
    },
    [maxTilt, perspective, scale, speed, glare, glareOpacity, glareClassName]
  )

  const handleMouseLeave = useCallback(() => {
    const el = ref.current
    if (!el) return
    el.style.transform = `perspective(${perspective}px) rotateX(0) rotateY(0) scale3d(1, 1, 1)`
    el.style.transition = `transform ${speed * 2}ms cubic-bezier(0.03, 0.98, 0.52, 0.99)`
  }, [perspective, speed])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.willChange = 'transform'
    el.addEventListener('mousemove', handleMouseMove, { passive: true })
    el.addEventListener('mouseleave', handleMouseLeave)
    return () => {
      el.removeEventListener('mousemove', handleMouseMove)
      el.removeEventListener('mouseleave', handleMouseLeave)
    }
  }, [handleMouseMove, handleMouseLeave])

  return ref
}
