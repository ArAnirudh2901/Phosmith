"use client"

import React from "react"
import { Crown } from "lucide-react"
import usePlanAccess from "../../hooks/usePlanAccess"

const SIZE_CLASSES = {
    sm: "h-5 px-1.5 text-[9px] gap-1",
    md: "h-6 px-2 text-[10px] gap-1.5",
}

const ProBadge = ({ size = "md", className = "", title = "Pro plan", showIfFree = false, freeLabel = "FREE" }) => {
    const { isPro } = usePlanAccess()

    if (!isPro && !showIfFree) return null

    const sizeClass = SIZE_CLASSES[size] || SIZE_CLASSES.md

    if (isPro) {
        return (
            <span
                className={`inline-flex items-center rounded-full font-bold uppercase tracking-wider ${sizeClass} ${className}`}
                style={{
                    color: "#03050A",
                    background: "linear-gradient(135deg, #FFE9B3 0%, #FBBF24 55%, #A8794E 100%)",
                    boxShadow: "0 1px 6px rgba(251, 191, 36, 0.35), inset 0 1px 0 rgba(255,255,255,0.5)",
                    border: "1px solid rgba(251, 191, 36, 0.55)",
                }}
                title={title}
                aria-label="Pro plan"
            >
                <Crown className="h-3 w-3" strokeWidth={2.5} />
                <span>PRO</span>
            </span>
        )
    }

    return (
        <span
            className={`inline-flex items-center rounded-full font-semibold uppercase tracking-wider ${sizeClass} ${className}`}
            style={{
                color: "var(--text-secondary)",
                background: "var(--bg-elevated)",
                border: "1px solid var(--border-default)",
            }}
            title="Free plan"
            aria-label="Free plan"
        >
            <span>{freeLabel}</span>
        </span>
    )
}

export default ProBadge
