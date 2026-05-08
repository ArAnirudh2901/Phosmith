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

const CropContent = () => {

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
            stroke: "#00bcd4",                                // Cyan border colour
            strokeWidth: 2,
            strokeDashArray: [5, 5],                         // Dashed line effect
            selectable: true,                                // User can select5 and resize
            evented: true,
            name: "cropRect",                                 // Identifier for this example

            // Visual Styling for the Crop Handles
            cornerColor: "#00bcd4",
            cornerSize: 12,
            transparentCorners: false,
            cornerStyle: "circle",
            borderColor: "#00bcd4",
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
                <p className='text-white/70 text-sm'>
                    Canvas not ready
                </p>
            </div>
        )
    }

    const activeImage = getActiveImage(canvasEditor)

    return (
        <div className='space-y-6'>
            {isCropMode && (
                <div className='bg-cyan-500/10 border border-cyan-500/20 rounded-lg p-3'>
                    <p className='text-cyan-400 text-sm font-medium'>
                        ✂️ Crop Mode Active
                    </p>
                    <p className='text-cyan/300/80 text-xs mt-1'>
                        Adjust the blue rectangle to set crop area
                    </p>
                </div>
            )}

            {!isCropMode && activeImage && (
                <Button
                    onClick={() => initializeCropMode(activeImage)}
                    className="w-full"
                    variant="primary"
                >
                    <Crop className='h-4 w-4 mr-2' />
                    Start Cropping
                </Button>
            )}

            {isCropMode && (
                <div>
                    <h3 className='text-sm font-medium text-white mb-3'>
                        Crop Aspect Ratios
                    </h3>
                    <div className='grid grid-cols-3 gap-2'>
                        {ASPECT_RATIOS.map((ratio) => {
                            const IconComponent = ratio.icon
                            const isSelected = selectedRatio === ratio.value

                            return (
                                <button
                                    key={ratio.label}
                                    type="button"
                                    onClick={() => applyAspectRatio(ratio.value)}
                                    className={`rounded-lg border p-3 text-center transition-colors ${isSelected
                                        ? "border-cyan-400 bg-cyan-400/10"
                                        : "border-white/20 hover:border-white/40 hover:bg-white/5"
                                        }`}
                                >
                                    <IconComponent className="mx-auto mb-2 h-6 w-6 text-white" />
                                    <div className="text-xs font-medium text-white">
                                        {ratio.label}
                                    </div>
                                    {ratio.ratio && (
                                        <div className="mt-1 text-[11px] text-white/60">
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
                <div>
                    <Button
                        onClick={applyCrop}
                        className='w-full'
                        variant="primary"
                    >
                        <CheckCheck className='h-4 w-4 mr-2' />
                        Apply Crop
                    </Button>

                    <Button
                        onClick={() => exitCropMode()}
                        variant='outline'
                        className="w-full"
                    >
                        <X className='h-4 w-4 mr-2 ' />
                        Cancel
                    </Button>
                </div>
            )}

            <div className='bg-slate-700/30 rounded-lg p-3'>
                <p className='text-xxs text-white/70'>
                    <strong>How to crop:</strong>
                    <br />
                    1. Click "Start Cropping"
                    <br />
                    2. Drag the blue rectanglet o select crop area
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
