"use client"

import React, { useState, useEffect, useCallback, useMemo } from "react"
import { motion, AnimatePresence } from "framer-motion"
import {
    Bot, Crop, Sliders, Type, Palette, Maximize2, Sparkles, X,
} from "lucide-react"
import { useCanvas } from "../../../../../../context/context"
import usePlanAccess from "../../../../../../hooks/usePlanAccess"

const MENU_RADIUS = 130
const ICON_ORBIT = 96
const ICON_SIZE = 42
const CENTER_SIZE = 40

const TOOLS = [
    { id: "crop", label: "Crop", icon: Crop, shortcut: "C" },
    { id: "adjust", label: "Adjust", icon: Sliders },
    { id: "text", label: "Text", icon: Type },
    { id: "ai_background", label: "AI Background", icon: Palette, pro: true },
    { id: "ai_extender", label: "Extend", icon: Maximize2, pro: true },
    { id: "ai_edit", label: "AI Edit", icon: Sparkles, pro: true },
    { id: "ai_agent", label: "Agent", icon: Bot },
]

const RadialToolMenu = ({
    visible = false,
    position = { x: 0, y: 0 },
    holdMode = false,
    onClose,
    onHoverToolChange,
    onToolSelect,
}) => {
    const [hoveredTool, setHoveredTool] = useState(null)
    const { activeTool } = useCanvas()
    const { hasAccess } = usePlanAccess()

    const totalTools = TOOLS.length
    const angleStep = (2 * Math.PI) / totalTools

    // Pre-compute tool positions
    const toolPositions = useMemo(() =>
        TOOLS.map((tool, index) => {
            const angle = index * angleStep - Math.PI / 2
            return {
                ...tool,
                x: Math.cos(angle) * ICON_ORBIT,
                y: Math.sin(angle) * ICON_ORBIT,
                angle,
                index,
            }
        }), [angleStep]
    )

    const handleToolClick = (tool) => {
        if (tool.pro && !hasAccess(tool.id)) return
        onToolSelect?.(tool.id)
        onClose?.()
    }

    useEffect(() => {
        onHoverToolChange?.(hoveredTool)
    }, [hoveredTool, onHoverToolChange])

    const handleMouseMove = useCallback((e) => {
        if (!visible) return
        const dx = e.clientX - position.x
        const dy = e.clientY - position.y
        const dist = Math.sqrt(dx * dx + dy * dy)

        // Only detect hover when cursor is in the tool ring zone
        if (dist < 45 || dist > MENU_RADIUS + 10) {
            setHoveredTool((current) => current ? null : current)
            return
        }

        const angle = Math.atan2(dy, dx)
        const normalizedAngle = ((angle + Math.PI / 2) + Math.PI * 2) % (Math.PI * 2)
        const toolIndex = Math.floor(normalizedAngle / angleStep)
        const tool = TOOLS[toolIndex % totalTools]
        setHoveredTool((current) => current === tool?.id ? current : tool?.id || null)
    }, [visible, position, angleStep, totalTools])

    useEffect(() => {
        if (!visible) {
            setHoveredTool(null)
            return undefined
        }

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

    const hoveredToolData = hoveredTool ? TOOLS.find((t) => t.id === hoveredTool) : null

    if (!visible) return null

    const menuDiameter = MENU_RADIUS * 2

    return (
        <div
            className="fixed inset-0 z-50"
            onPointerDown={holdMode ? undefined : onClose}
            onContextMenu={(event) => event.preventDefault()}
        >
            <motion.div
                className="absolute"
                style={{
                    left: position.x - MENU_RADIUS,
                    top: position.y - MENU_RADIUS,
                    width: menuDiameter,
                    height: menuDiameter,
                }}
                initial={{ scale: 0.3, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.3, opacity: 0 }}
                transition={{ type: "spring", stiffness: 500, damping: 30, mass: 0.8 }}
                onPointerDown={(event) => event.stopPropagation()}
            >
                {/* Main glassmorphism backdrop */}
                <div
                    className="absolute inset-0 rounded-full"
                    style={{
                        background: 'rgba(8, 12, 20, 0.45)',
                        backdropFilter: 'blur(40px) saturate(1.8)',
                        WebkitBackdropFilter: 'blur(40px) saturate(1.8)',
                        border: '1px solid rgba(255, 255, 255, 0.08)',
                        boxShadow: `
                            0 0 0 1px rgba(0, 0, 0, 0.3),
                            0 24px 80px rgba(0, 0, 0, 0.5),
                            0 8px 32px rgba(0, 0, 0, 0.3),
                            inset 0 1px 0 rgba(255, 255, 255, 0.06),
                            inset 0 -1px 0 rgba(0, 0, 0, 0.2)
                        `,
                    }}
                />

                {/* Subtle inner ring highlight */}
                <div
                    className="absolute rounded-full pointer-events-none"
                    style={{
                        inset: '12px',
                        border: '1px solid rgba(255, 255, 255, 0.04)',
                        borderRadius: '50%',
                    }}
                />

                {/* Animated accent ring */}
                <motion.div
                    className="absolute rounded-full pointer-events-none"
                    style={{
                        inset: '-1px',
                        borderRadius: '50%',
                        border: '1.5px solid transparent',
                        background: `linear-gradient(rgba(0,0,0,0), rgba(0,0,0,0)) padding-box,
                                     conic-gradient(from 0deg, transparent 0%, var(--accent-primary) 15%, transparent 30%, transparent 100%) border-box`,
                    }}
                    animate={{ rotate: 360 }}
                    transition={{ duration: 8, repeat: Infinity, ease: "linear" }}
                />

                {/* Tool nodes */}
                {toolPositions.map((tool) => {
                    const Icon = tool.icon
                    const isHovered = hoveredTool === tool.id
                    const isActive = activeTool === tool.id
                    const canAccess = !tool.pro || hasAccess(tool.id)

                    return (
                        <motion.button
                            key={tool.id}
                            type="button"
                            className="absolute flex items-center justify-center"
                            style={{
                                width: ICON_SIZE,
                                height: ICON_SIZE,
                                left: MENU_RADIUS + tool.x - ICON_SIZE / 2,
                                top: MENU_RADIUS + tool.y - ICON_SIZE / 2,
                                borderRadius: '14px',
                                cursor: canAccess ? 'pointer' : 'not-allowed',
                            }}
                            onClick={() => handleToolClick(tool)}
                            onMouseEnter={() => setHoveredTool(tool.id)}
                            onMouseLeave={() => setHoveredTool(null)}
                            initial={{ scale: 0, opacity: 0 }}
                            animate={{
                                scale: 1,
                                opacity: 1,
                            }}
                            transition={{
                                type: "spring",
                                stiffness: 400,
                                damping: 22,
                                delay: tool.index * 0.04 + 0.08,
                            }}
                            whileHover={{ scale: 1.15 }}
                            whileTap={{ scale: 0.92 }}
                        >
                            {/* Tool button background */}
                            <motion.div
                                className="absolute inset-0 rounded-[14px]"
                                animate={{
                                    background: isActive
                                        ? 'rgba(0, 229, 255, 0.15)'
                                        : isHovered
                                            ? 'rgba(255, 255, 255, 0.12)'
                                            : 'rgba(255, 255, 255, 0.05)',
                                    borderColor: isActive
                                        ? 'rgba(0, 229, 255, 0.5)'
                                        : isHovered
                                            ? 'rgba(255, 255, 255, 0.18)'
                                            : 'rgba(255, 255, 255, 0.06)',
                                    boxShadow: isActive
                                        ? '0 0 20px rgba(0, 229, 255, 0.25), inset 0 1px 0 rgba(255,255,255,0.1)'
                                        : isHovered
                                            ? '0 4px 16px rgba(0, 0, 0, 0.3), inset 0 1px 0 rgba(255,255,255,0.08)'
                                            : 'inset 0 1px 0 rgba(255,255,255,0.04)',
                                }}
                                style={{
                                    border: '1px solid',
                                    backdropFilter: 'blur(12px)',
                                    WebkitBackdropFilter: 'blur(12px)',
                                }}
                                transition={{ duration: 0.2 }}
                            />

                            {/* Active indicator dot */}
                            {isActive && (
                                <motion.div
                                    className="absolute -bottom-1 left-1/2 -translate-x-1/2 rounded-full"
                                    style={{
                                        width: 4,
                                        height: 4,
                                        background: 'var(--accent-primary)',
                                        boxShadow: '0 0 8px var(--accent-primary)',
                                    }}
                                    layoutId="radial-active-dot"
                                />
                            )}

                            {/* Pro badge */}
                            {tool.pro && !canAccess && (
                                <div
                                    className="absolute -top-1 -right-1 flex items-center justify-center rounded-full text-[7px] font-bold"
                                    style={{
                                        width: 16,
                                        height: 16,
                                        background: 'rgba(251, 191, 36, 0.2)',
                                        border: '1px solid rgba(251, 191, 36, 0.5)',
                                        color: '#FBBF24',
                                        backdropFilter: 'blur(8px)',
                                    }}
                                >
                                    ✦
                                </div>
                            )}

                            {/* Icon */}
                            <Icon
                                className="relative z-10"
                                style={{
                                    width: 18,
                                    height: 18,
                                    color: canAccess
                                        ? isActive
                                            ? 'var(--accent-primary)'
                                            : isHovered
                                                ? '#fff'
                                                : 'rgba(255, 255, 255, 0.55)'
                                        : 'rgba(255, 255, 255, 0.25)',
                                    filter: isActive ? 'drop-shadow(0 0 6px rgba(0, 229, 255, 0.6))' : 'none',
                                    transition: 'color 0.15s, filter 0.15s',
                                }}
                            />
                        </motion.button>
                    )
                })}

                {/* Center close button */}
                <motion.button
                    type="button"
                    className="absolute flex items-center justify-center"
                    style={{
                        width: CENTER_SIZE,
                        height: CENTER_SIZE,
                        left: MENU_RADIUS - CENTER_SIZE / 2,
                        top: MENU_RADIUS - CENTER_SIZE / 2,
                        borderRadius: '50%',
                        background: 'rgba(255, 255, 255, 0.04)',
                        border: '1px solid rgba(255, 255, 255, 0.08)',
                        cursor: 'pointer',
                    }}
                    onClick={onClose}
                    whileHover={{
                        scale: 1.1,
                        background: 'rgba(255, 255, 255, 0.08)',
                        borderColor: 'rgba(255, 255, 255, 0.15)',
                    }}
                    whileTap={{ scale: 0.9 }}
                >
                    <X
                        style={{
                            width: 16,
                            height: 16,
                            color: 'rgba(255, 255, 255, 0.4)',
                        }}
                    />
                </motion.button>

                {/* Tool label — positioned ABOVE the menu */}
                <AnimatePresence mode="wait">
                    {hoveredToolData && (
                        <motion.div
                            key={hoveredToolData.id}
                            className="absolute left-1/2 flex items-center gap-2"
                            style={{
                                top: -40,
                                transform: 'translateX(-50%)',
                                pointerEvents: 'none',
                            }}
                            initial={{ opacity: 0, y: 6 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, y: 4 }}
                            transition={{ duration: 0.15 }}
                        >
                            <div
                                className="flex items-center gap-2 rounded-lg px-3 py-1.5"
                                style={{
                                    background: 'rgba(8, 12, 20, 0.75)',
                                    backdropFilter: 'blur(20px)',
                                    WebkitBackdropFilter: 'blur(20px)',
                                    border: '1px solid rgba(255, 255, 255, 0.1)',
                                    boxShadow: '0 4px 20px rgba(0, 0, 0, 0.4)',
                                }}
                            >
                                <span
                                    className="text-[11px] font-medium whitespace-nowrap"
                                    style={{ color: '#fff' }}
                                >
                                    {hoveredToolData.label}
                                </span>
                                {hoveredToolData.shortcut && (
                                    <span
                                        className="text-[9px] font-mono px-1 py-0.5 rounded"
                                        style={{
                                            color: 'rgba(255, 255, 255, 0.4)',
                                            background: 'rgba(255, 255, 255, 0.06)',
                                        }}
                                    >
                                        {hoveredToolData.shortcut}
                                    </span>
                                )}
                            </div>
                        </motion.div>
                    )}
                </AnimatePresence>
            </motion.div>
        </div>
    )
}

export default RadialToolMenu
