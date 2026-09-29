"use client"

import React, { forwardRef, useCallback, useRef, useState } from "react"
import "./neo-button.css"

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

const MAGNET_PX = 6

let rippleId = 0

// Magnet/press/ripple are CSS (neo-button.css), not framer springs: reached from the
// root layout, so a framer import here lands in every route. Pointer writes
// --neo-dx/--neo-dy onto the node, so cursor tracking costs no React render.
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
        className,
        ...rest
    },
    ref
) {
    const innerRef = useRef(null)
    const v = VARIANTS[variant] || VARIANTS.primary
    const s = SIZES[size] || SIZES.lg

    const [ripples, setRipples] = useState([])

    const setOffset = (dx, dy) => {
        const node = innerRef.current
        if (!node) return
        node.style.setProperty("--neo-dx", `${dx}px`)
        node.style.setProperty("--neo-dy", `${dy}px`)
    }

    const handleMouseMove = (event) => {
        if (!magnetic || disabled) return
        const target = innerRef.current
        if (!target) return
        const rect = target.getBoundingClientRect()
        const dx = (event.clientX - (rect.left + rect.width / 2)) / rect.width
        const dy = (event.clientY - (rect.top + rect.height / 2)) / rect.height
        const clamp = (value) => Math.max(-MAGNET_PX, Math.min(MAGNET_PX, value * MAGNET_PX * 2))
        setOffset(clamp(dx), clamp(dy))
    }

    const handleMouseLeave = () => setOffset(0, 0)

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

    const sharedProps = {
        ref: (node) => {
            innerRef.current = node
            if (typeof ref === "function") ref(node)
            else if (ref) ref.current = node
        },
        className: className ? `neo-button ${className}` : "neo-button",
        onMouseMove: magnetic && !disabled ? handleMouseMove : undefined,
        onMouseLeave: magnetic && !disabled ? handleMouseLeave : undefined,
        onPointerDown: disabled ? undefined : handlePointerDown,
        onClick: disabled ? undefined : handleClick,
        style: {
            "--neo-offset": `${s.offset}px`,
            "--neo-shadow-color": v.shadowColor,
            background: v.background,
            color: v.color,
            border: v.border,
            padding: s.padding,
            fontSize: s.fontSize,
            cursor: disabled ? "not-allowed" : "pointer",
            opacity: disabled ? 0.55 : 1,
        },
        "aria-label": ariaLabel,
        "aria-disabled": disabled || undefined,
        ...rest,
    }

    const childContent = (
        <>
            <span className="neo-button__ripple-layer" aria-hidden="true">
                {ripples.map((r) => (
                    <span
                        key={r.id}
                        className="neo-button__ripple"
                        style={{
                            left: r.x - r.size / 2,
                            top: r.y - r.size / 2,
                            width: r.size,
                            height: r.size,
                            background: `radial-gradient(circle, ${v.rippleColor} 0%, ${v.rippleColor} 35%, transparent 70%)`,
                        }}
                    />
                ))}
            </span>
            <span className="neo-button__label">{children}</span>
        </>
    )

    if (Component) {
        return (
            <Component {...sharedProps} href={href}>
                {childContent}
            </Component>
        )
    }

    if (href) {
        return (
            <a {...sharedProps} href={href}>
                {childContent}
            </a>
        )
    }

    return (
        <button type={type} {...sharedProps} disabled={disabled}>
            {childContent}
        </button>
    )
})

export default NeoButton
