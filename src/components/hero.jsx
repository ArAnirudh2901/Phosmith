"use client"

import { motion } from "framer-motion"
import { ArrowRight, Sparkles, Droplet } from "lucide-react"
import { useDashboardNavigation } from "@/hooks/useDashboardNavigation"
import {
  staggerContainer,
  staggerItem,
  useReducedMotion,
  motionVariants,
} from "@/lib/motion"

const HeroSection = () => {
  const { navigateToDashboard, isNavigatingToDashboard } = useDashboardNavigation()
  const reduced = useReducedMotion()
  const container = motionVariants(staggerContainer, reduced)
  const item = motionVariants(staggerItem, reduced)

  return (
    <section
      className="relative min-h-[100svh] flex flex-col items-center px-6 pt-32 pb-16 text-center overflow-hidden sm:pt-36 lg:pt-36"
      style={{
        background:
          "linear-gradient(180deg, rgba(7,9,14,0.34) 0%, rgba(7,9,14,0.18) 38%, rgba(7,9,14,0.62) 100%)",
      }}
    >
      <div className="absolute inset-0 pointer-events-none overflow-hidden" aria-hidden="true">
        <div
          className="absolute rounded-full blur-3xl opacity-40"
          style={{
            width: 500,
            height: 500,
            left: "-10%",
            top: "-10%",
            background: "radial-gradient(circle, rgba(255,255,255,0.04), transparent 70%)",
          }}
        />
        <div
          className="absolute rounded-full blur-3xl opacity-30"
          style={{
            width: 400,
            height: 400,
            right: "-5%",
            bottom: "10%",
            background: "radial-gradient(circle, rgba(255,255,255,0.03), transparent 70%)",
          }}
        />
      </div>

      <motion.div
        className="relative z-10 w-full max-w-5xl px-4 text-center"
        variants={container}
        initial="hidden"
        animate="visible"
      >
        <motion.div
          variants={item}
          className="glass-chip px-4 py-1.5 text-xs font-medium mb-6 inline-flex items-center gap-2"
          style={{ color: "var(--accent-ink)" }}
        >
          <Droplet className="h-3 w-3" />
          AI-Powered Image Studio
          <Sparkles className="h-3 w-3" />
        </motion.div>

        <motion.h1
          variants={item}
          className="text-5xl sm:text-6xl md:text-7xl lg:text-8xl font-display font-bold leading-[1.04] tracking-tight mb-4"
        >
          <span className="text-text-primary block">Edit with</span>
          <span
            className="text-transparent bg-clip-text block mt-2"
            style={{
              backgroundImage:
                "linear-gradient(90deg, #66B3FF 0%, #66E699 25%, #FF8080 50%, #FFE666 75%, #CC80FF 100%)",
            }}
          >
            Ink & Light
          </span>
        </motion.h1>

        <motion.p
          variants={item}
          className="text-lg md:text-xl text-[var(--text-secondary)] max-w-2xl mx-auto mb-8 leading-relaxed"
        >
          Where deep ink tones meet luminous gold. Transform your images with WebGL-powered
          <span className="text-accent-ink"> fluid physics</span>, AI-driven editing, and
          <span className="text-accent-warm-gold"> glass-morphic precision</span>.
        </motion.p>

        <motion.div
          variants={item}
          className="flex flex-col sm:flex-row items-center justify-center gap-4 mb-12"
        >
          <button
            type="button"
            onClick={navigateToDashboard}
            disabled={isNavigatingToDashboard}
            className="glass-action glass-action-primary group relative flex items-center gap-2 px-10 py-4 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-80"
            style={{ color: "#EDE6DC" }}
          >
            <span className="relative z-10 flex items-center gap-2">
              {isNavigatingToDashboard ? "Opening Studio..." : "Enter the Studio"}
              <ArrowRight className="h-4 w-4 transition-transform duration-200 group-hover:translate-x-0.5" />
            </span>
          </button>

          <a
            href="#features"
            className="glass-action inline-flex items-center justify-center px-10 py-4 text-sm font-semibold"
            style={{ color: "var(--text-primary)" }}
          >
            Explore Features
          </a>
        </motion.div>

        <motion.div variants={item} className="max-w-3xl mx-auto">
          <div className="transmission-glass glass-interactive relative p-2 rounded-2xl">
            <div className="flex items-center gap-1.5 mb-3 px-2 pt-1">
              <div className="w-2.5 h-2.5 rounded-full bg-white/35 border border-white/20" />
              <div className="w-2.5 h-2.5 rounded-full bg-white/25 border border-white/15" />
              <div className="w-2.5 h-2.5 rounded-full bg-white/15 border border-white/10" />
              <span className="text-[9px] text-[var(--text-muted)] ml-2 uppercase tracking-wider">
                Pixxel Studio — Editor Preview
              </span>
            </div>

            <div className="relative h-44 rounded-xl overflow-hidden">
              <div
                className="absolute inset-0"
                style={{
                  background: `
                    radial-gradient(ellipse at 30% 40%, rgba(255,255,255,0.10) 0%, transparent 50%),
                    radial-gradient(ellipse at 70% 60%, rgba(255,255,255,0.065) 0%, transparent 50%),
                    #0A0E14
                  `,
                }}
              >
                <div className="absolute inset-0 flex items-center justify-center">
                  <p className="text-sm font-medium tracking-wider" style={{ color: "var(--text-muted)" }}>
                    Your Canvas — Ready for Creation
                  </p>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-4 gap-2 mt-4">
              {[
                { icon: "✂️", label: "Crop" },
                { icon: "📐", label: "Resize" },
                { icon: "🎨", label: "Adjust" },
                { icon: "✨", label: "AI Tools" },
              ].map((tool) => (
                <div
                  key={tool.label}
                  className="glass-icon-surface flex flex-col items-center gap-1.5 p-2.5 rounded-xl"
                >
                  <span className="text-lg">{tool.icon}</span>
                  <span
                    className="text-[9px] font-medium uppercase tracking-wider"
                    style={{ color: "var(--text-secondary)" }}
                  >
                    {tool.label}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </motion.div>
      </motion.div>
    </section>
  )
}

export default HeroSection
