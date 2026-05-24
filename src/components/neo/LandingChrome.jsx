"use client"

import React, { useEffect, useState } from "react"

const ScrollProgress = () => {
    const [progress, setProgress] = useState(0)

    useEffect(() => {
        if (typeof window === "undefined") return
        const update = () => {
            const max = document.documentElement.scrollHeight - window.innerHeight
            const ratio = max > 0 ? Math.min(1, window.scrollY / max) : 0
            setProgress(ratio)
        }
        update()
        window.addEventListener("scroll", update, { passive: true })
        window.addEventListener("resize", update)
        return () => {
            window.removeEventListener("scroll", update)
            window.removeEventListener("resize", update)
        }
    }, [])

    return (
        <div
            aria-hidden="true"
            style={{
                position: "fixed",
                top: 0,
                left: 0,
                width: "100%",
                height: 3,
                zIndex: 100,
                pointerEvents: "none",
                background: "transparent",
            }}
        >
            <div
                style={{
                    height: "100%",
                    width: `${progress * 100}%`,
                    background: "linear-gradient(90deg, #06B8D4, #A8794E)",
                    transformOrigin: "left",
                    boxShadow: "0 0 12px rgba(6,184,212,0.6)",
                    transition: "width 60ms linear",
                }}
            />
        </div>
    )
}

export default function LandingChrome() {
    return <ScrollProgress />
}
