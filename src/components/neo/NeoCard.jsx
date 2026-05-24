"use client"

import React, { useRef } from "react"
import { motion, useMotionValue, useSpring, useTransform } from "framer-motion"

const NeoCard = ({
    children,
    className = "",
    accent = "#06B8D4",
    background = "#0A0D13",
    border = "rgba(232, 233, 236, 0.85)",
    shadowOffset = 5,
    tilt = true,
    maxTilt = 4,
    material = "solid",
    onClick,
    style = {},
}) => {
    const ref = useRef(null)
    const x = useMotionValue(0)
    const y = useMotionValue(0)
    const sx = useSpring(x, { stiffness: 180, damping: 18, mass: 0.6 })
    const sy = useSpring(y, { stiffness: 180, damping: 18, mass: 0.6 })

    const rotateX = useTransform(sy, [-0.5, 0.5], [maxTilt, -maxTilt])
    const rotateY = useTransform(sx, [-0.5, 0.5], [-maxTilt, maxTilt])
    const glareX = useTransform(sx, [-0.5, 0.5], ["20%", "80%"])
    const glareY = useTransform(sy, [-0.5, 0.5], ["20%", "80%"])
    const glareGradient = useTransform(
        [glareX, glareY],
        ([gx, gy]) =>
            `radial-gradient(circle at ${gx} ${gy}, rgba(255,255,255,0.10), transparent 55%)`
    )
    const accentGlow = useTransform(
        [glareX, glareY],
        ([gx, gy]) =>
            `radial-gradient(220px circle at ${gx} ${gy}, ${accent}22, transparent 70%)`
    )

    const handleMouseMove = (event) => {
        if (!tilt) return
        const node = ref.current
        if (!node) return
        const rect = node.getBoundingClientRect()
        const px = (event.clientX - rect.left) / rect.width - 0.5
        const py = (event.clientY - rect.top) / rect.height - 0.5
        x.set(px)
        y.set(py)
    }

    const handleMouseLeave = () => {
        x.set(0)
        y.set(0)
    }

    const isGlass = material === "glass"

    const surfaceStyle = isGlass
        ? {
            background: `
                linear-gradient(135deg, rgba(255,255,255,0.04), rgba(255,255,255,0.008) 60%),
                linear-gradient(180deg, ${accent}0E, transparent 70%),
                rgba(10, 13, 19, 0.65)
            `,
            backdropFilter: "blur(22px) saturate(160%)",
            WebkitBackdropFilter: "blur(22px) saturate(160%)",
            boxShadow: `
                ${shadowOffset}px ${shadowOffset}px 0 0 ${accent}AA,
                inset 0 1px 0 rgba(255,255,255,0.10),
                inset 0 0 0 1px rgba(255,255,255,0.03)
            `,
        }
        : {
            background,
            boxShadow: `${shadowOffset}px ${shadowOffset}px 0 0 ${accent}AA`,
        }

    return (
        <motion.div
            ref={ref}
            onMouseMove={handleMouseMove}
            onMouseLeave={handleMouseLeave}
            onClick={onClick}
            className={className}
            style={{
                position: "relative",
                border: `1.5px solid ${border}`,
                borderRadius: 4,
                transformStyle: "preserve-3d",
                perspective: 800,
                rotateX: tilt ? rotateX : 0,
                rotateY: tilt ? rotateY : 0,
                ...surfaceStyle,
                ...style,
            }}
        >
            {tilt && (
                <>
                    {isGlass && (
                        <motion.div
                            aria-hidden="true"
                            style={{
                                position: "absolute",
                                inset: 0,
                                pointerEvents: "none",
                                background: accentGlow,
                            }}
                        />
                    )}
                    <motion.div
                        aria-hidden="true"
                        style={{
                            position: "absolute",
                            inset: 0,
                            pointerEvents: "none",
                            background: glareGradient,
                            mixBlendMode: "screen",
                        }}
                    />
                </>
            )}
            <div style={{ position: "relative", zIndex: 1 }}>{children}</div>
        </motion.div>
    )
}

export default NeoCard
