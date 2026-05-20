"use client"

import { Button } from '@/components/ui/button'
import { CheckCheck, Crop, Maximize, RectangleHorizontal, RectangleVertical, Smartphone, Square, X } from 'lucide-react'
import React, { useEffect, useState } from 'react'
import { useCanvas } from '../../../../../../../context/context'
import { FabricImage, Rect } from 'fabric'
import { toast } from 'sonner'

const ASPECT_RATIOS = [
    {
        label: "Freeform",
        value: null,
        icon: Maximize,
    },

    {
        label: "Square",
        value: 1,
        icon: Square,
        ratio: "1:1",
    },

    {
        label: "Widescreen",
        value: 16 / 9,
        icon: RectangleHorizontal,
        ratio: "16:9",
    },

    {
        label: "Portrait",
        value: 4 / 5,
        icon: RectangleVertical,
        ratio: "4:5",
    },

    {
        label: "Story",
        value: 9 / 16,
        icon: Smartphone,
        ratio: "9:16"
    },
]

const CropContent = ({ dominantColor, contrastingColor, lighterColor }) => {

    const { canvasEditor, activeTool } = useCanvas()
    const [selectedImage, setSelectedImage] = useState(null)        // The image being cropped
    const [isCropMode, setIsCropMode] = useState(false)             // Whether crop mode is active
    const [selectedRatio, setSelectedRatio] = useState(null)        // Currently selected aspect ratio
    const [cropRect, setCropRect] = useState(null)                  // The blue crop rectangle overlay
    const [originalProps, setOriginalProps] = useState(null)        // Store original image properties for restoration

    const getActiveImage = (canvasEditor) => {
        if (!canvasEditor)
            return null

        const activeObject = canvasEditor.getActiveObject()

        if (activeObject?.type?.toLowerCase() === "image")
            return activeObject

        return canvasEditor.getObjects().find((obj) => obj.type?.toLowerCase() === "image") ?? null
    }

    const exitCropMode = () => {
        if (!canvasEditor || !isCropMode)
            return

        removeAllCropRectangles()

        if (selectedImage && originalProps) {
            selectedImage.set({
                ...originalProps,
                selectable: originalProps.selectable ?? true,
                evented: originalProps.evented ?? true,
            })
        }

        canvasEditor.setActiveObject(selectedImage)
        setCropRect(null)
        setSelectedImage(null)
        setSelectedRatio(null)
        setOriginalProps(null)
        setIsCropMode(false)
        canvasEditor.discardActiveObject()

        if (canvasEditor)
            canvasEditor.requestRenderAll()
    }

    const removeAllCropRectangles = () => {
        if (!canvasEditor)
            return

        const cropRectangles = canvasEditor
            .getObjects()
            .filter((obj) => obj?.isCropRectangle || obj?.name === "cropRect")

        cropRectangles.forEach((rect) => canvasEditor.remove(rect))
    }

    const createCropRectangle = (image) => {
        const bounds = image.getBoundingRect()

        const cropRectangle = new Rect({
            left: bounds.left + bounds.width * 0.1,
            top: bounds.top + bounds.height * 0.1,
            width: bounds.width * 0.8,
            height: bounds.height * 0.8,
            fill: "transparent",                             // See through interior
            stroke: "#00E5FF",
            strokeWidth: 2,
            strokeDashArray: [5, 5],                         // Dashed line effect
            selectable: true,                                // User can select5 and resize
            evented: true,
            name: "cropRect",                                 // Identifier for this example

            // Visual Styling for the Crop Handles
            cornerColor: "#00E5FF",
            cornerSize: 12,
            transparentCorners: false,
            cornerStyle: "circle",
            borderColor: "#00E5FF",
            borderScaleFactor: 1,

            // Custom property to identify crop rectangles
            isCropRectangle: true,
        })

        cropRectangle.on("scaling", (e) => {
            const rect = e.target

            if (selectedRatio && selectedRatio !== null) {
                const currentRatio = (rect.width * rect.scaleX) / (rect.height * rect.scaleY)

                if (Math.abs(currentRatio - selectedRatio) > 0.01) {
                    const newHeight = (rect.width * rect.scaleX) / selectedRatio / rect.scaleY
                    rect.set("height", newHeight)
                }
            }

            canvasEditor.requestRenderAll()
        })

        canvasEditor.add(cropRectangle)
        canvasEditor.setActiveObject(cropRectangle)
        setCropRect(cropRectangle)
    }

    const initializeCropMode = (image) => {

        if (!image || isCropMode)
            return                                              // Prevent double initialization

        removeAllCropRectangles()

        const original = {
            left: image.left,
            top: image.top,
            width: image.width,
            height: image.height,
            scaleX: image.scaleX,
            scaleY: image.scaleY,
            angle: image.angle,
            selectable: image.selectable,
            evented: image.evented,
        }

        setOriginalProps(original)
        setSelectedImage(image)
        setIsCropMode(true)

        image.set({
            selectable: false,
            evented: false,
        })

        createCropRectangle(image)
        canvasEditor.requestRenderAll()
    }

    const applyAspectRatio = (ratioValue) => {
        if (!canvasEditor || !cropRect || !selectedImage)
            return

        setSelectedRatio(ratioValue)

        const imageBounds = selectedImage.getBoundingRect()
        const insetX = imageBounds.width * 0.1
        const insetY = imageBounds.height * 0.1
        const maxWidth = Math.max(imageBounds.width - insetX * 2, 1)
        const maxHeight = Math.max(imageBounds.height - insetY * 2, 1)

        let nextWidth = maxWidth
        let nextHeight = maxHeight

        if (ratioValue) {
            const maxWidthFromHeight = maxHeight * ratioValue

            if (maxWidthFromHeight <= maxWidth) {
                nextWidth = maxWidthFromHeight
                nextHeight = maxHeight
            } else {
                nextWidth = maxWidth
                nextHeight = maxWidth / ratioValue
            }
        }

        cropRect.set({
            left: imageBounds.left + (imageBounds.width - nextWidth) / 2,
            top: imageBounds.top + (imageBounds.height - nextHeight) / 2,
            width: nextWidth,
            height: nextHeight,
            scaleX: 1,
            scaleY: 1,
        })

        cropRect.setCoords()
        canvasEditor.setActiveObject(cropRect)
        canvasEditor.requestRenderAll()
    }

    const applyCrop = () => {

        if (!canvasEditor || !selectedImage || !cropRect)
            return

        try {
            const cropBounds = cropRect.getBoundingRect()
            const imageBounds = selectedImage.getBoundingRect()

            const cropX = Math.max(0, cropBounds.left - imageBounds.left)
            const cropY = Math.max(0, cropBounds.top - imageBounds.top)
            const cropWidth = Math.min(cropBounds.width, imageBounds.width - cropX)
            const cropHeight = Math.min(cropBounds.height, imageBounds.height - cropY)

            const imageScaleX = selectedImage.scaleX || 1
            const imageScaleY = selectedImage.scaleY || 1

            const actualCropX = cropX / imageScaleX
            const actualCropY = cropY / imageScaleY

            const actualCropWidth = cropWidth / imageScaleX
            const actualCropHeight = cropHeight / imageScaleY

            const croppedImage = new FabricImage(selectedImage._element, {
                left: cropBounds.left + cropBounds.width / 2,
                top: cropBounds.top + cropBounds.height / 2,

                originX: "center",
                originY: "center",
                selectable: true,
                evented: true,

                // Applying CROP using the CROP properties of Fabric.js
                cropX: actualCropX,
                cropY: actualCropY,
                width: actualCropWidth,
                height: actualCropHeight,
                scaleX: imageScaleX,
                scaleY: imageScaleY,
            })

            canvasEditor.remove(selectedImage)
            canvasEditor.add(croppedImage)

            canvasEditor.setActiveObject(croppedImage)
            canvasEditor.requestRenderAll()

            exitCropMode()
        } catch (error) {

            console.error("Error exiting Crop Mode: ", error)
            toast.error("Failed to to apply Crop, please try again")
            exitCropMode()
        }
    }

    useEffect(() => {
        return () => {
            if (isCropMode) {
                const cropRectangles = canvasEditor
                    ?.getObjects()
                    .filter((obj) => obj?.isCropRectangle || obj?.name === "cropRect") ?? []

                cropRectangles.forEach((rect) => canvasEditor.remove(rect))

                if (selectedImage && originalProps) {
                    selectedImage.set({
                        ...originalProps,
                        selectable: originalProps.selectable ?? true,
                        evented: originalProps.evented ?? true,
                    })
                }

                canvasEditor?.requestRenderAll()
            }
        }
    }, [isCropMode, canvasEditor, selectedImage, originalProps])

    if (!canvasEditor) {
        return (
            <div className='p-4'>
                <p className='text-xs' style={{ color: 'var(--text-muted)' }}>
                    Canvas not ready
                </p>
            </div>
        )
    }

    const activeImage = getActiveImage(canvasEditor)

    return (
        <div className='space-y-4'>
            {isCropMode && (
                <div className='panel-card' style={{ borderColor: `${dominantColor || 'rgba(0, 229, 255, 0.3)'}` }}>
                    <p className='text-xs font-medium' style={{ color: dominantColor || 'var(--accent-primary)' }}>
                        ✂️ Crop Mode Active
                    </p>
                    <p className='text-[11px] mt-1' style={{ color: 'var(--text-muted)' }}>
                        Adjust the rectangle to set crop area
                    </p>
                </div>
            )}

            {!isCropMode && activeImage && (
                <button
                    onClick={() => initializeCropMode(activeImage)}
                    className="flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2.5 text-xs font-semibold editor-interactive"
                    style={{
                        background: dominantColor || 'var(--accent-primary)',
                        color: contrastingColor || '#fff',
                        border: 'none',
                        boxShadow: `0 0 30px ${dominantColor}40`
                    }}
                >
                    <Crop className='h-3.5 w-3.5' />
                    Start Crop
                </button>
            )}

            {isCropMode && (
                <div>
                    <label className='panel-label mb-2.5 block'>Aspect Ratios</label>
                    <div className='grid grid-cols-3 gap-1.5'>
                        {ASPECT_RATIOS.map((ratio) => {
                            const IconComponent = ratio.icon
                            const isSelected = selectedRatio === ratio.value

                            return (
                                <button
                                    key={ratio.label}
                                    type="button"
                                    onClick={() => applyAspectRatio(ratio.value)}
                                    className='rounded-lg p-2.5 text-center editor-interactive'
                                    style={{
                                        border: `1px solid ${isSelected ? dominantColor || 'var(--accent-primary)' : 'var(--border-subtle)'}`,
                                        background: isSelected ? `${dominantColor}1a` : 'var(--bg-elevated)',
                                    }}
                                >
                                    <IconComponent className="mx-auto mb-1.5 h-5 w-5" style={{ color: isSelected ? dominantColor || 'var(--accent-primary)' : 'var(--text-secondary)' }} />
                                    <div className="text-[10px] font-medium" style={{ color: isSelected ? contrastingColor || 'var(--text-primary)' : 'var(--text-primary)' }}>
                                        {ratio.label}
                                    </div>
                                    {ratio.ratio && (
                                        <div className="mt-0.5 text-[9px]" style={{ color: 'var(--text-muted)' }}>
                                            {ratio.ratio}
                                        </div>
                                    )}
                                </button>
                            )
                        })}
                    </div>
                </div>
            )}

            {isCropMode && (
                <div className='space-y-2'>
                    <button
                        onClick={applyCrop}
                        className="flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2.5 text-xs font-semibold editor-interactive"
                        style={{ 
                            background: dominantColor || 'var(--accent-primary)', 
                            color: contrastingColor || '#fff', 
                            border: 'none',
                            boxShadow: `0 0 30px ${dominantColor}40` 
                        }}
                    >
                        <CheckCheck className='h-3.5 w-3.5' />
                        Apply Crop
                    </button>

                    <button
                        onClick={() => exitCropMode()}
                        className="flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2 text-xs font-medium editor-interactive"
                        style={{ background: 'var(--bg-elevated)', color: 'var(--text-secondary)', border: '1px solid var(--border-subtle)' }}
                    >
                        <X className='h-3.5 w-3.5' />
                        Cancel
                    </button>
                </div>
            )}

            <div className='panel-card text-[11px]' style={{ borderColor: 'rgba(0, 229, 255, 0.1)' }}>
                <p style={{ color: 'var(--text-muted)' }}>
                    <strong style={{ color: 'var(--text-secondary)' }}>How to crop:</strong>
                    <br />
                    1. Click "Start Cropping"
                    <br />
                    2. Drag the rectangle to select crop area
                    <br />
                    3. Choose aspect ratio (optional)
                    <br />
                    4. Click "Apply Crop" to finalize
                </p>
            </div>
        </div >
    )
}

export default CropContent
