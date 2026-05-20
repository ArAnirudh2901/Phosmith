"use client"

import React, { useState, useEffect, useCallback } from "react"
import { motion, AnimatePresence } from "framer-motion"
import {
    Move, Crop, Sliders, Text, Palette, Maximize2, Eye, Wand2, X,
} from "lucide-react"
import { useCanvas } from "../../../../../../context/context"
import usePlanAccess from "../../../../../../hooks/usePlanAccess"

const MENU_SIZE = 280
const MENU_HALF = MENU_SIZE / 2

const TOOLS = [
    { id: "resize", label: "Resize", icon: Move, shortcut: "V" },
    { id: "crop", label: "Crop", icon: Crop, shortcut: "C" },
    { id: "adjust", label: "Adjust", icon: Sliders },
    { id: "text", label: "Text", icon: Text },
    { id: "ai_background", label: "AI BG", icon: Palette, pro: true },
    { id: "ai_extender", label: "Extend", icon: Maximize2, pro: true },
    { id: "ai_edit", label: "AI Edit", icon: Eye, pro: true },
    { id: "generative_expand", label: "Gen Fill", icon: Wand2, pro: true },
]

const RadialToolMenu = ({
    visible = false,
    position = { x: 0, y: 0 },
    onClose,
    onToolSelect,
}) => {
    const [hoveredTool, setHoveredTool] = useState(null)
    const { activeTool } = useCanvas()
    const { hasAccess } = usePlanAccess()

    const radius = 110
    const totalTools = TOOLS.length
    const angleStep = (2 * Math.PI) / totalTools

    const handleToolClick = (tool) => {
        if (tool.pro && !hasAccess(tool.id)) return
        onToolSelect?.(tool.id)
        onClose?.()
    }

    const handleMouseMove = useCallback((e) => {
        if (!visible) return
        const dx = e.clientX - position.x
        const dy = e.clientY - position.y
        const angle = Math.atan2(dy, dx)
        const normalizedAngle = angle + Math.PI / 2
        const toolIndex = Math.floor(((normalizedAngle + Math.PI * 2) % (Math.PI * 2)) / angleStep)
        const tool = TOOLS[toolIndex]
        setHoveredTool((current) => current === tool?.id ? current : tool?.id || null)
    }, [visible, position, angleStep])

    useEffect(() => {
        if (!visible) return undefined

        const handleKeyDown = (event) => {
            if (event.key === "Escape") onClose?.()
        }

        window.addEventListener("mousemove", handleMouseMove)
        window.addEventListener("keydown", handleKeyDown)
        return () => {
            window.removeEventListener("mousemove", handleMouseMove)
            window.removeEventListener("keydown", handleKeyDown)
        }
    }, [visible, handleMouseMove, onClose])

    if (!visible) return null

    return (
        <div
            className="fixed inset-0 z-50"
            onPointerDown={onClose}
            onContextMenu={(event) => event.preventDefault()}
        >
        <motion.div
            className="absolute"
            style={{ left: position.x - MENU_HALF, top: position.y - MENU_HALF, width: MENU_SIZE, height: MENU_SIZE }}
            initial={{ scale: 0, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0, opacity: 0 }}
            transition={{ type: "spring", stiffness: 400, damping: 25 }}
            onPointerDown={(event) => event.stopPropagation()}
        >
            <svg
                width={MENU_SIZE}
                height={MENU_SIZE}
                viewBox="-140 -140 280 280"
            >
                <defs>
                    <filter id="radial-shadow" x="-50%" y="-50%" width="200%" height="200%">
                        <feDropShadow dx="0" dy="8" stdDeviation="12" floodColor="#000" floodOpacity="0.5" />
                    </filter>
                    <radialGradient id="centerGrad" cx="50%" cy="50%" r="50%">
                        <stop offset="0%" stopColor="rgba(0,229,255,0.15)" />
                        <stop offset="100%" stopColor="rgba(0,229,255,0.02)" />
                    </radialGradient>
                </defs>

                {/* Background circle with glass effect */}
                <motion.circle
                    cx="0" cy="0" r="130"
                    fill="rgba(12,16,24,0.92)"
                    stroke="rgba(255,255,255,0.08)"
                    strokeWidth="1.5"
                    filter="url(#radial-shadow)"
                />
                <circle cx="0" cy="0" r="120" fill="url(#centerGrad)" />

                {/* Glow ring animation */}
                <motion.circle
                    cx="0" cy="0" r="125"
                    fill="none"
                    stroke="var(--accent-ink)"
                    strokeWidth="1.5"
                    strokeOpacity="0.2"
                    animate={{ strokeOpacity: [0.2, 0.5, 0.2] }}
                    transition={{ duration: 3, repeat: Infinity }}
                />

                {/* Connecting lines */}
                {TOOLS.map((_, index) => {
                    const angle = index * angleStep - Math.PI / 2
                    const x1 = Math.cos(angle) * 18
                    const y1 = Math.sin(angle) * 18
                    const x2 = Math.cos(angle) * (radius - 35)
                    const y2 = Math.sin(angle) * (radius - 35)
                    return (
                        <line
                            key={`line-${index}`}
                            x1={x1} y1={y1} x2={x2} y2={y2}
                            stroke="rgba(255,255,255,0.1)"
                            strokeWidth="0.5"
                        />
                    )
                })}

                {/* Center button */}
                <motion.g
                    whileHover={{ scale: 1.1 }}
                    whileTap={{ scale: 0.9 }}
                    style={{ cursor: 'pointer' }}
                    onClick={onClose}
                >
                    <circle cx="0" cy="0" r="30" fill="rgba(255,255,255,0.05)" stroke="rgba(255,255,255,0.15)" strokeWidth="1" />
                    <text x="0" y="1" textAnchor="middle" dominantBaseline="middle" fill="var(--accent-ink)" fontSize="16" fontFamily="sans-serif" fontWeight="bold">×</text>
                </motion.g>

                {/* Tool segments */}
                {TOOLS.map((tool, index) => {
                    const angle = index * angleStep - Math.PI / 2
                    const x = Math.cos(angle) * radius
                    const y = Math.sin(angle) * radius
                    const Icon = tool.icon
                    const isHovered = hoveredTool === tool.id
                    const isActive = activeTool === tool.id
                    const canAccess = !tool.pro || hasAccess(tool.id)

                    return (
                        <motion.g
                            key={tool.id}
                            className="cursor-pointer"
                            onClick={() => handleToolClick(tool)}
                            onMouseEnter={() => setHoveredTool(tool.id)}
                            onMouseLeave={() => setHoveredTool(null)}
                            whileHover={{ scale: 1.12 }}
                            whileTap={{ scale: 0.92 }}
                        >
                            {/* Glow background for active/hovered */}
                            <motion.circle
                                cx={x} cy={y} r={isHovered ? 30 : 28}
                                fill={isActive ? 'rgba(0,229,255,0.15)' : isHovered ? 'rgba(255,255,255,0.08)' : 'rgba(30,35,48,0.85)'}
                                stroke={isActive ? 'var(--accent-ink)' : isHovered ? 'rgba(255,255,255,0.15)' : 'transparent'}
                                strokeWidth={isActive ? '2' : '1'}
                                transition={{ duration: 0.2 }}
                                style={{ filter: isActive ? 'drop-shadow(0 0 8px rgba(0,229,255,0.3))' : 'none' }}
                            />

                            {/* Pro badge */}
                            {tool.pro && !canAccess && (
                                <g>
                                    <circle cx={x + 16} cy={y - 16} r="7" fill="rgba(251,191,36,0.2)" stroke="var(--accent-warning)" strokeWidth="1" />
                                    <text x={x + 16} y={y - 13} textAnchor="middle" fill="#FBBF24" fontSize="7" fontWeight="bold" fontFamily="sans-serif">P</text>
                                </g>
                            )}

                            {/* Icon */}
                            <foreignObject x={x - 12} y={y - 12} width="24" height="24" className="overflow-visible">
                                <div className="flex items-center justify-center w-full h-full">
                                    <Icon
                                        className="w-4 h-4"
                                        style={{
                                            color: canAccess
                                                ? isActive ? '#00E5FF' : isHovered ? 'var(--text-primary)' : 'var(--text-muted)'
                                                : 'var(--text-muted)',
                                            filter: isActive ? 'drop-shadow(0 0 4px rgba(0,229,255,0.5))' : 'none',
                                        }}
                                    />
                                </div>
                            </foreignObject>
                        </motion.g>
                    )
                })}

                {/* Tool label */}
                {hoveredTool && (
                    <motion.g initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                        <rect x="-50" y="78" width="100" height="20" rx="4" fill="var(--glass-bg-heavy)" stroke="var(--glass-border)" />
                        <text x="0" y="92" textAnchor="middle" fill="var(--text-primary)" fontSize="10" fontFamily="sans-serif" fontWeight="500">
                            {TOOLS.find((t) => t.id === hoveredTool)?.label}
                        </text>
                        {hoveredTool && TOOLS.find((t) => t.id === hoveredTool)?.shortcut && (
                            <text x="0" y="110" textAnchor="middle" fill="var(--text-muted)" fontSize="8" fontFamily="monospace">
                                [{TOOLS.find((t) => t.id === hoveredTool)?.shortcut}]
                            </text>
                        )}
                    </motion.g>
                )}
            </svg>

            {/* Close button */}
            <motion.button
                className="absolute -top-3 -right-3 w-7 h-7 rounded-full flex items-center justify-center pill-control"
                style={{ background: 'rgba(12,16,24,0.9)', border: '1px solid var(--glass-border)', color: 'var(--text-muted)' }}
                onClick={onClose}
                whileHover={{ scale: 1.1 }}
                whileTap={{ scale: 0.9 }}
            >
                <X className="h-3 w-3" />
            </motion.button>
        </motion.div>
        </div>
    )
}

export default RadialToolMenu
