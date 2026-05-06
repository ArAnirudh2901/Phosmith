"use client"

import { Button } from '@/components/ui/button'
import { Crop, Maximize, RectangleHorizontal, RectangleVertical, Smartphone, Square } from 'lucide-react'
import React, { useEffect, useState } from 'react'
import { useCanvas } from '../../../../../../../context/context'
import { Rect } from 'fabric'

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
        if (!canvasEditor)
            return

        removeAllCropRectangles()

        if (selectedImage && originalProps) {
            selectedImage.set({
                ...originalProps,
                selectable: originalProps.selectable ?? true,
                evented: originalProps.evented ?? true,
            })
        }

        setCropRect(null)
        setSelectedImage(null)
        setSelectedRatio(null)
        setOriginalProps(null)
        setIsCropMode(false)
        canvasEditor.discardActiveObject()
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
            )
            }
        </div >
    )
}

export default CropContent
