"use client"

import { useEffect, useRef } from "react"

// Scroll reveal without framer-motion. Armed only after JS runs, so the marketing
// copy renders visible before hydration and with JS off.
export function useReveal({ margin = "-10% 0px" } = {}) {
    const ref = useRef(null)

    useEffect(() => {
        const node = ref.current
        if (!node) return undefined
        if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return undefined
        if (typeof IntersectionObserver !== "function") return undefined

        node.classList.add("reveal-armed")
        const observer = new IntersectionObserver(
            (entries) => {
                for (const entry of entries) {
                    if (!entry.isIntersecting) continue
                    entry.target.classList.add("reveal-in")
                    observer.disconnect()
                    return
                }
            },
            { rootMargin: margin },
        )
        observer.observe(node)
        return () => observer.disconnect()
    }, [margin])

    return ref
}

/** Stagger delay, capped so a long grid's last card is not seconds late. */
export const revealDelay = (index, step = 60, max = 300) => ({
    "--rise-delay": `${Math.min(index * step, max)}ms`,
})
