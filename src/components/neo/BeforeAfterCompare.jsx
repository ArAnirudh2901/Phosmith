"use client"

import React, { useCallback, useEffect, useRef, useState } from "react"
import { motion, AnimatePresence } from "framer-motion"
import { ArrowLeftRight, X } from "lucide-react"

const BeforeAfterCompare = ({ open, beforeUrl, afterUrl, beforeLabel = "Before", afterLabel = "After", onClose }) => {
    const containerRef = useRef(null)
    const [position, setPosition] = useState(50)
    const draggingRef = useRef(false)

    useEffect(() => {
        if (open) setPosition(50)
    }, [open])

    const updateFromEvent = useCallback((clientX) => {
        const node = containerRef.current
        if (!node) return
        const rect = node.getBoundingClientRect()
        const pct = ((clientX - rect.left) / rect.width) * 100
        setPosition(Math.max(0, Math.min(100, pct)))
    }, [])

    useEffect(() => {
        if (!open) return

        const onPointerMove = (event) => {
            if (!draggingRef.current) return
            event.preventDefault()
            updateFromEvent(event.clientX)
        }
        const onPointerUp = () => {
            draggingRef.current = false
            document.body.style.cursor = ""
        }
        const onKey = (event) => {
            if (event.key === "Escape") onClose?.()
            if (event.key === "ArrowLeft") setPosition((p) => Math.max(0, p - 2))
            if (event.key === "ArrowRight") setPosition((p) => Math.min(100, p + 2))
        }

        window.addEventListener("pointermove", onPointerMove)
        window.addEventListener("pointerup", onPointerUp)
        window.addEventListener("keydown", onKey)
        return () => {
            window.removeEventListener("pointermove", onPointerMove)
            window.removeEventListener("pointerup", onPointerUp)
            window.removeEventListener("keydown", onKey)
        }
    }, [open, onClose, updateFromEvent])

    if (!open) return null

    return (
        <AnimatePresence>
            <motion.div
                key="backdrop"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.16 }}
                style={{
                    position: "fixed",
                    inset: 0,
                    zIndex: 200,
                    background: "rgba(3, 5, 10, 0.85)",
                    backdropFilter: "blur(8px) saturate(140%)",
                    WebkitBackdropFilter: "blur(8px) saturate(140%)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    padding: 24,
                }}
                onClick={onClose}
            >
                <motion.div
                    key="frame"
                    initial={{ opacity: 0, scale: 0.96 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.96 }}
                    transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
                    onClick={(event) => event.stopPropagation()}
                    style={{
                        position: "relative",
                        maxWidth: "min(95vw, 1280px)",
                        maxHeight: "85vh",
                        width: "100%",
                        background: "#0E1118",
                        border: "2px solid #F4F4F5",
                        boxShadow: "10px 10px 0 0 #06B8D4",
                        padding: 16,
                        display: "flex",
                        flexDirection: "column",
                        gap: 12,
                    }}
                >
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                        <div
                            style={{
                                fontFamily: 'var(--font-mono, ui-monospace, "SF Mono", Menlo, monospace)',
                                fontSize: 12,
                                fontWeight: 800,
                                letterSpacing: "0.16em",
                                textTransform: "uppercase",
                                color: "#F4F4F5",
                                display: "inline-flex",
                                alignItems: "center",
                                gap: 10,
                            }}
                        >
                            <ArrowLeftRight className="h-4 w-4" style={{ color: "#06B8D4" }} strokeWidth={2.5} />
                            Compare · Drag to reveal
                        </div>
                        <button
                            type="button"
                            onClick={onClose}
                            aria-label="Close comparison"
                            style={{
                                width: 32,
                                height: 32,
                                background: "rgba(14,17,24,0.85)",
                                border: "2px solid #F4F4F5",
                                color: "#F4F4F5",
                                display: "inline-flex",
                                alignItems: "center",
                                justifyContent: "center",
                                cursor: "pointer",
                            }}
                        >
                            <X className="h-4 w-4" strokeWidth={2.5} />
                        </button>
                    </div>

                    <div
                        ref={containerRef}
                        onPointerDown={(event) => {
                            draggingRef.current = true
                            document.body.style.cursor = "ew-resize"
                            updateFromEvent(event.clientX)
                        }}
                        style={{
                            position: "relative",
                            width: "100%",
                            flex: 1,
                            minHeight: 320,
                            maxHeight: "calc(85vh - 80px)",
                            overflow: "hidden",
                            border: "2px solid #F4F4F5",
                            background: "#03050A",
                            cursor: "ew-resize",
                            userSelect: "none",
                            touchAction: "none",
                        }}
                    >
                        <img
                            src={beforeUrl}
                            alt={beforeLabel}
                            draggable={false}
                            style={{
                                position: "absolute",
                                inset: 0,
                                width: "100%",
                                height: "100%",
                                objectFit: "contain",
                                pointerEvents: "none",
                            }}
                        />
                        <div
                            style={{
                                position: "absolute",
                                inset: 0,
                                clipPath: `inset(0 ${100 - position}% 0 0)`,
                                pointerEvents: "none",
                            }}
                        >
                            <img
                                src={afterUrl}
                                alt={afterLabel}
                                draggable={false}
                                style={{
                                    position: "absolute",
                                    inset: 0,
                                    width: "100%",
                                    height: "100%",
                                    objectFit: "contain",
                                }}
                            />
                        </div>

                        <div
                            style={{
                                position: "absolute",
                                top: 12,
                                left: 12,
                                padding: "4px 10px",
                                background: "rgba(14,17,24,0.85)",
                                border: "2px solid #F4F4F5",
                                color: "#F4F4F5",
                                fontFamily: 'var(--font-mono, ui-monospace, "SF Mono", Menlo, monospace)',
                                fontSize: 10,
                                fontWeight: 800,
                                letterSpacing: "0.16em",
                                textTransform: "uppercase",
                                pointerEvents: "none",
                            }}
                        >
                            {beforeLabel}
                        </div>
                        <div
                            style={{
                                position: "absolute",
                                top: 12,
                                right: 12,
                                padding: "4px 10px",
                                background: "#06B8D4",
                                border: "2px solid #F4F4F5",
                                color: "#03050A",
                                fontFamily: 'var(--font-mono, ui-monospace, "SF Mono", Menlo, monospace)',
                                fontSize: 10,
                                fontWeight: 800,
                                letterSpacing: "0.16em",
                                textTransform: "uppercase",
                                pointerEvents: "none",
                            }}
                        >
                            {afterLabel}
                        </div>

                        <div
                            style={{
                                position: "absolute",
                                top: 0,
                                bottom: 0,
                                left: `${position}%`,
                                transform: "translateX(-50%)",
                                width: 2,
                                background: "#F4F4F5",
                                pointerEvents: "none",
                            }}
                        />
                        <div
                            style={{
                                position: "absolute",
                                top: "50%",
                                left: `${position}%`,
                                transform: "translate(-50%, -50%)",
                                width: 40,
                                height: 40,
                                background: "#06B8D4",
                                border: "2px solid #F4F4F5",
                                boxShadow: "3px 3px 0 0 #F4F4F5",
                                display: "inline-flex",
                                alignItems: "center",
                                justifyContent: "center",
                                pointerEvents: "none",
                            }}
                        >
                            <ArrowLeftRight className="h-4 w-4" style={{ color: "#03050A" }} strokeWidth={3} />
                        </div>
                    </div>
                </motion.div>
            </motion.div>
        </AnimatePresence>
    )
}

export default BeforeAfterCompare
