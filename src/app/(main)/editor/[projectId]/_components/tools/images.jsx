"use client"

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useCanvas } from '../../../../../../../context/context'
import {
    Copy,
    Eye,
    EyeOff,
    FlipHorizontal,
    FlipVertical,
    ImagePlus,
    Lock,
    MoveDown,
    MoveUp,
    Replace,
    Trash2,
    Unlock,
} from 'lucide-react'
import { FabricImage } from 'fabric'
import { ProRulerSlider } from '@/components/editor/ProRulerSlider'
import { addImageFileToCanvas } from '@/lib/canvas-images'
import { toast } from 'sonner'
import { motion, AnimatePresence } from 'framer-motion'

const isImageObject = (obj) => obj?.type?.toLowerCase() === 'image'

const getImageThumbSrc = (img) => {
    try {
        const el = img?.getElement?.() || img?._element || img?._originalElement
        if (el?.src && !el.src.startsWith('data:')) return el.src
        if (el?.toDataURL) return el.toDataURL('image/jpeg', 0.3)
        return null
    } catch {
        return null
    }
}

const ImageManager = ({ project, dominantColor }) => {
    const { canvasEditor } = useCanvas()
    const replaceInputRef = useRef(null)
    const [images, setImages] = useState([])
    const [selectedImage, setSelectedImage] = useState(null)
    const [opacity, setOpacity] = useState(100)
    const [, setRevision] = useState(0)

    const bump = useCallback(() => setRevision(v => v + 1), [])

    const syncImages = useCallback(() => {
        if (!canvasEditor) return
        const all = canvasEditor.getObjects().filter(isImageObject)
        setImages(all)

        const active = canvasEditor.getActiveObject()
        if (active && isImageObject(active)) {
            setSelectedImage(active)
            setOpacity(Math.round((active.opacity ?? 1) * 100))
        } else {
            setSelectedImage(null)
        }
    }, [canvasEditor])

    useEffect(() => {
        if (!canvasEditor) return
        syncImages()
        const events = ['object:added', 'object:removed', 'object:modified', 'selection:created', 'selection:updated', 'selection:cleared']
        events.forEach(e => canvasEditor.on(e, syncImages))
        return () => events.forEach(e => canvasEditor.off(e, syncImages))
    }, [canvasEditor, syncImages])

    const addImageFromFile = useCallback(
        (file) => addImageFileToCanvas(canvasEditor, file, project),
        [canvasEditor, project]
    )

    const handlePaste = useCallback((e) => {
        const items = e.clipboardData?.items
        if (!items) return
        for (const item of items) {
            if (item.type.startsWith('image/')) {
                e.preventDefault()
                addImageFromFile(item.getAsFile())
                break
            }
        }
    }, [addImageFromFile])

    useEffect(() => {
        window.addEventListener('paste', handlePaste)
        return () => window.removeEventListener('paste', handlePaste)
    }, [handlePaste])

    const selectImage = (img) => {
        if (!canvasEditor) return
        canvasEditor.setActiveObject(img)
        canvasEditor.requestRenderAll()
    }

    const deleteImage = () => {
        if (!canvasEditor || !selectedImage) return
        canvasEditor.remove(selectedImage)
        canvasEditor.discardActiveObject()
        canvasEditor.requestRenderAll()
        canvasEditor.__pushHistoryState?.()
        setSelectedImage(null)
    }

    const duplicateImage = async () => {
        if (!canvasEditor || !selectedImage) return
        try {
            const cloned = await selectedImage.clone()
            cloned.set({ left: (selectedImage.left || 0) + 20, top: (selectedImage.top || 0) + 20 })
            cloned.setCoords()
            canvasEditor.add(cloned)
            canvasEditor.setActiveObject(cloned)
            canvasEditor.requestRenderAll()
            canvasEditor.__pushHistoryState?.()
            toast.success('Image duplicated')
        } catch {
            toast.error('Failed to duplicate')
        }
    }

    const replaceImage = async (file) => {
        if (!canvasEditor || !selectedImage || !file) return
        try {
            const url = URL.createObjectURL(file)
            const newImg = await FabricImage.fromURL(url, { crossOrigin: 'anonymous' })
            newImg.set({
                left: selectedImage.left,
                top: selectedImage.top,
                originX: selectedImage.originX,
                originY: selectedImage.originY,
                scaleX: selectedImage.scaleX,
                scaleY: selectedImage.scaleY,
                angle: selectedImage.angle,
                opacity: selectedImage.opacity,
                flipX: selectedImage.flipX,
                flipY: selectedImage.flipY,
            })
            newImg.setCoords()
            const idx = canvasEditor.getObjects().indexOf(selectedImage)
            canvasEditor.remove(selectedImage)
            canvasEditor.insertAt(idx, newImg)
            canvasEditor.setActiveObject(newImg)
            canvasEditor.requestRenderAll()
            canvasEditor.__pushHistoryState?.()
            toast.success('Image replaced')
        } catch {
            toast.error('Failed to replace image')
        }
    }

    const setImageOpacity = (val) => {
        if (!selectedImage) return
        const v = Math.max(0, Math.min(100, val))
        setOpacity(v)
        selectedImage.set('opacity', v / 100)
        canvasEditor?.requestRenderAll()
    }

    const flipH = () => {
        if (!selectedImage) return
        selectedImage.set('flipX', !selectedImage.flipX)
        canvasEditor?.requestRenderAll()
        canvasEditor?.__pushHistoryState?.()
    }

    const flipV = () => {
        if (!selectedImage) return
        selectedImage.set('flipY', !selectedImage.flipY)
        canvasEditor?.requestRenderAll()
        canvasEditor?.__pushHistoryState?.()
    }

    const bringForward = () => {
        if (!canvasEditor || !selectedImage) return
        canvasEditor.bringObjectForward(selectedImage)
        canvasEditor.requestRenderAll()
        canvasEditor.__pushHistoryState?.()
        bump()
    }

    const sendBackward = () => {
        if (!canvasEditor || !selectedImage) return
        canvasEditor.sendObjectBackwards(selectedImage)
        canvasEditor.requestRenderAll()
        canvasEditor.__pushHistoryState?.()
        bump()
    }

    const toggleVisibility = (img) => {
        img.set('visible', !img.visible)
        canvasEditor?.requestRenderAll()
        bump()
    }

    const toggleLock = (img) => {
        const locked = !img.lockMovementX
        img.set({
            lockMovementX: locked,
            lockMovementY: locked,
            lockScalingX: locked,
            lockScalingY: locked,
            lockRotation: locked,
            hasControls: !locked,
        })
        canvasEditor?.requestRenderAll()
        bump()
    }

    if (!canvasEditor) {
        return (
            <div className="p-4">
                <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Canvas not ready</p>
            </div>
        )
    }

    return (
        <div className="space-y-4 overflow-y-auto pr-1 panel-scroll">
            {/* Layer List */}
            <div className="space-y-2" style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: '12px' }}>
                <label className="panel-label">Layers ({images.length})</label>
                <AnimatePresence initial={false}>
                    {images.length === 0 && (
                        <motion.p
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            className="text-[11px] py-2"
                            style={{ color: 'var(--text-muted)' }}
                        >
                            No images on canvas yet.
                        </motion.p>
                    )}
                    {[...images].reverse().map((img, idx) => {
                        const isSelected = img === selectedImage
                        const isLocked = img.lockMovementX
                        const isHidden = img.visible === false
                        const thumb = getImageThumbSrc(img)

                        return (
                            <motion.div
                                key={img.__uid || `img-${idx}`}
                                role="button"
                                tabIndex={0}
                                onClick={() => selectImage(img)}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter' || e.key === ' ') {
                                        e.preventDefault()
                                        selectImage(img)
                                    }
                                }}
                                initial={{ opacity: 0, y: 6 }}
                                animate={{ opacity: 1, y: 0 }}
                                exit={{ opacity: 0, y: -6 }}
                                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left editor-interactive cursor-pointer"
                                style={{
                                    background: isSelected ? 'rgba(0,229,255,0.08)' : 'transparent',
                                    border: `1px solid ${isSelected ? 'var(--accent-primary)' : 'var(--border-subtle)'}`,
                                    opacity: isHidden ? 0.4 : 1,
                                }}
                            >
                                {thumb ? (
                                    <img
                                        src={thumb}
                                        alt=""
                                        className="h-8 w-8 rounded object-cover shrink-0"
                                        style={{ border: '1px solid var(--border-default)' }}
                                    />
                                ) : (
                                    <div className="h-8 w-8 rounded shrink-0 flex items-center justify-center"
                                         style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-default)' }}>
                                        <ImagePlus className="h-3 w-3" style={{ color: 'var(--text-muted)' }} />
                                    </div>
                                )}
                                <span className="text-[11px] font-medium flex-1 truncate" style={{ color: 'var(--text-primary)' }}>
                                    Image {images.length - idx}
                                </span>
                                <button
                                    type="button"
                                    onClick={(e) => { e.stopPropagation(); toggleVisibility(img) }}
                                    className="p-1 rounded editor-interactive shrink-0"
                                    title={isHidden ? 'Show' : 'Hide'}
                                >
                                    {isHidden
                                        ? <EyeOff className="h-3 w-3" style={{ color: 'var(--text-muted)' }} />
                                        : <Eye className="h-3 w-3" style={{ color: 'var(--text-secondary)' }} />
                                    }
                                </button>
                                <button
                                    type="button"
                                    onClick={(e) => { e.stopPropagation(); toggleLock(img) }}
                                    className="p-1 rounded editor-interactive shrink-0"
                                    title={isLocked ? 'Unlock' : 'Lock'}
                                >
                                    {isLocked
                                        ? <Lock className="h-3 w-3" style={{ color: 'var(--accent-warning, #f59e0b)' }} />
                                        : <Unlock className="h-3 w-3" style={{ color: 'var(--text-muted)' }} />
                                    }
                                </button>
                            </motion.div>
                        )
                    })}
                </AnimatePresence>
            </div>

            {/* Selected Image Properties */}
            {selectedImage && (
                <div className="space-y-4" style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: '12px' }}>
                    <label className="panel-label">Properties</label>

                    {/* Opacity */}
                    <div className="space-y-1.5">
                        <label className="text-[10px]" style={{ color: 'var(--text-muted)' }}>Opacity</label>
                        <ProRulerSlider
                            label="Opacity"
                            value={opacity}
                            min={0}
                            max={100}
                            step={1}
                            suffix="%"
                            onChange={setImageOpacity}
                            onChangeEnd={() => canvasEditor?.__pushHistoryState?.()}
                            visual={{
                                fill: 'rgba(47, 143, 203, 0.45)',
                                accent: dominantColor || '#5eb8ff',
                                trackBg: 'rgba(18, 22, 30, 0.96)',
                            }}
                        />
                    </div>

                    {/* Actions grid */}
                    <div className="grid grid-cols-2 gap-1.5">
                        {[
                            { icon: FlipHorizontal, label: 'Flip H', action: flipH },
                            { icon: FlipVertical, label: 'Flip V', action: flipV },
                            { icon: MoveUp, label: 'Forward', action: bringForward },
                            { icon: MoveDown, label: 'Backward', action: sendBackward },
                            { icon: Copy, label: 'Duplicate', action: duplicateImage },
                            { icon: Replace, label: 'Replace', action: () => replaceInputRef.current?.click() },
                        ].map(({ icon: Icon, label, action }) => (
                            <button
                                key={label}
                                type="button"
                                onClick={action}
                                className="flex items-center justify-center gap-1.5 h-8 rounded-lg text-[11px] font-medium editor-interactive"
                                style={{
                                    background: 'var(--bg-elevated)',
                                    border: '1px solid var(--border-subtle)',
                                    color: 'var(--text-secondary)',
                                }}
                            >
                                <Icon className="h-3.5 w-3.5" />
                                {label}
                            </button>
                        ))}
                    </div>

                    <input
                        ref={replaceInputRef}
                        type="file"
                        accept="image/*"
                        onChange={(e) => {
                            if (e.target.files?.[0]) replaceImage(e.target.files[0])
                            e.target.value = ''
                        }}
                        className="hidden"
                    />

                    {/* Delete */}
                    <button
                        type="button"
                        onClick={deleteImage}
                        className="flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2 text-xs font-medium editor-interactive"
                        style={{ background: 'rgba(239, 68, 68, 0.08)', color: '#f87171', border: '1px solid rgba(239, 68, 68, 0.2)' }}
                    >
                        <Trash2 className="h-3.5 w-3.5" />
                        Delete Image
                    </button>
                </div>
            )}

            <div className="panel-card text-[11px]" style={{ borderColor: 'rgba(0, 229, 255, 0.1)' }}>
                <p className="font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>Tips</p>
                <div className="space-y-1" style={{ color: 'var(--text-muted)' }}>
                    <p>• Paste images from clipboard with ⌘V</p>
                    <p>• Drag & drop images onto the canvas</p>
                    <p>• Use layers to reorder and manage images</p>
                    <p>• Lock layers to prevent accidental edits</p>
                </div>
            </div>
        </div>
    )
}

export default ImageManager
