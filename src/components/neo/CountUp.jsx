"use client"

import React, { useEffect, useRef, useState } from "react"

const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3)

const CountUp = ({ to, durationMs = 1400, suffix = "", prefix = "", decimals = 0, className = "", style = {} }) => {
    const [display, setDisplay] = useState(0)
    const [armed, setArmed] = useState(false)
    const ref = useRef(null)

    useEffect(() => {
        const node = ref.current
        if (!node) return
        const observer = new IntersectionObserver(
            ([entry]) => {
                if (entry.isIntersecting) {
                    setArmed(true)
                    observer.disconnect()
                }
            },
            { threshold: 0.5 }
        )
        observer.observe(node)
        return () => observer.disconnect()
    }, [])

    useEffect(() => {
        if (!armed) return
        const start = performance.now()
        let raf
        const tick = (now) => {
            const elapsed = now - start
            const t = Math.min(1, elapsed / durationMs)
            const eased = easeOutCubic(t)
            setDisplay(to * eased)
            if (t < 1) raf = requestAnimationFrame(tick)
            else setDisplay(to)
        }
        raf = requestAnimationFrame(tick)
        return () => {
            if (raf) cancelAnimationFrame(raf)
        }
    }, [armed, to, durationMs])

    const formatted = display.toFixed(decimals)

    return (
        <span ref={ref} className={className} style={style}>
            {prefix}
            {formatted}
            {suffix}
        </span>
    )
}

export default CountUp
