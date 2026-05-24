"use client"

import React from "react"
import { motion } from "framer-motion"
import {
    Bot,
    Crop,
    ImagePlus,
    Layers,
    Maximize2,
    Move,
    Palette,
    PenTool,
    Sliders,
    Sparkles,
    Type,
    Wand2,
} from "lucide-react"
import {
    fadeUp,
    staggerContainer,
    staggerItem,
    viewport,
    useReducedMotion,
    motionVariants,
    whileInViewProps,
} from "@/lib/motion"
import NeoCard from "@/components/neo/NeoCard"
import CountUp from "@/components/neo/CountUp"
import Marquee from "@/components/neo/Marquee"

const FEATURES = [
    {
        icon: Bot,
        title: "AI Agent",
        line: "Chat your edits",
        description:
            "Describe an edit in plain English. The agent plans the transforms, runs them through ImageKit, and replaces the image on the canvas.",
        accent: "#06B8D4",
    },
    {
        icon: Maximize2,
        title: "AI Extend",
        line: "Outpaint any direction",
        description:
            "Drag the edge handles. The model fills the empty space with content that matches lighting, perspective, and texture.",
        accent: "#A8794E",
    },
    {
        icon: Sparkles,
        title: "Upscale",
        line: "Up to 16 MP, lossless",
        description:
            "Upscale grows the document so the new resolution is preserved on export — not downsampled back to the original size.",
        accent: "#06B8D4",
    },
    {
        icon: Palette,
        title: "AI Background",
        line: "Cut, swap, generate",
        description:
            "Remove a background in one click. Replace it with a solid color, an Unsplash photo, or a fresh AI-generated scene.",
        accent: "#A8794E",
    },
    {
        icon: Layers,
        title: "Multi-Image Canvas",
        line: "Cascade & arrange",
        description:
            "Drop multiple images at once. Each one keeps its native resolution and lands cascaded — no invisible stacks.",
        accent: "#06B8D4",
    },
    {
        icon: Sliders,
        title: "Real-Time Adjust",
        line: "Live, no preview lag",
        description:
            "Brightness, contrast, saturation, hue, blur — every slider previews instantly without round-tripping a server.",
        accent: "#A8794E",
    },
    {
        icon: Wand2,
        title: "AI Retouch",
        line: "Clean ups, generated detail",
        description:
            "One-tap retouch presets for editorial, studio, and product. Or write a custom prompt and the agent builds a plan.",
        accent: "#06B8D4",
    },
    {
        icon: PenTool,
        title: "Draw & Annotate",
        line: "Vector + freehand",
        description:
            "Sketch on the canvas with pressure-aware strokes, drop shapes, or annotate with arrows and callouts.",
        accent: "#A8794E",
    },
    {
        icon: Type,
        title: "Typography",
        line: "Real type controls",
        description:
            "Variable weights, tracking, leading, fill, stroke, and shadow — typography that respects the document grid.",
        accent: "#06B8D4",
    },
]

const STATS = [
    { value: 200, suffix: "+", label: "AI Presets" },
    { value: 16, suffix: " MP", label: "Upscale Ceiling" },
    { value: 30, suffix: "", label: "Undo History" },
    { value: 0, suffix: " ms", label: "Round-Trip Lag" },
]

