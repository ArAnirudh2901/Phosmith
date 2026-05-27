"use client"

import React, { useState, useEffect, useCallback, useRef } from "react"
import { motion, AnimatePresence } from "framer-motion"
import {
    Bot, Crop, ImagePlus, Maximize2, Palette, Pen, Sliders, Sparkles, Type,
} from "lucide-react"
import { useCanvas } from "../../../../../../context/context"
import usePlanAccess from "../../../../../../hooks/usePlanAccess"

const TOOLS = [
    {
        id: "crop", label: "Crop", icon: Crop, shortcut: "C",
        subs: [
            { id: "1:1",   label: "1:1" },
            { id: "4:5",   label: "4:5" },
            { id: "16:9",  label: "16:9" },
            { id: "3:2",   label: "3:2" },
            { id: "free",  label: "Free" },
        ],
    },
    { id: "images", label: "Images", icon: ImagePlus, shortcut: "I", pro: true },
    {
        id: "adjust", label: "Adjust", icon: Sliders, shortcut: "A",
        subs: [
            { id: "brighten", label: "Brighten" },
            { id: "punch",    label: "Punch" },
            { id: "warm",     label: "Warm" },
            { id: "bw",       label: "B&W" },
        ],
    },
    { id: "draw", label: "Draw", icon: Pen, shortcut: "D", pro: true },
    { id: "text", label: "Text", icon: Type, shortcut: "T", pro: true },
    {
        id: "ai_background", label: "AI BG", icon: Palette, pro: true,
        subs: [
            { id: "remove",   label: "Remove" },
            { id: "blur",     label: "Blur" },
            { id: "replace",  label: "Replace" },
        ],
    },
    {
        id: "ai_extender", label: "Extend", icon: Maximize2, pro: true,
        subs: [
            { id: "top",    label: "Top" },
            { id: "right",  label: "Right" },
            { id: "bottom", label: "Bottom" },
            { id: "left",   label: "Left" },
            { id: "all",    label: "All sides" },
        ],
    },
    { id: "ai_edit", label: "AI Edit", icon: Sparkles, pro: true },
    {
        id: "ai_agent", label: "Agent", icon: Bot,
        subs: [
            { id: "cinematic", label: "Cinematic" },
            { id: "editorial", label: "Editorial" },
            { id: "vibrant",   label: "Vibrant" },
            { id: "studio",    label: "Studio" },
        ],
    },
]

// Radius constants
const OUTER_R = 140
const INNER_R = 52
const ICON_R = 98
const CENTER_R = 44
const DEADZONE_R = 30
// Sub-ring lives just outside the main wedges. Hovering a wedge with subs
// makes a fan of small chips appear at this radius; dragging into one selects
// it and fires onToolSelect(toolId, subId).
const SUB_RING_R = 178
const SUB_ICON_R = 178
const SUB_RING_DEPTH = 60

// Build a wedge SVG path (annular sector)
function wedgePath(startAngle, endAngle, innerR, outerR) {
    const toRad = (deg) => (deg * Math.PI) / 180
    const s = toRad(startAngle)
    const e = toRad(endAngle)
    const x1 = outerR + outerR * Math.cos(s)
    const y1 = outerR + outerR * Math.sin(s)
    const x2 = outerR + outerR * Math.cos(e)
    const y2 = outerR + outerR * Math.sin(e)
    const x3 = outerR + innerR * Math.cos(e)
    const y3 = outerR + innerR * Math.sin(e)
    const x4 = outerR + innerR * Math.cos(s)
    const y4 = outerR + innerR * Math.sin(s)
    const largeArc = endAngle - startAngle > 180 ? 1 : 0
    return [
        `M ${x1} ${y1}`,
        `A ${outerR} ${outerR} 0 ${largeArc} 1 ${x2} ${y2}`,
        `L ${x3} ${y3}`,
        `A ${innerR} ${innerR} 0 ${largeArc} 0 ${x4} ${y4}`,
        `Z`,
    ].join(" ")
}

