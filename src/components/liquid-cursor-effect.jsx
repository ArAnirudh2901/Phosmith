"use client"

import dynamic from "next/dynamic"
import { usePathname } from "next/navigation"
import { useReducedMotion } from "@/lib/motion"

/**
 * Gate for the WebGL cursor effect. The canvas itself is ~600 lines of shader
 * setup and only ever runs on the landing page, but this component is mounted by
 * the root layout — a static import would ship it to /dashboard and /editor too.
 * next/dynamic fetches it when it is first rendered, which is the one route that
 * shows it.
 *
 * Not a hand-rolled `useState` + `import()`: a state setter given a function
 * treats it as an updater, so `setCanvas(mod.default)` CALLS the component
 * outside a render and every hook in it throws.
 */
const LiquidCursorCanvas = dynamic(() => import("@/components/liquid-cursor-canvas"), { ssr: false })

export default function LiquidCursorEffect() {
    const pathname = usePathname()
    const reduced = useReducedMotion()
    if (pathname !== "/" || reduced) return null
    return <LiquidCursorCanvas />
}
