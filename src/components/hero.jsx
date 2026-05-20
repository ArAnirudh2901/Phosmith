"use client"

import { motion } from "framer-motion"
import { ArrowRight, Sparkles, Droplet } from "lucide-react"
import { TiltCard } from "@/components/ui/tilt-card"
import { useDashboardNavigation } from "@/hooks/useDashboardNavigation"

/*
 * ─── Floating Orbs (2D CSS layer) ──────────────────
 * Lightweight atmospheric orbs for depth behind the hero copy
 */
const FloatingOrb = ({ style, delay = 0 }) => (
  <motion.div
    className="absolute rounded-full blur-3xl pointer-events-none"
    style={style}
    initial={{ opacity: 0, scale: 0 }}
    animate={{ opacity: 1, scale: 1 }}
    transition={{
      duration: 1.4,
      ease: "easeInOut",
      delay,
    }}
  />
)

const HeroSection = () => {
  const { navigateToDashboard, isNavigatingToDashboard } = useDashboardNavigation()

  return (
    <section
      className="relative min-h-[100svh] flex flex-col items-center px-6 pt-32 pb-16 text-center overflow-hidden sm:pt-36 lg:pt-36"
      style={{
        background:
          "linear-gradient(180deg, rgba(7,9,14,0.34) 0%, rgba(7,9,14,0.18) 38%, rgba(7,9,14,0.62) 100%)",
      }}
    >
      {/* CSS animated background orbs */}
      <div className="absolute inset-0 pointer-events-none overflow-hidden">
        <FloatingOrb style={{ width: 500, height: 500, left: "-10%", top: "-10%", background: "radial-gradient(circle, rgba(255,255,255,0.04), transparent 70%)" }} delay={0} />
        <FloatingOrb style={{ width: 400, height: 400, right: "-5%", bottom: "10%", background: "radial-gradient(circle, rgba(255,255,255,0.03), transparent 70%)" }} delay={2} />
        <FloatingOrb style={{ width: 300, height: 300, left: "30%", top: "60%", background: "radial-gradient(circle, rgba(255,255,255,0.025), transparent 70%)" }} delay={4} />
        <FloatingOrb style={{ width: 350, height: 350, right: "20%", top: "30%", background: "radial-gradient(circle, rgba(255,255,255,0.02), transparent 70%)" }} delay={1} />
      </div>

      <div className="relative z-10 w-full max-w-5xl px-4 text-center">
        {/* Badge */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.15, duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
          className="glass-chip px-4 py-1.5 text-xs font-medium mb-6"
          style={{
            color: "var(--accent-ink)",
          }}
        >
          <Droplet className="h-3 w-3" />
          AI-Powered Image Studio
          <div>
            <Sparkles className="h-3 w-3" />
          </div>
        </motion.div>

        {/* Headline with 3D text feel */}
        <div className="mb-5">
          <motion.h1
            initial={{ opacity: 0, y: 40, rotateX: 30 }}
            animate={{ opacity: 1, y: 0, rotateX: 0 }}
            transition={{ delay: 0.25, duration: 1.0, ease: [0.22, 1, 0.36, 1] }}
            className="text-5xl sm:text-6xl md:text-7xl lg:text-8xl font-display font-bold leading-[1.04] tracking-tight mb-4"
            style={{ perspective: "1200px" }}
          >
            <span className="text-text-primary block">Edit with</span>
            <span
              className="text-transparent bg-clip-text block mt-2"
              style={{
                backgroundImage: "linear-gradient(90deg, #4A90E2 0%, #50C878 25%, #FF6B6B 50%, #FFD93D 75%, #9B59B6 100%)",
                backgroundSize: "400% 100%",
                animation: "gradient-shift 12s ease-in-out infinite",
              }}
            >
              Ink & Light
            </span>
          </motion.h1>
          <style>{`
            @keyframes gradient-shift {
              0% { background-position: 0% 50%; }
              25% { background-position: 25% 50%; }
              50% { background-position: 50% 50%; }
              75% { background-position: 75% 50%; }
              100% { background-position: 100% 50%; }
            }
          `}</style>
        </div>

        {/* Subtitle */}
        <div>
          <motion.p
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.5, duration: 0.7 }}
            className="text-lg md:text-xl text-[var(--text-secondary)] max-w-2xl mx-auto mb-8 leading-relaxed"
          >
            Where deep ink tones meet luminous gold. Transform your images with WebGL-powered
            <span className="text-accent-ink"> fluid physics</span>, AI-driven editing, and
            <span className="text-accent-warm-gold"> glass-morphic precision</span>.
          </motion.p>
        </div>

        {/* CTAs */}
        <div>
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.7, duration: 0.7 }}
            className="flex flex-col sm:flex-row items-center justify-center gap-4 mb-12"
          >
            <motion.button
              type="button"
              onClick={navigateToDashboard}
              disabled={isNavigatingToDashboard}
              whileTap={{ scale: 0.98 }}
              className="glass-action glass-action-primary group relative flex items-center gap-2 px-10 py-4 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-80"
              style={{
                color: "#EDE6DC",
              }}
            >
              <span className="relative z-10 flex items-center gap-2">
                {isNavigatingToDashboard ? "Opening Studio..." : "Enter the Studio"}
                <ArrowRight className="h-4 w-4 group-hover:translate-x-1 transition-transform" />
              </span>
            </motion.button>

            <motion.a
              href="#features"
              whileTap={{ scale: 0.98 }}
              className="glass-action inline-flex items-center justify-center px-10 py-4 text-sm font-semibold"
              style={{
                color: "var(--text-primary)",
              }}
            >
              Explore Features
            </motion.a>
          </motion.div>
        </div>

        {/* Interactive preview card */}
        <div>
          <motion.div
            initial={{ opacity: 0, y: 50 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.95, duration: 0.9, ease: [0.22, 1, 0.36, 1] }}
            className="max-w-3xl mx-auto"
          >
            <TiltCard maxTilt={4} perspective={700} scale={1.005} glare glareOpacity={0.035}>
              <div className="transmission-glass glass-interactive relative p-2 rounded-2xl">
                {/* Toolbar mock */}
                <div className="flex items-center gap-1.5 mb-3 px-2 pt-1">
                  <div className="w-2.5 h-2.5 rounded-full bg-white/35 border border-white/20" />
                  <div className="w-2.5 h-2.5 rounded-full bg-white/25 border border-white/15" />
                  <div className="w-2.5 h-2.5 rounded-full bg-white/15 border border-white/10" />
                  <span className="text-[9px] text-[var(--text-muted)] ml-2 uppercase tracking-wider">Pixxel Studio — Editor Preview</span>
                </div>

                {/* Canvas mock with animated gradient */}
                <div className="relative h-44 rounded-xl overflow-hidden">
                  <div
                    className="absolute inset-0 transition-all duration-1000 ease-in-out"
                    style={{
                      background: `
                        radial-gradient(ellipse at 30% 40%, rgba(255,255,255,0.10) 0%, transparent 50%),
                        radial-gradient(ellipse at 70% 60%, rgba(255,255,255,0.065) 0%, transparent 50%),
                        radial-gradient(ellipse at 50% 50%, rgba(255,255,255,0.04) 0%, transparent 70%),
                        #0A0E14
                      `,
                    }}
                  >
                    {/* Animated ink drops on canvas */}
                    <div
                      className="absolute w-20 h-20 rounded-full opacity-40 blur-xl"
                      style={{
                        background: "radial-gradient(circle, rgba(255,255,255,0.18), transparent)",
                        top: "30%",
                        left: "40%",
                        animation: "float 6s ease-in-out infinite",
                      }}
                    />
                    <div
                      className="absolute w-16 h-16 rounded-full opacity-30 blur-xl"
                      style={{
                        background: "radial-gradient(circle, rgba(255,255,255,0.14), transparent)",
                        bottom: "30%",
                        right: "35%",
                        animation: "float 8s ease-in-out infinite 2s",
                      }}
                    />
                    <div className="absolute inset-0 flex items-center justify-center">
                      <p
                        className="text-sm font-medium tracking-wider"
                        style={{ color: "var(--text-muted)" }}
                      >
                        Your Canvas — Ready for Creation
                      </p>
                    </div>
                  </div>
                </div>

                {/* Tool indicators */}
                <div className="grid grid-cols-4 gap-2 mt-4">
                  {[
                    { icon: "✂️", label: "Crop" },
                    { icon: "📐", label: "Resize" },
                    { icon: "🎨", label: "Adjust" },
                    { icon: "✨", label: "AI Tools" },
                  ].map((tool) => (
                    <motion.div
                      key={tool.label}
                      whileHover={{ y: -2 }}
                      whileTap={{ scale: 0.98 }}
                      className="glass-icon-surface flex flex-col items-center gap-1.5 p-2.5 rounded-xl cursor-pointer relative group"
                    >
                      <span className="text-lg">{tool.icon}</span>
                      <span
                        className="text-[9px] font-medium uppercase tracking-wider"
                        style={{ color: "var(--text-secondary)" }}
                      >
                        {tool.label}
                      </span>
                      <div
                        className="absolute -inset-px rounded-xl opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none"
                        style={{
                          background: "linear-gradient(135deg, rgba(255,255,255,0.08), transparent)",
                          border: "1px solid rgba(255,255,255,0.12)",
                        }}
                      />
                    </motion.div>
                  ))}
                </div>
              </div>
            </TiltCard>
          </motion.div>
        </div>
      </div>

      {/* Scroll indicator */}
      <motion.div
        className="absolute bottom-8 left-1/2 -translate-x-1/2 flex flex-col items-center gap-2"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 1.5 }}
      >
        <motion.div
          animate={{ y: [0, 8, 0] }}
          transition={{ duration: 1.5, repeat: Infinity }}
          className="w-5 h-8 rounded-full border-2 border-[var(--text-muted)] flex justify-center pt-1"
        >
          <motion.div
            animate={{ y: [0, 6, 0], opacity: [0.3, 1, 0.3] }}
            transition={{ duration: 1.5, repeat: Infinity }}
            className="w-1 h-1.5 rounded-full bg-[var(--text-muted)]"
          />
        </motion.div>
        <span className="text-[10px] text-[var(--text-muted)] uppercase tracking-wider">Scroll</span>
      </motion.div>
    </section>
  )
}

export default HeroSection