const RadialToolMenu = ({
    visible = false,
    position = { x: 0, y: 0 },
    holdMode = false,
    onClose,
    onHoverToolChange,
    onToolSelect,
}) => {
    const [hoveredIndex, setHoveredIndex] = useState(-1)
    const [hoveredSubIndex, setHoveredSubIndex] = useState(-1)
    const containerRef = useRef(null)
    const { activeTool } = useCanvas()
    const { hasAccess } = usePlanAccess()

    const count = TOOLS.length
    const sliceAngle = 360 / count

    const handleToolClick = (tool, subId = null) => {
        if (tool.pro && !hasAccess(tool.id)) return
        // Pass subId as a second arg so the parent route can switch tool and react
        // to the sub-selection (e.g. set crop aspect, pre-fill agent prompt).
        onToolSelect?.(tool.id, subId)
        onClose?.()
    }

    // Track mouse position → which wedge (main ring) + which sub (outer ring).
    const handlePointerMove = useCallback(
        (e) => {
            if (!visible) return
            const dx = e.clientX - position.x
            const dy = e.clientY - position.y
            const dist = Math.sqrt(dx * dx + dy * dy)

            if (dist < DEADZONE_R) {
                setHoveredIndex(-1)
                setHoveredSubIndex(-1)
                return
            }

            let angle = (Math.atan2(dy, dx) * 180) / Math.PI
            angle = (angle + 90 + 360) % 360
            angle = (angle + sliceAngle / 2) % 360

            const wedgeIdx = Math.floor(angle / sliceAngle)
            const tool = TOOLS[wedgeIdx]
            setHoveredIndex(wedgeIdx >= 0 && wedgeIdx < count ? wedgeIdx : -1)

            // Sub-ring detection: only when we're past OUTER_R, the hovered wedge has
            // subs, and we're still within the sub-ring annulus. Otherwise reset.
            if (
                dist > OUTER_R &&
                dist < OUTER_R + SUB_RING_DEPTH &&
                tool?.subs?.length
            ) {
                // Each sub spans sliceAngle / subCount within the parent wedge.
                // Compute the sub-relative angle within the wedge.
                const wedgeStart = wedgeIdx * sliceAngle
                const within = angle - wedgeStart // 0..sliceAngle
                const subSpan = sliceAngle / tool.subs.length
                const subIdx = Math.floor(within / subSpan)
                setHoveredSubIndex(subIdx >= 0 && subIdx < tool.subs.length ? subIdx : -1)
            } else {
                setHoveredSubIndex(-1)
            }
        },
        [visible, position.x, position.y, sliceAngle, count]
    )

    // Propagate hovered tool + hovered sub
    useEffect(() => {
        const tool = hoveredIndex >= 0 ? TOOLS[hoveredIndex] : null
        const sub = tool && hoveredSubIndex >= 0 ? tool.subs?.[hoveredSubIndex] : null
        onHoverToolChange?.(tool?.id || null, sub?.id || null)
    }, [hoveredIndex, hoveredSubIndex, onHoverToolChange])

    // Reset on visibility change + attach Escape
    useEffect(() => {
        if (!visible) {
            setHoveredIndex(-1)
            setHoveredSubIndex(-1)
            return undefined
        }
        const handleKeyDown = (e) => {
            if (e.key === "Escape") onClose?.()
        }
        window.addEventListener("keydown", handleKeyDown)
        return () => window.removeEventListener("keydown", handleKeyDown)
    }, [visible, onClose])

    // Attach global pointermove
    useEffect(() => {
        if (!visible) return undefined
        window.addEventListener("pointermove", handlePointerMove)
        return () => window.removeEventListener("pointermove", handlePointerMove)
    }, [visible, handlePointerMove])

    if (!visible) return null

    const hoveredTool = hoveredIndex >= 0 ? TOOLS[hoveredIndex] : null
    const size = OUTER_R * 2

    return (
        <div
            className="fixed inset-0 z-50"
            onPointerDown={holdMode ? undefined : onClose}
            onContextMenu={(e) => e.preventDefault()}
            ref={containerRef}
        >
            <motion.div
                className="absolute"
                style={{
                    left: position.x - OUTER_R,
                    top: position.y - OUTER_R,
                    width: size,
                    height: size,
                    pointerEvents: "none",
                }}
                initial={{ scale: 0.3, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.5, opacity: 0 }}
                transition={{ type: "spring", stiffness: 500, damping: 30, mass: 0.6 }}
                onPointerDown={(e) => e.stopPropagation()}
            >
                {/* SVG ring of wedges */}
                <svg
                    width={size}
                    height={size}
                    viewBox={`0 0 ${size} ${size}`}
                    style={{ position: "absolute", inset: 0, pointerEvents: "auto" }}
                >
                    {/* Outer glow filter */}
                    <defs>
                        <filter id="radial-glow" x="-50%" y="-50%" width="200%" height="200%">
                            <feGaussianBlur in="SourceGraphic" stdDeviation="6" result="blur" />
                            <feMerge>
                                <feMergeNode in="blur" />
                                <feMergeNode in="SourceGraphic" />
                            </feMerge>
                        </filter>
                        <radialGradient id="center-grad" cx="50%" cy="50%" r="50%">
                            <stop offset="0%" stopColor="rgba(18, 22, 32, 0.95)" />
                            <stop offset="100%" stopColor="rgba(10, 13, 20, 0.98)" />
                        </radialGradient>
                    </defs>

                    {/* Wedge segments */}
                    {TOOLS.map((tool, idx) => {
                        const isHovered = hoveredIndex === idx
                        const isActive = activeTool === tool.id
                        const canAccess = !tool.pro || hasAccess(tool.id)
                        // Start angle: -90° is top, offset by half slice to center
                        const startAngle = idx * sliceAngle - 90 - sliceAngle / 2
                        const endAngle = startAngle + sliceAngle

                        let fill = "rgba(16, 20, 30, 0.82)"
                        let stroke = "rgba(255, 255, 255, 0.06)"
                        let strokeW = 0.5

                        if (isHovered && canAccess) {
                            fill = "rgba(6, 184, 212, 0.14)"
                            stroke = "rgba(6, 184, 212, 0.5)"
                            strokeW = 1.5
                        } else if (isActive) {
                            fill = "rgba(6, 184, 212, 0.08)"
                            stroke = "rgba(6, 184, 212, 0.25)"
                            strokeW = 1
                        } else if (!canAccess) {
                            fill = "rgba(12, 14, 22, 0.85)"
                        }

                        return (
                            <path
                                key={tool.id}
                                d={wedgePath(startAngle, endAngle, INNER_R, OUTER_R)}
                                fill={fill}
                                stroke={stroke}
                                strokeWidth={strokeW}
                                style={{
                                    cursor: canAccess ? "pointer" : "not-allowed",
                                    transition: "fill 0.15s ease, stroke 0.15s ease",
                                    filter: isHovered && canAccess ? "url(#radial-glow)" : "none",
                                }}
                                onClick={() => handleToolClick(tool)}
                                onPointerEnter={() => setHoveredIndex(idx)}
                            />
                        )
                    })}

                    {/* Separator lines between wedges */}
                    {TOOLS.map((_, idx) => {
                        const angle = ((idx * sliceAngle - 90 - sliceAngle / 2) * Math.PI) / 180
                        const x1 = OUTER_R + INNER_R * Math.cos(angle)
                        const y1 = OUTER_R + INNER_R * Math.sin(angle)
                        const x2 = OUTER_R + OUTER_R * Math.cos(angle)
                        const y2 = OUTER_R + OUTER_R * Math.sin(angle)
                        return (
                            <line
                                key={`sep-${idx}`}
                                x1={x1} y1={y1} x2={x2} y2={y2}
                                stroke="rgba(255, 255, 255, 0.05)"
                                strokeWidth="0.5"
                                style={{ pointerEvents: "none" }}
                            />
                        )
                    })}

                    {/* Center circle */}
                    <circle
                        cx={OUTER_R}
                        cy={OUTER_R}
                        r={CENTER_R}
                        fill="url(#center-grad)"
                        stroke="rgba(255, 255, 255, 0.1)"
                        strokeWidth="1"
                    />

                    {/* Inner ring accent */}
                    <circle
                        cx={OUTER_R}
                        cy={OUTER_R}
                        r={INNER_R}
                        fill="none"
                        stroke="rgba(255, 255, 255, 0.04)"
                        strokeWidth="0.5"
                    />

                    {/* Outer ring accent */}
                    <circle
                        cx={OUTER_R}
                        cy={OUTER_R}
                        r={OUTER_R - 1}
                        fill="none"
                        stroke="rgba(255, 255, 255, 0.06)"
                        strokeWidth="0.5"
                    />
                </svg>

                {/* Tool icons on top of wedges */}
                {TOOLS.map((tool, idx) => {
                    const Icon = tool.icon
                    const isHovered = hoveredIndex === idx
                    const isActive = activeTool === tool.id
                    const canAccess = !tool.pro || hasAccess(tool.id)
                    const midAngle = ((idx * sliceAngle - 90) * Math.PI) / 180
                    const ix = OUTER_R + ICON_R * Math.cos(midAngle)
                    const iy = OUTER_R + ICON_R * Math.sin(midAngle)

                    let color = "rgba(255, 255, 255, 0.45)"
                    if (isHovered && canAccess) color = "#00E5FF"
                    else if (isActive) color = "rgba(6, 184, 212, 0.7)"
                    else if (!canAccess) color = "rgba(255, 255, 255, 0.15)"

                    return (
                        <div
                            key={`icon-${tool.id}`}
                            className="absolute flex items-center justify-center"
                            style={{
                                left: ix - 16,
                                top: iy - 16,
                                width: 32,
                                height: 32,
                                pointerEvents: "none",
                                transition: "transform 0.15s ease, filter 0.15s ease",
                                transform: isHovered ? "scale(1.25)" : "scale(1)",
                                filter: isHovered && canAccess
                                    ? "drop-shadow(0 0 8px rgba(6, 184, 212, 0.6))"
                                    : "none",
                            }}
                        >
                            <Icon
                                className="w-4 h-4"
                                style={{ color }}
                            />
                            {/* Pro badge */}
                            {tool.pro && !canAccess && (
                                <span
                                    className="absolute -bottom-1 -right-1 text-[6px] font-bold px-1 rounded-full"
                                    style={{
                                        background: "rgba(251, 191, 36, 0.2)",
                                        border: "1px solid rgba(251, 191, 36, 0.4)",
                                        color: "#FBBF24",
                                        lineHeight: "1.3",
                                    }}
                                >
                                    PRO
                                </span>
                            )}
                        </div>
                    )
                })}

                {/* Center hub: show hovered tool name or "Select" */}
                <div
                    className="absolute flex flex-col items-center justify-center"
                    style={{
                        left: OUTER_R - CENTER_R,
                        top: OUTER_R - CENTER_R,
                        width: CENTER_R * 2,
                        height: CENTER_R * 2,
                        borderRadius: "50%",
                        pointerEvents: "none",
                    }}
                >
                    {hoveredTool ? (
                        <>
                            <span
                                className="text-[11px] font-bold tracking-wide"
                                style={{
                                    color: hoveredTool.pro && !hasAccess(hoveredTool.id)
                                        ? "rgba(251, 191, 36, 0.8)"
                                        : "#00E5FF",
                                    textShadow: "0 0 12px rgba(6, 184, 212, 0.4)",
                                    lineHeight: "1.2",
                                }}
                            >
                                {hoveredTool.label}
                            </span>
                            {hoveredTool.shortcut && (
                                <span
                                    className="text-[8px] font-mono mt-0.5"
                                    style={{ color: "rgba(255, 255, 255, 0.3)" }}
                                >
                                    [{hoveredTool.shortcut}]
                                </span>
                            )}
                        </>
                    ) : (
                        <span
                            className="text-[9px] font-medium"
                            style={{ color: "rgba(255, 255, 255, 0.25)" }}
                        >
                            Select
                        </span>
                    )}
                </div>

                {/* Sub-ring: render fan of small chips around the hovered wedge's outer arc.
                    Each chip is laid out by angular position within the parent wedge. */}
                {hoveredTool?.subs?.length > 0 && (() => {
                    const subs = hoveredTool.subs
                    const wedgeStart = hoveredIndex * sliceAngle
                    const subSpan = sliceAngle / subs.length
                    return subs.map((sub, sIdx) => {
                        // Center angle for each sub-chip, converted to math radians:
                        //   wedge starts at top (we offset by -90° to align with main ring).
                        const subCenter = wedgeStart + subSpan * (sIdx + 0.5)
                        const angleRad = ((subCenter - 90) * Math.PI) / 180
                        const cx = OUTER_R + SUB_ICON_R * Math.cos(angleRad)
                        const cy = OUTER_R + SUB_ICON_R * Math.sin(angleRad)
                        const isSubHovered = hoveredSubIndex === sIdx
                        return (
                            <motion.div
                                key={`sub-${hoveredTool.id}-${sub.id}`}
                                className="absolute"
                                style={{
                                    left: cx - 28,
                                    top: cy - 12,
                                    width: 56,
                                    height: 24,
                                    pointerEvents: "none",
                                    display: "flex",
                                    alignItems: "center",
                                    justifyContent: "center",
                                    borderRadius: 12,
                                    background: isSubHovered
                                        ? "rgba(6, 184, 212, 0.22)"
                                        : "rgba(10, 14, 22, 0.85)",
                                    border: isSubHovered
                                        ? "1px solid rgba(6, 184, 212, 0.65)"
                                        : "1px solid rgba(255, 255, 255, 0.10)",
                                    color: isSubHovered ? "#00E5FF" : "rgba(255, 255, 255, 0.78)",
                                    fontSize: 10,
                                    fontWeight: 700,
                                    letterSpacing: "0.04em",
                                    textTransform: "uppercase",
                                    boxShadow: isSubHovered
                                        ? "0 4px 16px rgba(6, 184, 212, 0.32)"
                                        : "0 2px 8px rgba(0,0,0,0.35)",
                                }}
                                initial={{ opacity: 0, scale: 0.6 }}
                                animate={{
                                    opacity: 1,
                                    scale: isSubHovered ? 1.1 : 1,
                                }}
                                transition={{ duration: 0.14, ease: [0.16, 1, 0.3, 1] }}
                            >
                                {sub.label}
                            </motion.div>
                        )
                    })
                })()}

                {/* Hovered tool label (outside the ring) */}
                {hoveredTool && (
                    <motion.div
                        className="absolute"
                        style={{
                            left: OUTER_R - 60,
                            top: size + 8,
                            width: 120,
                            textAlign: "center",
                            pointerEvents: "none",
                        }}
                        initial={{ opacity: 0, y: -4 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.1 }}
                    >
                        <span
                            className="text-[10px] font-semibold px-2 py-1 rounded-md"
                            style={{
                                background: "rgba(10, 14, 22, 0.9)",
                                border: "1px solid rgba(255, 255, 255, 0.08)",
                                color: "#e2e8f0",
                                backdropFilter: "blur(12px)",
                            }}
                        >
                            {hoveredTool.label}
                            {hoveredTool.shortcut && (
                                <span style={{ color: "rgba(255,255,255,0.3)", marginLeft: 4 }}>
                                    {hoveredTool.shortcut}
                                </span>
                            )}
                        </span>
                    </motion.div>
                )}
            </motion.div>

            {/* Backdrop blur behind the wheel */}
            <motion.div
                className="fixed inset-0 -z-10"
                style={{
                    background: "radial-gradient(circle at " + position.x + "px " + position.y + "px, rgba(0,0,0,0.35) 0%, rgba(0,0,0,0.15) 60%, transparent 100%)",
                    pointerEvents: "none",
                }}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2 }}
            />
        </div>
    )
}

export default RadialToolMenu
