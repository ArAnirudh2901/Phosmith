"use client"

import React, { useEffect, useRef, useState } from "react"

const CHARSET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ!@#$%&*+=/<>?"

const ScrambleText = ({
    text,
    durationMs = 900,
    cyclesPerLetter = 4,
    startOnView = true,
    delay = 0,
    className = "",
    style = {},
    as = "span",
}) => {
    const [output, setOutput] = useState(text)
    const [armed, setArmed] = useState(!startOnView)
    const ref = useRef(null)

    useEffect(() => {
        if (armed) return
        const node = ref.current
        if (!node) return
        const observer = new IntersectionObserver(
            ([entry]) => {
                if (entry.isIntersecting) {
                    setArmed(true)
                    observer.disconnect()
                }
            },
            { threshold: 0.4 }
        )
        observer.observe(node)
        return () => observer.disconnect()
    }, [armed])

    useEffect(() => {
        if (!armed) return
        let raf
        let cancelled = false
        const start = performance.now() + delay
        const total = durationMs
        const target = text

        const tick = (now) => {
            if (cancelled) return
            const elapsed = Math.max(0, now - start)
            const progress = Math.min(1, elapsed / total)
            const revealed = Math.floor(progress * target.length)
            let next = ""
            for (let i = 0; i < target.length; i++) {
                if (i < revealed) {
                    next += target[i]
                } else if (target[i] === " ") {
                    next += " "
                } else {
                    const c = Math.floor(Math.random() * CHARSET.length)
                    next += CHARSET[c]
                }
            }
            setOutput(next)
            if (progress < 1) raf = requestAnimationFrame(tick)
            else setOutput(target)
        }
        raf = requestAnimationFrame(tick)
        return () => {
            cancelled = true
            if (raf) cancelAnimationFrame(raf)
        }
    }, [armed, delay, durationMs, text])

    const Tag = as
    return (
        <Tag ref={ref} className={className} style={style}>
            {output}
        </Tag>
    )
}

export default ScrambleText
