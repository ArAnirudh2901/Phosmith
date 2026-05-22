"use client"

import React from 'react'
import { motion } from 'framer-motion'
import GlassPanel from '@/components/ui/glass-panel'
import { Clock, Zap, Wand2, Layers, Palette, Maximize2, Sparkles, Eye, Award } from 'lucide-react'
import {
  fadeUp,
  staggerContainer,
  staggerItem,
  viewport,
  useReducedMotion,
  motionVariants,
  whileInViewProps,
} from '@/lib/motion'

const FEATURES = [
  {
    icon: Maximize2,
    title: 'AI Extender',
    description: 'Drag edge handles to expand image boundaries. AI fills the void with photorealistic content that matches lighting, perspective, and texture seamlessly.',
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
    description: 'Full keyboard shortcut architecture. V for move, G for AI extender, Ctrl+Z for undo — everything at your fingertips.',
  },
]

const STATS = [
  { value: '10K+', label: 'Active Users', icon: Award },
  { value: '50M+', label: 'Images Processed', icon: Layers },
  { value: '200+', label: 'AI Models', icon: Zap },
  { value: '<1ms', label: 'Inference Speed', icon: Clock },
]

const HeroFeatures = () => {
  const reduced = useReducedMotion()
  const headerMotion = whileInViewProps(reduced)
  const container = motionVariants(staggerContainer, reduced)
  const item = motionVariants(staggerItem, reduced)
  const fade = motionVariants(fadeUp, reduced)

  return (
    <section id="features" className="relative py-24 md:py-32 overflow-hidden">
      <div className="max-w-7xl mx-auto px-6 relative z-10">
        <motion.div
          className="text-center mb-16"
          variants={fade}
          {...headerMotion}
        >
          <div
            className="glass-chip px-4 py-1.5 text-xs font-semibold mb-6 inline-flex items-center gap-2"
            style={{ color: 'var(--accent-ink)' }}
          >
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
          variants={container}
          initial="hidden"
          whileInView="visible"
          viewport={viewport}
        >
          {FEATURES.map((feature) => {
            const Icon = feature.icon
            return (
              <motion.div key={feature.title} variants={item}>
                <GlassPanel className="!p-7 h-full group glass-interactive" glowOnHover>
                  <div
                    className="glass-icon-surface w-12 h-12 rounded-2xl flex items-center justify-center mb-5"
                    style={{
                      background: 'linear-gradient(135deg, rgba(255,255,255,0.08), rgba(255,255,255,0.025))',
                      border: '1px solid rgba(255,255,255,0.12)',
                      boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.12)',
                    }}
                  >
                    <Icon className="h-5 w-5" style={{ color: 'var(--text-primary)' }} />
                  </div>
                  <h3 className="text-base font-semibold mb-2.5 text-white group-hover:text-accent-ink transition-colors duration-200">
                    {feature.title}
                  </h3>
                  <p className="text-sm leading-relaxed text-[var(--text-secondary)]">{feature.description}</p>
                </GlassPanel>
              </motion.div>
            )
          })}
        </motion.div>

        <motion.div
          className="mt-16 grid grid-cols-2 md:grid-cols-4 gap-6"
          variants={container}
          initial="hidden"
          whileInView="visible"
          viewport={viewport}
        >
          {STATS.map((stat) => (
            <motion.div
              key={stat.label}
              className="transmission-glass text-center p-6 rounded-2xl"
              variants={item}
            >
              <stat.icon className="h-5 w-5 mx-auto mb-2" style={{ color: 'var(--accent-ink)' }} />
              <div className="text-2xl font-bold text-white">{stat.value}</div>
              <div className="text-xs text-[var(--text-muted)] mt-1">{stat.label}</div>
            </motion.div>
          ))}
        </motion.div>
      </div>
    </section>
  )
}

export default HeroFeatures
