"use client"

import React, { forwardRef, useCallback, useEffect, useRef, useState } from "react"
import { registerMagnet } from "./magnet"
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

// pull: the most the magnet moves the face (px); reach: how far from the edge
// the pointer starts to be felt, so the pull builds up instead of switching on.
const SIZES = {
    md: { padding: "11px 20px", fontSize: 12.5, offset: 3, pull: 5, reach: 56 },
    lg: { padding: "15px 28px", fontSize: 13.5, offset: 4, pull: 6, reach: 64 },
    xl: { padding: "19px 34px", fontSize: 14.5, offset: 5, pull: 7, reach: 72 },
}

let rippleId = 0

// Magnet and press are one shared rAF spring (magnet.js) writing CSS variables,
// the ripple is CSS: no framer here, since the header reaches this from the root
// layout. Cursor tracking costs no React render.
const NeoButton = forwardRef(function NeoButton(
    {
        children,
        variant = "primary",
        size = "lg",
        disabled = false,
        magnetic = true,
        onClick,
        onPointerDown,
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

    // Read by the shared loop every frame, so props stay current without re-registering.
    const cfgRef = useRef(null)
    cfgRef.current = { magnetic, disabled, offset: s.offset, pull: s.pull, reach: s.reach }
    const magnetRef = useRef(null)
    useEffect(() => {
        const node = innerRef.current
        if (!node) return undefined
        const m = registerMagnet(node, () => cfgRef.current)
        magnetRef.current = m
        return () => { m.dispose(); magnetRef.current = null }
    }, [])

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

    // Named, not spread: rest lands after this handler, so a caller's own
    // onPointerDown would replace the ripple instead of running beside it.
    const handlePointerDown = useCallback(
        (event) => {
            if (disabled) return
            onPointerDown?.(event)
            magnetRef.current?.press()
            spawnRipple(event.clientX, event.clientY)
        },
        [disabled, onPointerDown, spawnRipple]
    )

    // The keyboard gets the same press as the pointer.
    const handleKeyDown = (event) => {
        if (disabled || event.repeat || (event.key !== " " && event.key !== "Enter")) return
        magnetRef.current?.press()
    }
    const handleKeyUp = () => magnetRef.current?.release()

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
        onPointerDown: disabled ? undefined : handlePointerDown,
        onKeyDown: handleKeyDown,
        onKeyUp: handleKeyUp,
        onBlur: handleKeyUp,
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
