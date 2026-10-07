import { motion } from 'framer-motion'
import { Circle, Plus } from 'lucide-react'
import { Section } from './ui'

// Radial Gradient.

export default function RadialGradientSection({ handleAddRadialLayer }) {
    // Uncompiled, like the panel it was cut from: it reads live Fabric objects in render.
    'use no memo'
    return (
        <Section title="Radial Gradient" icon={Circle}>
            <div className="space-y-3">
                <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                    Drag a bounding box on the canvas to define the ellipse.
                    Rotate it afterwards with the green handle.
                </p>
                <motion.button
                    type="button"
                    onClick={handleAddRadialLayer}
                    whileTap={{ scale: 0.97 }}
                    className="flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2 text-xs font-medium editor-interactive"
                    style={{
                        background: 'rgba(124,58,237,0.08)',
                        border: '1px solid rgba(124,58,237,0.25)',
                        color: '#A78BFA',
                    }}
                    title="Adds a radial megashader layer — drag on canvas to set the bounding box"
                >
                    <Plus className="h-3.5 w-3.5" />
                    Add Radial to Mask Layers

                </motion.button>
            </div>
        </Section>
    )
}
