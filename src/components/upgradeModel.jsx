"use client"

import { motion } from "framer-motion"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Crown, Zap } from "lucide-react"
import { Alert, AlertDescription } from "./ui/alert"
import { PricingTable } from "@clerk/nextjs"
import { pricingTableAppearance } from "@/lib/pricing-table-appearance"
import { Button } from "./ui/button"

const TOOL_NAMES = {
    ai_background: "AI Background Tools",
    ai_extender: "AI Image Extender",
    ai_edit: "AI Editor",
    ai_agent: "AI Agent",
    projects: "Unlimited Projects",
    draw: "Doodle & Drawing Tools",
    text: "Professional Text Editor",
    images: "Multiple Image Operations",
    mask: "Masking Tools",
    export: "Unlimited Exports",
}

const getToolName = (toolId) => TOOL_NAMES[toolId] || null

const UpgradeModel = ({ isOpen, onClose, restrictedTool, reason, isPro = false }) => {
    const toolName = restrictedTool ? getToolName(restrictedTool) : null

    return (
        <Dialog open={isOpen} onOpenChange={onClose}>
            <DialogContent className="sm:max-w-5xl bg-[var(--glass-bg-heavy)] border-[var(--glass-border)] shadow-[0_32px_120px_rgba(0,0,0,0.8)] backdrop-blur-2xl max-h-[90vh] overflow-y-auto p-6 sm:p-8">
                <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-[#00E5FF]/40 to-transparent" />

                <DialogHeader>
                    <div className="flex items-center gap-4">
                        <motion.div
                            animate={{ rotate: [0, 15, -15, 0], scale: [1, 1.1, 1.1, 1] }}
                            transition={{ duration: 2, repeat: Infinity }}
                        >
                            <Crown className="h-7 w-7 text-[#D946EF]" />
                        </motion.div>
                        <div>
                            <DialogTitle className="text-2xl font-bold text-white tracking-tight">
                                {isPro ? "You're on Pro" : "Upgrade to Pro"}
                            </DialogTitle>
                            <DialogDescription className="text-sm text-[var(--text-muted)] mt-1">
                                {isPro
                                    ? "Manage your subscription and billing"
                                    : "Unlock the full creative suite with Pro tools"}
                            </DialogDescription>
                        </div>
                    </div>
                </DialogHeader>

                <div className="space-y-6">
                    {restrictedTool && !isPro && (
                        <motion.div
                            initial={{ opacity: 0, y: -10 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ duration: 0.3 }}
                        >
                            <Alert className="bg-[#D946EF]/10 border-[#D946EF]/25">
                                <Zap className="h-5 w-5 text-[#D946EF]" />
                                <AlertDescription className="text-[#D946EF]/90">
                                    <div className="font-semibold text-[#D946EF] mb-1 flex items-center gap-2">
                                        <span>{toolName ?? "This is a Pro feature"}</span>
                                        <span className="text-[10px] font-bold tracking-wider uppercase px-1.5 py-0.5 rounded bg-[#D946EF]/20">
                                            Pro
                                        </span>
                                    </div>
                                    {reason ?? (toolName
                                        ? `Upgrade now to unlock ${toolName.toLowerCase()}`
                                        : "Upgrade to Pro to access this feature")}
                                </AlertDescription>
                            </Alert>
                        </motion.div>
                    )}

                    {isPro && (
                        <motion.div
                            initial={{ opacity: 0, y: -10 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ duration: 0.3 }}
                        >
                            <Alert className="bg-[#06B8D4]/10 border-[#06B8D4]/25">
                                <Crown className="h-5 w-5 text-[#06B8D4]" />
                                <AlertDescription className="text-[#06B8D4]/90">
                                    <div className="font-semibold mb-1">Pro benefits active</div>
                                    You have full access to all Pro tools. Use the pricing table below to manage your subscription.
                                </AlertDescription>
                            </Alert>
                        </motion.div>
                    )}

                    {!isPro && (
                        <motion.div
                            className="grid grid-cols-2 gap-3"
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            transition={{ delay: 0.2 }}
                        >
                            {[
                                { icon: Zap, label: "AI Generative Fill", color: "#00E5FF" },
                                { icon: Crown, label: "Priority Processing", color: "#FBBF24" },
                                { icon: Zap, label: "Unlimited Projects", color: "#D946EF" },
                                { icon: Zap, label: "Full AI Toolkit", color: "#34D399" },
                            ].map((feat) => (
                                <div
                                    key={feat.label}
                                    className="flex items-center gap-2.5 p-2.5 rounded-xl"
                                    style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.05)' }}
                                >
                                    <feat.icon className="h-4 w-4" style={{ color: feat.color }} />
                                    <span className="text-xs text-[var(--text-secondary)]">{feat.label}</span>
                                </div>
                            ))}
                        </motion.div>
                    )}

                    <div className="pricing-table-shell w-full">
                        <PricingTable
                            appearance={pricingTableAppearance}
                            checkoutProps={{
                                appearance: {
                                    elements: {
                                        drawerRoot: { zIndex: 200000 },
                                    },
                                },
                            }}
                        />
                    </div>
                </div>

                <DialogFooter className="justify-center pt-4">
                    <Button
                        variant="ghost"
                        onClick={onClose}
                        className="text-[var(--text-secondary)] hover:text-white transition-colors"
                    >
                        Maybe Later
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    )
}

export default UpgradeModel
