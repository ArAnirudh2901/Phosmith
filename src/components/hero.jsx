"use client"

import { motion } from "framer-motion"
import { ArrowRight, Bot, Maximize2, ImagePlus, Sparkles } from "lucide-react"
import { useDashboardNavigation } from "@/hooks/useDashboardNavigation"
import { staggerContainer, staggerItem, useReducedMotion, motionVariants } from "@/lib/motion"
import NeoButton from "@/components/neo/NeoButton"
import ScrambleText from "@/components/neo/ScrambleText"

const TOOL_CHIPS = [
    { icon: Maximize2, label: "AI Extend" },
    { icon: Sparkles, label: "Upscale" },
    { icon: Bot, label: "Chat Edits" },
    { icon: ImagePlus, label: "Multi-Image" },
]

const HeroSection = () => {
    const { navigateToDashboard, isNavigatingToDashboard } = useDashboardNavigation()
    const reduced = useReducedMotion()
    const container = motionVariants(staggerContainer, reduced)
    const item = motionVariants(staggerItem, reduced)

    return (
        <section
            className="relative min-h-[100svh] flex flex-col items-center px-6 pt-32 pb-20 text-center overflow-hidden sm:pt-36"
            style={{
                background: "#07090E",
                backgroundImage:
                    "radial-gradient(rgba(244,244,245,0.06) 1px, transparent 1px)",
                backgroundSize: "28px 28px",
            }}
        >
            <div
                className="pointer-events-none absolute inset-0"
                aria-hidden="true"
                style={{
                    background:
                        "radial-gradient(ellipse 80% 60% at 50% 0%, rgba(6,184,212,0.08), transparent 60%)",
                }}
            />

            <motion.div
                className="relative z-10 w-full max-w-6xl"
                variants={container}
                initial="hidden"
                animate="visible"
            >
                <motion.div variants={item} className="mb-8 inline-flex">
                    <div
                        style={{
                            background: "linear-gradient(135deg, rgba(255,255,255,0.10), rgba(255,255,255,0.02) 60%), rgba(14,17,24,0.55)",
                            backdropFilter: "blur(16px) saturate(170%)",
                            WebkitBackdropFilter: "blur(16px) saturate(170%)",
                            border: "2px solid #F4F4F5",
                            boxShadow: "4px 4px 0 0 #06B8D4, inset 0 1px 0 rgba(255,255,255,0.22), inset 0 0 0 1px rgba(255,255,255,0.06)",
                            padding: "8px 16px",
                            fontFamily: 'var(--font-mono, ui-monospace, "SF Mono", Menlo, monospace)',
                            fontSize: 11,
                            fontWeight: 700,
                            letterSpacing: "0.16em",
                            textTransform: "uppercase",
                            color: "#F4F4F5",
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 10,
                        }}
                    >
                        <span
                            style={{
                                width: 8,
                                height: 8,
                                background: "#06B8D4",
                                display: "inline-block",
                                boxShadow: "0 0 10px rgba(6,184,212,0.65)",
                            }}
                        />
                        v1 · AI Photo Studio
                    </div>
                </motion.div>

                <motion.h1
                    variants={item}
                    className="font-bold leading-[0.95] tracking-tight mb-6"
                    style={{
                        fontSize: "clamp(48px, 10vw, 128px)",
                        textTransform: "uppercase",
                        letterSpacing: "-0.02em",
                    }}
                >
                    <ScrambleText
                        as="span"
                        text="SHAPE LIGHT"
                        durationMs={700}
                        className="liquid-reactive-text"
                        style={{ display: "block" }}
                    />
                    <ScrambleText
                        as="span"
                        text="FORGE PHOTOS"
                        durationMs={900}
                        delay={250}
                        className="liquid-reactive-text-stroke"
                        style={{ display: "block" }}
                    />
                </motion.h1>

                <motion.p
                    variants={item}
                    className="mx-auto mb-10 max-w-2xl text-lg md:text-xl leading-relaxed"
                    style={{ color: "#A1A8B4" }}
                >
                    {(
                        "Phosmith is a browser-native photo editor with a built-in AI agent. Upscale, extend, retouch, mask, and recompose images using a Photoshop-class canvas — or just describe the edit and let the agent do it."
                    )
                        .split(" ")
                        .map((word, idx) => (
                            <motion.span
                                key={`${word}-${idx}`}
                                initial={{ opacity: 0, y: 8 }}
                                animate={{ opacity: 1, y: 0 }}
                                transition={{ delay: 0.45 + idx * 0.018, duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
                                style={{ display: "inline-block", marginRight: 6 }}
                            >
                                {word}
                            </motion.span>
                        ))}
                </motion.p>

                <motion.div variants={item} className="flex flex-col sm:flex-row items-center justify-center gap-5 mb-14">
                    <NeoButton
                        variant="primary"
                        size="xl"
                        onClick={navigateToDashboard}
                        disabled={isNavigatingToDashboard}
                    >
                        {isNavigatingToDashboard ? "Opening Studio" : "Open Studio"}
                        <ArrowRight className="h-4 w-4" strokeWidth={2.5} />
                    </NeoButton>
                    <NeoButton variant="secondary" size="xl" href="#features">
                        See the tools
                    </NeoButton>
                </motion.div>

                <motion.div variants={item} className="flex flex-wrap items-center justify-center gap-3">
                    {TOOL_CHIPS.map(({ icon: Icon, label }) => (
                        <motion.div
                            key={label}
                            whileHover={{
                                y: -3,
                                boxShadow:
                                    "5px 8px 0 0 #06B8D4, inset 0 1px 0 rgba(255,255,255,0.22), inset 0 0 0 1px rgba(255,255,255,0.06)",
                            }}
                            transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
                            style={{
                                background:
                                    "linear-gradient(135deg, rgba(255,255,255,0.08), rgba(255,255,255,0.015) 60%), rgba(14,17,24,0.55)",
                                backdropFilter: "blur(14px) saturate(160%)",
                                WebkitBackdropFilter: "blur(14px) saturate(160%)",
                                border: "2px solid #F4F4F5",
                                boxShadow:
                                    "3px 3px 0 0 #06B8D4, inset 0 1px 0 rgba(255,255,255,0.18), inset 0 0 0 1px rgba(255,255,255,0.04)",
                                padding: "10px 16px",
                                fontFamily: 'var(--font-mono, ui-monospace, "SF Mono", Menlo, monospace)',
                                fontSize: 11,
                                fontWeight: 700,
                                letterSpacing: "0.14em",
                                textTransform: "uppercase",
                                color: "#F4F4F5",
                                display: "inline-flex",
                                alignItems: "center",
                                gap: 8,
                                cursor: "default",
                            }}
                        >
                            <Icon className="h-3.5 w-3.5" style={{ color: "#06B8D4" }} strokeWidth={2.5} />
                            {label}
                        </motion.div>
                    ))}
                </motion.div>
            </motion.div>
        </section>
    )
}

export default HeroSection
