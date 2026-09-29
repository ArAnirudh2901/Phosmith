"use client"

import React, { useState, useEffect, useRef, useCallback } from "react"
import { motion } from "framer-motion"
import {
    Copy, Trash2, FlipHorizontal, FlipVertical, RotateCw,
    Lock, Unlock, Palette, Wand2,
} from "lucide-react"
import { useCanvas } from "../../../../../../context/context"

const GAP = 14              // space between the object's bounds and the bar
const EDGE = 8              // minimum distance from the viewport edge

/**
 * Floating actions for the selected object.
 *
 * Position is written straight to the DOM, never through React state: it is
 * recomputed on every canvas render (pan, zoom, resize, object drag), and a
 * setState there would re-render the whole editor tree per frame.
 */
const ContextualActionBar = () => {
    const { canvasEditor, onToolChange } = useCanvas()
    const [selectedObject, setSelectedObject] = useState(null)
    const [objectType, setObjectType] = useState(null)
    const [isLocked, setIsLocked] = useState(false)

    const hostRef = useRef(null)        // container's screen rect — only moves on resize/scroll
    const objectRef = useRef(null)
    const barRef = useRef(null)
    const placedRef = useRef({ x: null, y: null })
    // Measured, not read per frame: `place` runs inside `after:render`, after this
    // component has already written styles, so an offsetWidth read there forces a
    // reflow on every canvas render — including every step of dragging an object.
    const sizeRef = useRef({ w: 0, h: 0 })

    const readHostRect = useCallback(() => {
        const el = canvasEditor?.upperCanvasEl || canvasEditor?.getElement?.()
        hostRef.current = el?.getBoundingClientRect?.() || null
    }, [canvasEditor])

    /** Place the bar above the selection, flipping below it when there is no room. */
    const place = useCallback(() => {
        const node = barRef.current
        const object = objectRef.current
        const canvas = canvasEditor
        const host = hostRef.current
        if (!node || !object || !canvas || !host) return

        const [a, b, c, d, e, f] = canvas.viewportTransform || [1, 0, 0, 1, 0, 0]
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
        for (const p of object.getCoords()) {
            const x = a * p.x + c * p.y + e
            const y = b * p.x + d * p.y + f
            if (x < minX) minX = x
            if (x > maxX) maxX = x
            if (y < minY) minY = y
            if (y > maxY) maxY = y
        }
        if (!Number.isFinite(minX) || !Number.isFinite(minY)) return

        const { w, h } = sizeRef.current
        const half = w / 2

        let x = host.left + (minX + maxX) / 2
        x = Math.min(Math.max(x, half + EDGE), window.innerWidth - half - EDGE)

        let y = host.top + minY - GAP - h
        if (y < EDGE) y = host.top + maxY + GAP
        y = Math.min(Math.max(y, EDGE), window.innerHeight - h - EDGE)

        x = Math.round(x)
        y = Math.round(y)
        if (placedRef.current.x === x && placedRef.current.y === y) return
        placedRef.current = { x, y }
        node.style.left = `${x}px`
        node.style.top = `${y}px`
    }, [canvasEditor])

    useEffect(() => {
        if (!canvasEditor) return
        const onSelection = () => {
            const active = canvasEditor.getActiveObject()
            // Tool helpers (extender frame, overlays) are not user objects.
            if (active && !active._isExpansionFrame && !active.excludeFromExport) {
                objectRef.current = active
                placedRef.current = { x: null, y: null }
                setSelectedObject(active)
                setObjectType(active.type?.toLowerCase() || 'unknown')
                setIsLocked(!!active.lockMovementX)
                readHostRect()
                place()
            } else {
                objectRef.current = null
                setSelectedObject(null)
                setObjectType(null)
            }
        }
        const onViewportChange = () => { readHostRect(); place() }

        canvasEditor.on('selection:created', onSelection)
        canvasEditor.on('selection:updated', onSelection)
        canvasEditor.on('selection:cleared', onSelection)
        canvasEditor.on('after:render', place)
        window.addEventListener('resize', onViewportChange)
        window.addEventListener('scroll', onViewportChange, true)
        onSelection()
        return () => {
            canvasEditor.off('selection:created', onSelection)
            canvasEditor.off('selection:updated', onSelection)
            canvasEditor.off('selection:cleared', onSelection)
            canvasEditor.off('after:render', place)
            window.removeEventListener('resize', onViewportChange)
            window.removeEventListener('scroll', onViewportChange, true)
        }
    }, [canvasEditor, place, readHostRect])

    // The bar mounts after the selection lands, and its width changes with the
    // button set, so its size is only knowable here.
    useEffect(() => {
        if (!selectedObject || !barRef.current) return
        sizeRef.current = { w: barRef.current.offsetWidth, h: barRef.current.offsetHeight }
        placedRef.current = { x: null, y: null }
        readHostRect()
        place()
    }, [selectedObject, objectType, isLocked, place, readHostRect])

    // The canvas host also moves when a tool panel opens or the sidebar resizes,
    // neither of which fires a window resize.
    useEffect(() => {
        const el = canvasEditor?.upperCanvasEl || canvasEditor?.getElement?.()
        if (!el || typeof ResizeObserver === 'undefined') return
        const ro = new ResizeObserver(() => { readHostRect(); place() })
        ro.observe(el)
        return () => ro.disconnect()
    }, [canvasEditor, place, readHostRect])

    const handleFlipH = () => {
        if (!selectedObject || !canvasEditor) return
        selectedObject.set('flipX', !selectedObject.flipX)
        canvasEditor.requestRenderAll()
    }
    const handleFlipV = () => {
        if (!selectedObject || !canvasEditor) return
        selectedObject.set('flipY', !selectedObject.flipY)
        canvasEditor.requestRenderAll()
    }
    const handleRotate = () => {
        if (!selectedObject || !canvasEditor) return
        selectedObject.set('angle', (selectedObject.angle || 0) + 90)
        selectedObject.setCoords()
        canvasEditor.requestRenderAll()
    }
    const handleDelete = () => {
        if (!selectedObject || !canvasEditor) return
        canvasEditor.remove(selectedObject)
        canvasEditor.discardActiveObject()
        canvasEditor.requestRenderAll()
    }
    const handleDuplicate = () => {
        if (!selectedObject || !canvasEditor) return
        selectedObject.clone().then((cloned) => {
            cloned.set({ left: (cloned.left || 0) + 20, top: (cloned.top || 0) + 20 })
            canvasEditor.add(cloned)
            canvasEditor.setActiveObject(cloned)
            canvasEditor.requestRenderAll()
        })
    }
    const handleLock = () => {
        if (!selectedObject || !canvasEditor) return
        const next = !isLocked
        // selectable/evented stay true: an object that deselects itself on lock
        // can never be re-selected, so the lock would be one-way.
        selectedObject.set({
            lockMovementX: next, lockMovementY: next,
            lockRotation: next, lockScalingX: next, lockScalingY: next,
            hasControls: !next,
        })
        setIsLocked(next)
        canvasEditor.requestRenderAll()
    }

    return (
        selectedObject && (
            // No AnimatePresence: its exit pass kept this node mounted with opacity 0
            // and pointer-events on, so a deselected bar went on swallowing clicks.
            // The outer node owns position (glass-panel forces position: relative,
            // so it cannot be the positioned one) and the entrance animation.
            <motion.div
                ref={barRef}
                className="fixed z-40"
                style={{ left: 0, top: 0, x: '-50%', pointerEvents: 'auto' }}
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ type: 'spring', stiffness: 500, damping: 30 }}
            >
                <div
                    className="flex items-center gap-1 px-2 py-1.5 rounded-xl shadow-[0_8px_32px_rgba(0,0,0,0.5)] glass-panel border-[var(--glass-border)]"
                    style={{ backdropFilter: 'blur(28px) saturate(1.6)', WebkitBackdropFilter: 'blur(28px) saturate(1.6)' }}
                >
                    <div className="px-2 py-0.5 rounded-lg text-[9px] font-semibold uppercase tracking-wider mr-1 pill-control"
                        style={{ background: 'rgba(6,184,212,0.12)', border: '1px solid rgba(6,184,212,0.2)', color: 'var(--accent-ink)' }}>
                        {objectType}
                    </div>
                    <div className="w-px h-5 rounded-full" style={{ background: 'var(--border-subtle)' }} />
                    <ActionButton icon={RotateCw} title="Rotate 90°" onClick={handleRotate} />
                    <ActionButton icon={FlipHorizontal} title="Flip H" onClick={handleFlipH} />
                    <ActionButton icon={FlipVertical} title="Flip V" onClick={handleFlipV} />
                    <div className="w-px h-5 rounded-full" style={{ background: 'var(--border-subtle)' }} />
                    <ActionButton icon={Copy} title="Duplicate" onClick={handleDuplicate} />
                    <ActionButton
                        icon={isLocked ? Unlock : Lock}
                        title={isLocked ? "Unlock" : "Lock"}
                        onClick={handleLock}
                    />
                    <ActionButton icon={Trash2} title="Delete" onClick={handleDelete} isDestructive />
                    {objectType === 'image' && (
                        <>
                            <div className="w-px h-5 rounded-full" style={{ background: 'var(--border-subtle)' }} />
                            <ActionButton icon={Palette} title="AI BG" onClick={() => onToolChange?.("ai_background")} />
                            <ActionButton icon={Wand2} title="ImageKit Agent" onClick={() => onToolChange?.("ai_agent")} />
                        </>
                    )}
                </div>
            </motion.div>
        )
    )
}

