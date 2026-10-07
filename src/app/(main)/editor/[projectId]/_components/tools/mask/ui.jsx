import { useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ArrowDown, ArrowDownLeft, ArrowDownRight, ArrowLeft, ArrowRight, ArrowUp, ArrowUpLeft, ArrowUpRight, ChevronRight } from 'lucide-react'

/* ─── collapsible section ─── */
export const Section = ({ title, icon: Icon, defaultOpen = false, children, badge }) => {
    const [open, setOpen] = useState(defaultOpen)
    return (
        <div className={`mask-section ${open ? 'mask-section--open' : ''}`}>
            <button
                type="button"
                onClick={() => setOpen(v => !v)}
                aria-expanded={open}
                className="mask-section__header"
            >
                {Icon && <Icon className="mask-section__icon" />}
                <span className="mask-section__title">{title}</span>
                {badge && (
                    <span className="mask-section__badge">{badge}</span>
                )}
                <ChevronRight className="mask-section__chevron" />
            </button>
            <AnimatePresence initial={false}>
                {open && (
                    <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
                        className="overflow-hidden"
                    >
                        <div className="mask-section__body space-y-3">
                            {children}
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    )
}

/* ─── category divider between section groups ─── */
export const CategoryHeader = ({ label }) => (
    <div className="mask-category-header">
        <span>{label}</span>
    </div>
)

/* ─── gradient direction icons ─── */
export const DIRECTIONS = [
    { id: 'top', icon: ArrowUp, label: 'Top → Bottom' },
    { id: 'bottom', icon: ArrowDown, label: 'Bottom → Top' },
    { id: 'left', icon: ArrowLeft, label: 'Left → Right' },
    { id: 'right', icon: ArrowRight, label: 'Right → Left' },
    { id: 'top-left', icon: ArrowUpLeft, label: 'Top-Left' },
    { id: 'top-right', icon: ArrowUpRight, label: 'Top-Right' },
    { id: 'bottom-left', icon: ArrowDownLeft, label: 'Bottom-Left' },
    { id: 'bottom-right', icon: ArrowDownRight, label: 'Bottom-Right' },
]

/* ─── color swatch component ─── */
export const ColorSwatch = ({ color, size = 24 }) => {
    if (!color) return null
    return (
        <div
            className="rounded border shrink-0"
            style={{
                width: size, height: size,
                background: `rgb(${color.r}, ${color.g}, ${color.b})`,
                borderColor: 'var(--border-subtle)',
            }}
        />
    )
}
