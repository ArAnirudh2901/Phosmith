"use client"

import React, { useRef } from "react"
import "./neo-card.css"

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

    const handleMouseMove = (event) => {
        if (!tilt) return
        const node = ref.current
        if (!node) return
        const rect = node.getBoundingClientRect()
        const px = (event.clientX - rect.left) / rect.width - 0.5
        const py = (event.clientY - rect.top) / rect.height - 0.5
        node.style.setProperty("--tilt-x", `${-py * 2 * maxTilt}deg`)
        node.style.setProperty("--tilt-y", `${px * 2 * maxTilt}deg`)
        node.style.setProperty("--glare-x", `${50 + px * 60}%`)
        node.style.setProperty("--glare-y", `${50 + py * 60}%`)
    }

    const handleMouseLeave = () => {
        const node = ref.current
        if (!node) return
        node.style.setProperty("--tilt-x", "0deg")
        node.style.setProperty("--tilt-y", "0deg")
        node.style.setProperty("--glare-x", "50%")
        node.style.setProperty("--glare-y", "50%")
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
        <div
            ref={ref}
            onMouseMove={handleMouseMove}
            onMouseLeave={handleMouseLeave}
            onClick={onClick}
            className={className ? `neo-card ${className}` : "neo-card"}
            style={{
                border: `1.5px solid ${border}`,
                "--neo-card-accent-wash": `${accent}22`,
                ...surfaceStyle,
                ...style,
            }}
        >
            {tilt && (
                <>
                    {isGlass && <div className="neo-card__glow" aria-hidden="true" />}
                    <div className="neo-card__glare" aria-hidden="true" />
                </>
            )}
            <div className="neo-card__body">{children}</div>
        </div>
    )
}

export default NeoCard
