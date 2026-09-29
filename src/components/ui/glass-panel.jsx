"use client"

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
            <div className={cn('fade-up-in', baseStyles)} {...props}>
                {children}
            </div>
        )
    }

    return (
        <div className={baseStyles} {...props}>
            {children}
        </div>
    )
}

export default GlassPanel
