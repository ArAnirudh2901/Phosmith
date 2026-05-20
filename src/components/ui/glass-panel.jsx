"use client"

import { motion } from 'framer-motion'
import { cn } from '@/lib/utils'
import { useTilt } from '@/hooks/useTilt'

/*
 * ─── Enhanced Glass Panel ──────────────────────────
 * Multi-layered glassmorphism with inner glow,
 * border shimmer, and spatial depth.
 */

const GlassPanel = ({
  children,
  className,
  variant = 'default',
  animated = false,
  noPadding = false,
  glowOnHover = false,
  tilt = false,
  tiltOptions = {},
  ...props
}) => {
  const tiltRef = useTilt({ ...tiltOptions, glareClassName: tiltOptions.glareClassName || 'dtilt-glare' })

  const baseStyles = cn(
    'rounded-2xl border relative',
    variant === 'heavy' ? 'bg-[var(--glass-bg-heavy)]' : 'bg-[var(--glass-bg)]',
    'backdrop-blur-2xl backdrop-saturate-160',
    'border-[var(--glass-border)]',
    'shadow-[var(--shadow-md)]',
    'before:absolute before:inset-0 before:rounded-2xl before:bg-gradient-to-b before:from-white/[0.04] before:to-transparent before:pointer-events-none',
    'after:absolute after:inset-0 after:rounded-2xl after:bg-gradient-to-tr after:from-[var(--accent-ink)]/[0.03] after:to-transparent after:pointer-events-none',
    !noPadding && 'p-5',
    glowOnHover && 'hover:border-[var(--accent-ink)]/30 hover:shadow-[var(--shadow-glow)]',
    'transition-all duration-300 ease-out',
    className
  )

  const tiltGlare = tilt && (
    <div className="dtilt-glare absolute inset-0 pointer-events-none rounded-2xl" />
  )

  if (tilt) {
    return (
      <div ref={tiltRef} className={cn('relative overflow-hidden', animated && 'motion-div')}>
        {tiltGlare}
        {animated ? (
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: -4 }}
            transition={{ type: 'spring', stiffness: 400, damping: 25, mass: 0.8 }}
            className={baseStyles}
            {...props}
          >
            {children}
          </motion.div>
        ) : (
          <div className={cn(baseStyles, 'relative')} {...props}>
            {children}
          </div>
        )}
      </div>
    )
  }

  if (animated) {
    return (
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: -4 }}
        transition={{ type: 'spring', stiffness: 400, damping: 25, mass: 0.8 }}
        className={baseStyles}
        {...props}
      >
        {children}
      </motion.div>
    )
  }

  return (
    <div className={cn(baseStyles, 'relative overflow-hidden')} {...props}>
      {children}
    </div>
  )
}

export default GlassPanel
