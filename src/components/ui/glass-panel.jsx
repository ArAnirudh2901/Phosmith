"use client"

import { motion } from 'framer-motion'
import { cn } from '@/lib/utils'

const GlassPanel = ({
    children,
    className,
    variant = 'default',
    animated = false,
    noPadding = false,
    glowOnHover = false,
    tilt: _tilt,
    tiltOptions: _tiltOptions,
    ...props
}) => {
    const baseStyles = cn(
        'glass-panel relative',
        !noPadding && 'p-5',
        className
    )

    if (animated) {
        return (
            <motion.div
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
                className={baseStyles}
                {...props}
            >
                {children}
            </motion.div>
        )
    }

    return (
        <div className={baseStyles} {...props}>
            {children}
        </div>
    )
}

export default GlassPanel
