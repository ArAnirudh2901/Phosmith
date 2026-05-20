"use client"

import React from "react"
import { motion } from "framer-motion"
import Link from "next/link"
import GlassPanel from "@/components/ui/glass-panel"
import { TiltCard } from "@/components/ui/tilt-card"
import { Check, Zap, Crown, ArrowRight } from "lucide-react"

const PLANS = [
    {
        id: "free",
        name: "Starter",
        description: "Everything you need to begin your image editing journey",
        price: "$0",
        period: "forever",
        icon: Zap,
        features: ["3 projects", "Basic editing tools", "Resize & crop", "Color adjustments", "Text tool", "PNG, JPEG export"],
        cta: "Get Started",
        href: "/sign-up",
        popular: false,
    },
    {
        id: "pro",
        name: "Master",
        description: "Full creative suite with AI-powered tools and priority access",
        price: "$12",
        period: "/month",
        icon: Crown,
        features: [
            "Unlimited projects", "All AI tools", "Generative expand",
            "AI background removal", "AI image generation", "AI enhancement",
            "Priority processing", "Unsplash integration", "Layer support",
        ],
        cta: "Upgrade to Master",
        href: "/dashboard",
        popular: true,
    },
]

const containerVariants = {
    hidden: { opacity: 0 },
    visible: {
        opacity: 1,
        transition: {
            staggerChildren: 0.1,
        },
    },
}

const cardVariants = {
    hidden: { opacity: 0, y: 36 },
    visible: {
        opacity: 1,
        y: 0,
        transition: {
            duration: 0.7,
            ease: [0.22, 1, 0.36, 1],
        },
    },
}

const Pricing = () => {
    return (
        <section id="pricing" className="relative py-24 md:py-32 overflow-hidden">
            <div className="max-w-5xl mx-auto px-6 relative z-10">
                <motion.div
                    className="text-center mb-16"
                    initial={{ opacity: 0, y: 30 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true, margin: "-100px" }}
                    transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
                >
                    <div className="glass-chip px-3 py-1 text-xs font-semibold mb-6"
                        style={{
                            color: 'var(--text-primary)',
                        }}>
                        <Crown className="h-3 w-3" /> Pricing
                    </div>
                    <h2 className="text-4xl md:text-5xl lg:text-6xl font-display font-bold text-white mb-4 tracking-tight">
                        Simple, transparent pricing
                    </h2>
                    <p className="text-lg text-[var(--text-secondary)] max-w-xl mx-auto">
                        Start free, upgrade when you need AI superpowers. No hidden fees.
                    </p>
                </motion.div>

                <motion.div
                    className="grid md:grid-cols-2 gap-8 max-w-4xl mx-auto"
                    initial="hidden"
                    whileInView="visible"
                    viewport={{ once: true, margin: "-80px" }}
                    variants={containerVariants}
                >
                    {PLANS.map((plan) => {
                        const Icon = plan.icon

                        return (
                            <motion.div
                                key={plan.id}
                                className="relative"
                                variants={cardVariants}
                            >
                                {plan.popular && (
                                    <div
                                        className="glass-chip absolute -top-3 left-1/2 -translate-x-1/2 z-10 px-5 py-1.5 text-[10px] font-bold uppercase tracking-wider"
                                        style={{
                                            color: '#fff',
                                            borderColor: 'rgba(255,255,255,0.18)',
                                            boxShadow: '0 14px 34px rgba(0,0,0,0.28), inset 0 1px 0 rgba(255,255,255,0.14)',
                                        }}
                                    >
                                        Most Popular
                                    </div>
                                )}
                                <TiltCard maxTilt={4} perspective={700} scale={1.005} glare glareOpacity={0.025}>
                                    <GlassPanel
                                        className="!p-7 group relative overflow-hidden transition-all duration-500 glass-interactive"
                                        glowOnHover
                                    >
                                        {/* Gradient overlay for popular plan */}
                                        {plan.popular && (
                                            <div
                                                className="absolute inset-0 rounded-2xl pointer-events-none opacity-0 transition-opacity duration-500 group-hover:opacity-100"
                                                style={{
                                                    background: 'linear-gradient(135deg, rgba(255,255,255,0.06), rgba(255,255,255,0.02))',
                                                }}
                                            />
                                        )}

                                        {/* Glow ring */}
                                        {plan.popular && (
                                            <div
                                                className="absolute -inset-px rounded-2xl opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none"
                                                style={{
                                                    background: 'linear-gradient(135deg, rgba(255,255,255,0.14), transparent 50%, rgba(255,255,255,0.06))',
                                                    border: '1px solid rgba(255,255,255,0.14)',
                                                    boxShadow: '0 0 36px rgba(255,255,255,0.08)',
                                                }}
                                            />
                                        )}

                                        <div className="relative z-10">
                                            {/* Icon */}
                                            <motion.div
                                                className="glass-icon-surface w-12 h-12 rounded-2xl flex items-center justify-center mb-5"
                                                style={{
                                                    background: 'linear-gradient(135deg, rgba(255,255,255,0.08), rgba(255,255,255,0.025))',
                                                    border: '1px solid rgba(255,255,255,0.12)',
                                                    boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.12)',
                                                }}
                                                whileHover={{ scale: 1.04, y: -2 }}
                                                transition={{ type: 'spring', stiffness: 380, damping: 24 }}
                                            >
                                                <Icon className="h-6 w-6" style={{ color: 'var(--text-primary)' }} />
                                            </motion.div>

                                            {/* Plan name */}
                                            <h3 className="text-xl font-bold text-white mb-1">{plan.name}</h3>
                                            <p className="text-sm text-[var(--text-secondary)] mb-6">{plan.description}</p>

                                            {/* Price */}
                                            <div className="flex items-baseline gap-1 mb-7">
                                                <span className="text-5xl font-bold text-white tracking-tight">{plan.price}</span>
                                                <span className="text-sm text-[var(--text-muted)] ml-1">{plan.period}</span>
                                            </div>

                                            {/* Features */}
                                            <ul className="space-y-3.5 mb-8">
                                                {plan.features.map((feat) => (
                                                    <motion.li
                                                        key={feat}
                                                        className="flex items-center gap-3 text-sm"
                                                        style={{ color: 'var(--text-secondary)' }}
                                                        whileHover={{ x: 2 }}
                                                    >
                                                        <div
                                                            className="w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0"
                                                            style={{
                                                                background: 'rgba(255,255,255,0.06)',
                                                                border: '1px solid rgba(255,255,255,0.14)',
                                                                boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.1)',
                                                            }}
                                                        >
                                                            <Check className="h-2.5 w-2.5" style={{ color: 'var(--text-primary)' }} />
                                                        </div>
                                                        {feat}
                                                    </motion.li>
                                                ))}
                                            </ul>

                                            {/* CTA */}
                                            <motion.div whileTap={{ scale: 0.98 }}>
                                                <Link
                                                    href={plan.href}
                                                    className={`glass-action ${plan.popular ? 'glass-action-primary' : ''} w-full py-3.5 text-sm font-semibold flex items-center justify-center gap-2`}
                                                    style={{
                                                        color: plan.popular ? '#F4E8D8' : 'var(--text-primary)',
                                                    }}
                                                >
                                                    <span className="relative z-10 flex items-center gap-2">
                                                        {plan.cta}
                                                        <ArrowRight className="h-4 w-4" />
                                                    </span>
                                                </Link>
                                            </motion.div>
                                        </div>
                                    </GlassPanel>
                                </TiltCard>
                            </motion.div>
                        )
                    })}
                </motion.div>
            </div>
        </section>
    )
}

export default Pricing
