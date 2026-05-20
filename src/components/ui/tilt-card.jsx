"use client"

import React from 'react'
import { useTilt } from '@/hooks/useTilt'

export function TiltCard({
  children,
  className = '',
  maxTilt = 10,
  perspective = 800,
  scale = 1.02,
  glare = true,
  glareOpacity = 0.08,
}) {
  const ref = useTilt({ maxTilt, perspective, scale, glare, glareOpacity, glareClassName: 'tilt-glare' })

  return (
    <div ref={ref} className={`relative overflow-hidden ${className}`}>
      {glare && (
        <div className="tilt-glare absolute inset-0 pointer-events-none rounded-2xl" />
      )}
      {children}
    </div>
  )
}
