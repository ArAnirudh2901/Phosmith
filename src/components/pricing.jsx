"use client"

import React from "react"
import { motion } from "framer-motion"
import { Check, X } from "lucide-react"
import {
    fadeUp,
    staggerContainer,
    staggerItem,
    viewport,
    useReducedMotion,
    motionVariants,
    whileInViewProps,
} from "@/lib/motion"
import NeoButton from "@/components/neo/NeoButton"

const PLANS = [
    {
        id: "free",
        name: "Free",
        tagline: "Try the canvas",
        price: "0",
        period: "/forever",
        ctaLabel: "Start free",
        ctaHref: "/sign-up",
        ctaVariant: "secondary",
        features: [
            { label: "3 projects", on: true },
            { label: "Crop · Resize · Adjust", on: true },
            { label: "Multi-image canvas", on: true },
            { label: "PNG & JPEG export", on: true },
            { label: "AI extend / upscale / retouch", on: false },
            { label: "AI agent (chat edits)", on: false },
            { label: "Unlimited projects", on: false },
        ],
    },
    {
        id: "pro",
        name: "Pro",
        tagline: "Photoshop-class workflow",
        price: "12",
        period: "/month",
        ctaLabel: "Upgrade to Pro",
        ctaHref: "/dashboard",
        ctaVariant: "primary",
        highlight: true,
        features: [
            { label: "Unlimited projects", on: true },
            { label: "Everything in Free", on: true },
            { label: "AI extend (outpainting)", on: true },
            { label: "AI upscale up to 16 MP", on: true },
            { label: "AI background remove / generate", on: true },
            { label: "AI agent (chat edits)", on: true },
            { label: "Priority AI queue", on: true },
        ],
    },
]

