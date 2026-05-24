"use client"

import React, { forwardRef, useCallback, useRef, useState } from "react"
import { motion, useMotionValue, useSpring, useTransform } from "framer-motion"

const VARIANTS = {
    primary: {
        background: "#06B8D4",
        color: "#03050A",
        border: "1.5px solid #F4F4F5",
        shadowColor: "rgba(244, 244, 245, 0.85)",
        rippleColor: "rgba(255,255,255,0.85)",
    },
    secondary: {
        background: "#0E1118",
        color: "#F4F4F5",
        border: "1.5px solid rgba(244, 244, 245, 0.85)",
        shadowColor: "rgba(6, 184, 212, 0.85)",
        rippleColor: "rgba(6,184,212,0.85)",
    },
    ghost: {
        background: "transparent",
        color: "#F4F4F5",
        border: "1.5px solid rgba(244, 244, 245, 0.85)",
        shadowColor: "rgba(200, 149, 108, 0.85)",
        rippleColor: "rgba(200,149,108,0.85)",
    },
}

const SIZES = {
    md: { padding: "11px 20px", fontSize: 12.5, offset: 3 },
    lg: { padding: "15px 28px", fontSize: 13.5, offset: 4 },
    xl: { padding: "19px 34px", fontSize: 14.5, offset: 5 },
}

let rippleId = 0

const NeoButton = forwardRef(function NeoButton(
    {
        children,
        variant = "primary",
        size = "lg",
        disabled = false,
        magnetic = true,
        onClick,
        type = "button",
        as: Component,
        href,
        ariaLabel,
        ...rest
    },
    ref
) {
    const innerRef = useRef(null)
    const v = VARIANTS[variant] || VARIANTS.primary
    const s = SIZES[size] || SIZES.lg

    const x = useMotionValue(0)
    const y = useMotionValue(0)
    const sx = useSpring(x, { stiffness: 220, damping: 22, mass: 0.5 })
    const sy = useSpring(y, { stiffness: 220, damping: 22, mass: 0.5 })

    const shadowX = useTransform(sx, (v) => `${s.offset - v * 0.5}px`)
    const shadowY = useTransform(sy, (v) => `${s.offset - v * 0.5}px`)
    const boxShadow = useTransform([shadowX, shadowY], ([sx, sy]) => `${sx} ${sy} 0 0 ${v.shadowColor}`)

    const [ripples, setRipples] = useState([])

    const handleMouseMove = (event) => {
        if (!magnetic || disabled) return
        const target = innerRef.current
        if (!target) return
        const rect = target.getBoundingClientRect()
        const cx = rect.left + rect.width / 2
        const cy = rect.top + rect.height / 2
        const dx = (event.clientX - cx) / rect.width
        const dy = (event.clientY - cy) / rect.height
        const max = 6
        x.set(Math.max(-max, Math.min(max, dx * max * 2)))
        y.set(Math.max(-max, Math.min(max, dy * max * 2)))
    }

    const handleMouseLeave = () => {
        x.set(0)
        y.set(0)
    }

    const spawnRipple = useCallback((clientX, clientY) => {
        const node = innerRef.current
        if (!node) return
        const rect = node.getBoundingClientRect()
        const usingCenter = clientX == null || clientY == null
        const localX = usingCenter ? rect.width / 2 : clientX - rect.left
        const localY = usingCenter ? rect.height / 2 : clientY - rect.top
        const id = ++rippleId
        const diameter = Math.max(rect.width, rect.height) * 2.6
        setRipples((prev) => [...prev, { id, x: localX, y: localY, size: diameter }])
        setTimeout(() => {
            setRipples((prev) => prev.filter((r) => r.id !== id))
        }, 800)
    }, [])

    const handlePointerDown = useCallback(
        (event) => {
            if (disabled) return
            spawnRipple(event.clientX, event.clientY)
        },
        [disabled, spawnRipple]
    )

    const handleClick = useCallback(
        (event) => {
            if (disabled) return
            onClick?.(event)
        },
        [disabled, onClick]
    )

    const pressShadow = `0 0 0 0 ${v.shadowColor}`

    const motionProps = {
        ref: (node) => {
            innerRef.current = node
            if (typeof ref === "function") ref(node)
            else if (ref) ref.current = node
        },
        onMouseMove: handleMouseMove,
        onMouseLeave: handleMouseLeave,
        onPointerDown: disabled ? undefined : handlePointerDown,
        onClick: disabled ? undefined : handleClick,
        whileTap: disabled ? undefined : { x: s.offset, y: s.offset, boxShadow: pressShadow, transition: { duration: 0.05, ease: "easeOut" } },
        style: {
            x: sx,
            y: sy,
            boxShadow,
            background: v.background,
            color: v.color,
            border: v.border,
            borderRadius: 4,
            padding: s.padding,
            fontSize: s.fontSize,
            cursor: disabled ? "not-allowed" : "pointer",
            opacity: disabled ? 0.55 : 1,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
            fontWeight: 700,
            letterSpacing: "0.01em",
            textTransform: "uppercase",
            fontFamily: 'var(--font-mono, ui-monospace, "SF Mono", Menlo, monospace)',
            userSelect: "none",
            position: "relative",
            overflow: "hidden",
            transition: "background 140ms ease",
        },
        "aria-label": ariaLabel,
        "aria-disabled": disabled || undefined,
        ...rest,
    }

    const RippleLayer = (
        <span
            aria-hidden="true"
            style={{
                position: "absolute",
                inset: 0,
                pointerEvents: "none",
                overflow: "hidden",
                display: "block",
                zIndex: 0,
            }}
        >
            {ripples.map((r) => (
                <motion.span
                    key={r.id}
                    initial={{ opacity: 0.95, scale: 0 }}
                    animate={{ opacity: 0, scale: 1 }}
                    transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
                    style={{
                        position: "absolute",
                        left: r.x - r.size / 2,
                        top: r.y - r.size / 2,
                        width: r.size,
                        height: r.size,
                        borderRadius: "50%",
                        background: `radial-gradient(circle, ${v.rippleColor} 0%, ${v.rippleColor} 35%, transparent 70%)`,
                        display: "block",
                        pointerEvents: "none",
                    }}
                />
            ))}
        </span>
    )

    const childContent = (
        <>
            {RippleLayer}
            <span style={{ position: "relative", display: "inline-flex", alignItems: "center", gap: 8 }}>
                {children}
            </span>
        </>
    )

    if (Component) {
        const Tag = motion(Component)
        return (
            <Tag {...motionProps} href={href}>
                {childContent}
            </Tag>
        )
    }

    if (href) {
        return (
            <motion.a {...motionProps} href={href}>
                {childContent}
            </motion.a>
        )
    }

    return (
        <motion.button type={type} {...motionProps} disabled={disabled}>
            {childContent}
        </motion.button>
    )
})

export default NeoButton
