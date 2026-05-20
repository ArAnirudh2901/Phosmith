"use client"

import React from 'react'
import { motion } from 'framer-motion'
import { TiltCard } from '@/components/ui/tilt-card'
import GlassPanel from '@/components/ui/glass-panel'
import { Clock, Zap, Wand2, Layers, Palette, Maximize2, Sparkles, Eye, Award } from 'lucide-react'

const FEATURES = [
    {
        icon: Maximize2,
        title: 'Generative Expand',
        description: 'Drag handles to expand image boundaries. AI fills the void with photorealistic content that matches lighting, perspective, and texture seamlessly.',
    },
    {
        icon: Palette,
        title: 'AI Background Removal',
        description: 'Remove backgrounds with pixel-perfect precision. Replace with solid colors, Unsplash images, or AI-generated scenes.',
    },
    {
        icon: Wand2,
        title: 'AI Image Generation',
        description: 'Describe any background or scene and watch it materialize in seconds. Powered by state-of-the-art diffusion models.',
    },
    {
        icon: Layers,
        title: 'Layered Editing',
        description: 'Full layer control with text, shapes, and multiple images. Non-destructive editing with unlimited undo/redo history.',
    },
    {
        icon: Eye,
        title: 'Real-Time Adjustments',
        description: 'Fine-tune brightness, contrast, saturation, vibrance, blur, and hue with instant live previews on every change.',
    },
    {
        icon: Zap,
        title: 'Keyboard-First Workflow',
        description: 'Full keyboard shortcut architecture. V for move, G for generative fill, Ctrl+Z for undo — everything at your fingertips.',
    },
]

const containerVariants = {
    hidden: { opacity: 0 },
    visible: {
        opacity: 1,
        transition: {
            staggerChildren: 0.08,
        },
    },
}

const itemVariants = {
    hidden: { opacity: 0, y: 40 },
    visible: {
        opacity: 1,
        y: 0,
        transition: {
            duration: 0.7,
            ease: [0.22, 1, 0.36, 1],
        },
    },
}

const HeroFeatures = () => {
    return (
        <section id="features" className="relative py-24 md:py-32 overflow-hidden">
            <div className="max-w-7xl mx-auto px-6 relative z-10">
                <motion.div
                    className="text-center mb-16"
                    initial={{ opacity: 0, y: 30 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true, margin: "-100px" }}
                    transition={{ duration: 0.8, delay: 0.1, ease: [0.22, 1, 0.36, 1] }}
                >
                    <div className="glass-chip px-4 py-1.5 text-xs font-semibold mb-6"
                        style={{
                            color: 'var(--accent-ink)',
                        }}>
                        <Sparkles className="h-3 w-3" />
                        Features
                    </div>
                    <h2 className="text-4xl md:text-5xl lg:text-6xl font-display font-bold text-white mb-5 tracking-tight leading-tight">
                        Everything you need,<br />
                        <span
                            className="text-transparent bg-clip-text"
                            style={{ backgroundImage: 'linear-gradient(135deg, #F4E8D8, #FFFFFF, #A8B0B6)' }}
                        >
                            wrapped in fluid glass
                        </span>
                    </h2>
                    <p className="text-lg text-[var(--text-secondary)] max-w-2xl mx-auto leading-relaxed">
                        Professional-grade tools wrapped in an ink-inspired, glass-morphism interface built for focus, speed, and quiet precision.
                    </p>
                </motion.div>

                <motion.div
                    className="grid md:grid-cols-2 lg:grid-cols-3 gap-5"
                    initial="hidden"
                    whileInView="visible"
                    viewport={{ once: true, margin: "-80px" }}
                    variants={containerVariants}
                >
                    {FEATURES.map((feature) => {
                        const Icon = feature.icon
                        return (
                            <motion.div key={feature.title} variants={itemVariants}>
                                <TiltCard maxTilt={4} perspective={700} scale={1.005} glare glareOpacity={0.025}>
                                    <GlassPanel className="!p-7 h-full group glass-interactive" glowOnHover>
                                        <motion.div
                                            className="glass-icon-surface w-12 h-12 rounded-2xl flex items-center justify-center mb-5 relative"
                                            style={{
                                                background: 'linear-gradient(135deg, rgba(255,255,255,0.08), rgba(255,255,255,0.025))',
                                                border: '1px solid rgba(255,255,255,0.12)',
                                                boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.12)',
                                            }}
                                            whileHover={{ scale: 1.04, y: -2 }}
                                            transition={{ type: 'spring', stiffness: 380, damping: 24 }}
                                        >
                                            {/* Glow behind icon */}
                                            <div className="absolute inset-0 rounded-2xl opacity-0 group-hover:opacity-100 transition-opacity duration-500"
                                                style={{ background: 'radial-gradient(circle, rgba(255,255,255,0.12), transparent 68%)', filter: 'blur(12px)' }} />
                                            <Icon className="h-5 w-5 relative z-10" style={{ color: 'var(--text-primary)' }} />
                                        </motion.div>
                                        <h3 className="text-base font-semibold mb-2.5 text-white group-hover:text-accent-ink transition-colors">
                                            {feature.title}
                                        </h3>
                                        <p className="text-sm leading-relaxed text-[var(--text-secondary)]">{feature.description}</p>
                                        {/* Shimmer line at bottom */}
                                        <div className="absolute bottom-0 left-4 right-4 h-px bg-gradient-to-r from-transparent via-white/20 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500" />
                                    </GlassPanel>
                                </TiltCard>
                            </motion.div>
                        )
                    })}
                </motion.div>

                {/* Stats row */}
                <div className="mt-16 grid grid-cols-2 md:grid-cols-4 gap-6">
                    {[
                        { value: '10K+', label: 'Active Users', icon: Award },
                        { value: '50M+', label: 'Images Processed', icon: Layers },
                        { value: '200+', label: 'AI Models', icon: Zap },
                        { value: '<1ms', label: 'Inference Speed', icon: Clock },
                    ].map((stat, i) => (
                        <motion.div
                            key={stat.label}
                            className="transmission-glass text-center p-6 rounded-2xl"
                            initial={{ opacity: 0, y: 20 }}
                            whileInView={{ opacity: 1, y: 0 }}
                            viewport={{ once: true }}
                            transition={{ delay: 0.3 + i * 0.1, duration: 0.6 }}
                        >
                            <stat.icon className="h-5 w-5 mx-auto mb-2" style={{ color: 'var(--accent-ink)' }} />
                            <div className="text-2xl font-bold text-white">{stat.value}</div>
                            <div className="text-xs text-[var(--text-muted)] mt-1">{stat.label}</div>
                        </motion.div>
                    ))}
                </div>
            </div>
        </section>
    )
}

export default HeroFeatures