const Pricing = () => {
    const reduced = useReducedMotion()
    const headerMotion = whileInViewProps(reduced)
    const container = motionVariants(staggerContainer, reduced)
    const item = motionVariants(staggerItem, reduced)
    const fade = motionVariants(fadeUp, reduced)

    return (
        <section
            id="pricing"
            className="relative py-28 md:py-36"
            style={{ background: "#07090E", borderTop: "2px solid #F4F4F5" }}
        >
            <div className="max-w-5xl mx-auto px-6">
                <motion.div className="mb-16" variants={fade} {...headerMotion}>
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
                        <span style={{ color: "#06B8D4" }}>02 /</span> Pricing
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
                        Two tiers.<br />
                        <span className="liquid-reactive-text-stroke">No fluff.</span>
                    </h2>
                </motion.div>

                <motion.div
                    className="grid md:grid-cols-2 gap-8"
                    variants={container}
                    initial="hidden"
                    whileInView="visible"
                    viewport={viewport}
                >
                    {PLANS.map((plan) => (
                        <motion.div key={plan.id} variants={item} className="relative">
                            {plan.highlight && (
                                <div
                                    style={{
                                        position: "absolute",
                                        top: -14,
                                        left: 24,
                                        background: "#06B8D4",
                                        color: "#03050A",
                                        border: "2px solid #F4F4F5",
                                        padding: "4px 12px",
                                        fontFamily:
                                            'var(--font-mono, ui-monospace, "SF Mono", Menlo, monospace)',
                                        fontSize: 10,
                                        fontWeight: 800,
                                        letterSpacing: "0.18em",
                                        textTransform: "uppercase",
                                        zIndex: 2,
                                    }}
                                >
                                    Most Picked
                                </div>
                            )}
                            <div
                                style={{
                                    background: plan.highlight
                                        ? "linear-gradient(135deg, rgba(6,184,212,0.07), rgba(14,17,24,0.55) 60%)"
                                        : "linear-gradient(135deg, rgba(255,255,255,0.06), rgba(14,17,24,0.55) 60%)",
                                    backdropFilter: "blur(20px) saturate(160%)",
                                    WebkitBackdropFilter: "blur(20px) saturate(160%)",
                                    border: "2px solid #F4F4F5",
                                    boxShadow: plan.highlight
                                        ? "10px 10px 0 0 #06B8D4, inset 0 1px 0 rgba(255,255,255,0.18), inset 0 0 0 1px rgba(255,255,255,0.04)"
                                        : "10px 10px 0 0 #F4F4F5, inset 0 1px 0 rgba(255,255,255,0.15), inset 0 0 0 1px rgba(255,255,255,0.04)",
                                    padding: 32,
                                    height: "100%",
                                    display: "flex",
                                    flexDirection: "column",
                                }}
                            >
                                <div
                                    style={{
                                        fontFamily:
                                            'var(--font-mono, ui-monospace, "SF Mono", Menlo, monospace)',
                                        fontSize: 11,
                                        color: plan.highlight ? "#06B8D4" : "#A1A8B4",
                                        letterSpacing: "0.16em",
                                        textTransform: "uppercase",
                                        fontWeight: 700,
                                        marginBottom: 12,
                                    }}
                                >
                                    {plan.tagline}
                                </div>
                                <h3
                                    style={{
                                        color: "#F4F4F5",
                                        fontSize: 36,
                                        fontWeight: 900,
                                        letterSpacing: "-0.02em",
                                        textTransform: "uppercase",
                                        marginBottom: 16,
                                    }}
                                >
                                    {plan.name}
                                </h3>
                                <div style={{ display: "flex", alignItems: "baseline", marginBottom: 28 }}>
                                    <span style={{ color: "#A1A8B4", fontSize: 28, fontWeight: 700 }}>$</span>
                                    <span
                                        style={{
                                            color: "#F4F4F5",
                                            fontSize: 72,
                                            fontWeight: 900,
                                            lineHeight: 1,
                                            letterSpacing: "-0.04em",
                                        }}
                                    >
                                        {plan.price}
                                    </span>
                                    <span
                                        style={{
                                            color: "#A1A8B4",
                                            fontFamily:
                                                'var(--font-mono, ui-monospace, "SF Mono", Menlo, monospace)',
                                            fontSize: 12,
                                            marginLeft: 10,
                                            textTransform: "uppercase",
                                            letterSpacing: "0.12em",
                                        }}
                                    >
                                        {plan.period}
                                    </span>
                                </div>

                                <ul style={{ margin: 0, padding: 0, listStyle: "none", marginBottom: 28, flex: 1 }}>
                                    {plan.features.map((feat) => (
                                        <li
                                            key={feat.label}
                                            style={{
                                                display: "flex",
                                                alignItems: "center",
                                                gap: 12,
                                                padding: "8px 0",
                                                fontSize: 14,
                                                color: feat.on ? "#F4F4F5" : "#6B7280",
                                                textDecoration: feat.on ? "none" : "line-through",
                                                textDecorationColor: "#6B7280",
                                            }}
                                        >
                                            <span
                                                style={{
                                                    width: 22,
                                                    height: 22,
                                                    background: feat.on ? "#06B8D4" : "#0E1118",
                                                    border: "2px solid #F4F4F5",
                                                    display: "inline-flex",
                                                    alignItems: "center",
                                                    justifyContent: "center",
                                                    flexShrink: 0,
                                                }}
                                            >
                                                {feat.on ? (
                                                    <Check className="h-3 w-3" style={{ color: "#03050A" }} strokeWidth={3} />
                                                ) : (
                                                    <X className="h-3 w-3" style={{ color: "#6B7280" }} strokeWidth={3} />
                                                )}
                                            </span>
                                            {feat.label}
                                        </li>
                                    ))}
                                </ul>

                                <NeoButton variant={plan.ctaVariant} size="lg" href={plan.ctaHref}>
                                    {plan.ctaLabel}
                                </NeoButton>
                            </div>
                        </motion.div>
                    ))}
                </motion.div>
            </div>
        </section>
    )
}

export default Pricing