const HeroFeatures = () => {
    const reduced = useReducedMotion()
    const headerMotion = whileInViewProps(reduced)
    const container = motionVariants(staggerContainer, reduced)
    const item = motionVariants(staggerItem, reduced)
    const fade = motionVariants(fadeUp, reduced)

    return (
        <>
            <Marquee
                items={[
                    "AI EXTEND",
                    "UPSCALE",
                    "MASK",
                    "RETOUCH",
                    "GENERATE",
                    "RECOMPOSE",
                    "ADJUST",
                    "ANNOTATE",
                ]}
            />

            <section id="features" className="relative py-28 md:py-36" style={{ background: "#07090E" }}>
                <div className="max-w-7xl mx-auto px-6">
                    <motion.div className="mb-16 max-w-3xl" variants={fade} {...headerMotion}>
                        <div
                            style={{
                                background: "#0E1118",
                                border: "2px solid #F4F4F5",
                                padding: "6px 14px",
                                display: "inline-flex",
                                alignItems: "center",
                                gap: 8,
                                fontFamily: 'var(--font-mono, ui-monospace, "SF Mono", Menlo, monospace)',
                                fontSize: 11,
                                fontWeight: 700,
                                letterSpacing: "0.16em",
                                textTransform: "uppercase",
                                color: "#F4F4F5",
                                marginBottom: 20,
                            }}
                        >
                            <span style={{ color: "#06B8D4" }}>01 /</span> The Toolkit
                        </div>
                        <h2
                            className="font-bold tracking-tight liquid-reactive-text"
                            style={{
                                fontSize: "clamp(36px, 6vw, 72px)",
                                lineHeight: 0.95,
                                textTransform: "uppercase",
                                letterSpacing: "-0.01em",
                            }}
                        >
                            Nine tools.<br />
                            One canvas.<br />
                            <span className="liquid-reactive-text-stroke">Zero round-trips.</span>
                        </h2>
                    </motion.div>

                    <motion.div
                        className="grid md:grid-cols-2 lg:grid-cols-3 gap-7"
                        variants={container}
                        initial="hidden"
                        whileInView="visible"
                        viewport={viewport}
                    >
                        {FEATURES.map((feature) => {
                            const Icon = feature.icon
                            return (
                                <motion.div key={feature.title} variants={item}>
                                    <NeoCard accent={feature.accent} material="glass" style={{ padding: 28, height: "100%" }}>
                                        <div
                                            style={{
                                                width: 48,
                                                height: 48,
                                                background: "rgba(7,9,14,0.65)",
                                                backdropFilter: "blur(12px) saturate(160%)",
                                                WebkitBackdropFilter: "blur(12px) saturate(160%)",
                                                border: "2px solid #F4F4F5",
                                                display: "inline-flex",
                                                alignItems: "center",
                                                justifyContent: "center",
                                                marginBottom: 20,
                                                boxShadow: `4px 4px 0 0 ${feature.accent}, inset 0 1px 0 rgba(255,255,255,0.18)`,
                                            }}
                                        >
                                            <Icon className="h-5 w-5" style={{ color: feature.accent }} strokeWidth={2.5} />
                                        </div>
                                        <div
                                            style={{
                                                fontFamily: 'var(--font-mono, ui-monospace, "SF Mono", Menlo, monospace)',
                                                fontSize: 10,
                                                color: feature.accent,
                                                letterSpacing: "0.16em",
                                                textTransform: "uppercase",
                                                marginBottom: 6,
                                                fontWeight: 700,
                                            }}
                                        >
                                            {feature.line}
                                        </div>
                                        <h3
                                            style={{
                                                color: "#F4F4F5",
                                                fontSize: 22,
                                                fontWeight: 800,
                                                letterSpacing: "-0.01em",
                                                marginBottom: 12,
                                                textTransform: "uppercase",
                                            }}
                                        >
                                            {feature.title}
                                        </h3>
                                        <p style={{ color: "#A1A8B4", fontSize: 14, lineHeight: 1.6 }}>
                                            {feature.description}
                                        </p>
                                    </NeoCard>
                                </motion.div>
                            )
                        })}
                    </motion.div>

                    <motion.div
                        className="mt-24 grid grid-cols-2 md:grid-cols-4 gap-0"
                        variants={container}
                        initial="hidden"
                        whileInView="visible"
                        viewport={viewport}
                        style={{
                            border: "2px solid #F4F4F5",
                            background: "#0E1118",
                            boxShadow: "8px 8px 0 0 #06B8D4",
                        }}
                    >
                        {STATS.map((stat, idx) => (
                            <motion.div
                                key={stat.label}
                                variants={item}
                                style={{
                                    padding: "32px 24px",
                                    borderRight: idx < STATS.length - 1 ? "2px solid #F4F4F5" : "none",
                                    borderBottom: idx < 2 ? "2px solid #F4F4F5" : "none",
                                    textAlign: "left",
                                }}
                                className={`${idx < 2 ? "md:border-b-0" : ""} ${idx === 1 ? "border-r md:border-r-2" : ""}`}
                            >
                                <div
                                    style={{
                                        color: "#F4F4F5",
                                        fontSize: 40,
                                        fontWeight: 900,
                                        lineHeight: 1,
                                        marginBottom: 8,
                                        letterSpacing: "-0.02em",
                                    }}
                                >
                                    <CountUp to={stat.value} suffix={stat.suffix} />
                                </div>
                                <div
                                    style={{
                                        fontFamily: 'var(--font-mono, ui-monospace, "SF Mono", Menlo, monospace)',
                                        fontSize: 11,
                                        color: "#A1A8B4",
                                        letterSpacing: "0.14em",
                                        textTransform: "uppercase",
                                        fontWeight: 700,
                                    }}
                                >
                                    {stat.label}
                                </div>
                            </motion.div>
                        ))}
                    </motion.div>
                </div>
            </section>
        </>
    )
}

export default HeroFeatures
