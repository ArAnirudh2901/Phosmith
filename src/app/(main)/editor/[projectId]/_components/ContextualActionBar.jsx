"use client"

import React, { useState, useEffect, useRef } from "react"
import { motion, AnimatePresence } from "framer-motion"
import {
    Copy, Trash2, FlipHorizontal, FlipVertical, RotateCw,
    Layers, Eye, EyeOff, Lock, Unlock, Move, Scale, Palette, Wand2,
} from "lucide-react"
import { useCanvas } from "../../../../../../context/context"

const ContextualActionBar = ({ visible = false, position = { x: 0, y: 0 } }) => {
    const { canvasEditor, onToolChange } = useCanvas()
    const [selectedObject, setSelectedObject] = useState(null)
    const [objectType, setObjectType] = useState(null)

    useEffect(() => {
        if (!canvasEditor) return
        const handleSelection = () => {
            const activeObject = canvasEditor.getActiveObject()
            if (activeObject) {
                setSelectedObject(activeObject)
                setObjectType(activeObject.type?.toLowerCase() || 'unknown')
            } else {
                setSelectedObject(null)
                setObjectType(null)
            }
        }
        canvasEditor.on('selection:created', handleSelection)
        canvasEditor.on('selection:updated', handleSelection)
        canvasEditor.on('selection:cleared', handleSelection)
        return () => {
            canvasEditor.off('selection:created', handleSelection)
            canvasEditor.off('selection:updated', handleSelection)
            canvasEditor.off('selection:cleared', handleSelection)
        }
    }, [canvasEditor])

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
        const isLocked = selectedObject.lockMovementX
        selectedObject.set({
            lockMovementX: !isLocked, lockMovementY: !isLocked,
            lockRotation: !isLocked, lockScalingX: !isLocked, lockScalingY: !isLocked,
            selectable: isLocked, evented: isLocked,
        })
        canvasEditor.requestRenderAll()
    }

    if (!visible || !selectedObject) return null

    return (
        <AnimatePresence>
            <motion.div
                className="fixed z-40"
                style={{ left: position.x, top: position.y, transform: 'translateX(-50%)' }}
                initial={{ opacity: 0, y: -10, scale: 0.95 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -10, scale: 0.95 }}
                transition={{ type: 'spring', stiffness: 500, damping: 30 }}
            >
                <div className="flex items-center gap-1 px-2 py-1.5 rounded-xl shadow-[0_8px_32px_rgba(0,0,0,0.5)] glass-panel border-[var(--glass-border)]"
                    style={{ backdropFilter: 'blur(28px) saturate(1.6)', WebkitBackdropFilter: 'blur(28px) saturate(1.6)' }}>
                    <div className="px-2 py-0.5 rounded-lg text-[9px] font-semibold uppercase tracking-wider mr-1 pill-control"
                        style={{ background: 'rgba(6,184,212,0.12)', border: '1px solid rgba(6,184,212,0.2)', color: 'var(--accent-ink)' }}>
                        {objectType}
                    </div>
                    <div className="w-px h-5 rounded-full" style={{ background: 'var(--border-subtle)' }} />
                    <ActionButton icon={Move} title="Move" />
                    <ActionButton icon={Scale} title="Resize" />
                    <ActionButton icon={RotateCw} title="Rotate 90°" onClick={handleRotate} />
                    <ActionButton icon={FlipHorizontal} title="Flip H" onClick={handleFlipH} />
                    <ActionButton icon={FlipVertical} title="Flip V" onClick={handleFlipV} />
                    <div className="w-px h-5 rounded-full" style={{ background: 'var(--border-subtle)' }} />
                    <ActionButton icon={Copy} title="Duplicate" onClick={handleDuplicate} />
                    <ActionButton icon={Lock} title="Lock" onClick={handleLock} />
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
        </AnimatePresence>
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
