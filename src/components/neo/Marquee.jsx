"use client"

import React from "react"

const Marquee = ({
    items = [],
    speedSeconds = 22,
    direction = "left",
    accent = "#06B8D4",
    borderColor = "#F4F4F5",
    background = "#0E1118",
    height = 64,
}) => {
    const looped = [...items, ...items]
    const animationName = direction === "right" ? "phosmith-marquee-right" : "phosmith-marquee-left"

    return (
        <div
            style={{
                background,
                borderTop: `2px solid ${borderColor}`,
                borderBottom: `2px solid ${borderColor}`,
                overflow: "hidden",
                position: "relative",
                height,
                display: "flex",
                alignItems: "center",
            }}
            aria-hidden="true"
        >
            <div
                style={{
                    display: "flex",
                    whiteSpace: "nowrap",
                    animation: `${animationName} ${speedSeconds}s linear infinite`,
                }}
            >
                {looped.map((item, idx) => (
                    <span
                        key={`${item}-${idx}`}
                        style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 18,
                            paddingLeft: 32,
                            paddingRight: 32,
                            fontFamily: 'var(--font-mono, ui-monospace, "SF Mono", Menlo, monospace)',
                            fontSize: 13,
                            fontWeight: 700,
                            letterSpacing: "0.18em",
                            textTransform: "uppercase",
                            color: idx % 2 === 0 ? "#F4F4F5" : accent,
                        }}
                    >
                        {item}
                        <span style={{ color: accent, fontWeight: 900 }}>◆</span>
                    </span>
                ))}
            </div>
        </div>
    )
}

export default Marquee