const ActionButton = ({ icon: Icon, title, onClick, isDestructive = false }) => {
    const [isHovered, setIsHovered] = useState(false)
    return (
        <motion.button
            className="flex items-center justify-center w-7 h-7 rounded-full"
            style={{
                // Intentionally NOT using .pill-control — that class injects 16px
                // horizontal padding which exceeds the 28px button width, clipping
                // the icon to invisibility via overflow:hidden. Plain inline styling
                // here keeps the icon centered and visible.
                padding: 0,
                background: isHovered
                    ? isDestructive ? 'rgba(244,63,94,0.15)' : 'rgba(255,255,255,0.08)'
                    : 'transparent',
                color: isHovered
                    ? isDestructive ? 'var(--accent-destructive, #f43f5e)' : '#ffffff'
                    : 'var(--text-secondary, #C7C3B5)',
                border: isHovered ? '1px solid rgba(255,255,255,0.18)' : '1px solid transparent',
                cursor: 'pointer',
                flexShrink: 0,
            }}
            onClick={onClick}
            onMouseEnter={() => setIsHovered(true)}
            onMouseLeave={() => setIsHovered(false)}
            whileTap={{ scale: 0.9 }}
            title={title}
            aria-label={title}
        >
            <Icon className="h-3.5 w-3.5" strokeWidth={2} />
        </motion.button>
    )
}

export default ContextualActionBar
