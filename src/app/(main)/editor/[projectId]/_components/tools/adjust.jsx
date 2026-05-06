"use client"

import { Button } from '@/components/ui/button'
import { Slider } from '@/components/ui/slider'
import { useCanvas } from '../../../../../../../context/context'
import { filters } from 'fabric'
import { RotateCcw } from 'lucide-react'
import React, { useEffect, useRef, useState } from 'react'

const FILTER_CONFIGS = [
    {
        key: "brightness",
        label: "Brightness",
        min: -100,
        max: 100,
        step: 1,
        defaultValue: 0,
        filterClass: filters.Brightness,
        valueKey: "brightness",
        toFilterValue: (value) => value / 100,
        fromFilterValue: (value) => value * 100,
    },
    {
        key: "contrast",
        label: "Contrast",
        min: -100,
        max: 100,
        step: 1,
        defaultValue: 0,
        filterClass: filters.Contrast,
        valueKey: "contrast",
        toFilterValue: (value) => value / 100,
        fromFilterValue: (value) => value * 100,
    },
    {
        key: "saturation",
        label: "Saturation",
        min: -100,
        max: 100,
        step: 1,
        defaultValue: 0,
        filterClass: filters.Saturation,
        valueKey: "saturation",
        toFilterValue: (value) => value / 100,
        fromFilterValue: (value) => value * 100,
    },
    {
        key: "vibrance",
        label: "Vibrance",
        min: -100,
        max: 100,
        step: 1,
        defaultValue: 0,
        filterClass: filters.Vibrance,
        valueKey: "vibrance",
        toFilterValue: (value) => value / 100,
        fromFilterValue: (value) => value * 100,
    },
    {
        key: "blur",
        label: "Blur",
        min: 0,
        max: 100,
        step: 1,
        defaultValue: 0,
        filterClass: filters.Blur,
        valueKey: "blur",
        toFilterValue: (value) => value / 100,
        fromFilterValue: (value) => value * 100,
    },
    {
        key: "hue",
        label: "Hue",
        min: -180,
        max: 180,
        step: 1,
        defaultValue: 0,
        filterClass: filters.HueRotation,
        valueKey: "rotation",
        toFilterValue: (value) => value / 180,
        fromFilterValue: (value) => value * 180,
        suffix: "º",
    },
]

const DEFAULT_VALUES = FILTER_CONFIGS.reduce((acc, config) => {
    acc[config.key] = config.defaultValue
    return acc
}, {})

const getValuesSignature = (values) =>
    FILTER_CONFIGS.map(({ key }) => values[key]).join("|")

const areValuesEqual = (left, right) =>
    FILTER_CONFIGS.every(({ key }) => left[key] === right[key])

const clamp = (value, min, max) => Math.max(min, Math.min(max, value))

const safeRatio = (nextValue, committedValue) => {
    if (committedValue === 0)
        return nextValue === 0 ? 1 : 3

    return nextValue / committedValue
}

const getActiveImage = (canvasEditor) => {
    if (!canvasEditor)
        return null

    const activeObject = canvasEditor.getActiveObject()

    if (activeObject?.type === "image")
        return activeObject

    return canvasEditor.getObjects().find((obj) => obj.type === "image") ?? null
}

const getValuesFromImageFilters = (imageObject) => {
    const nextValues = { ...DEFAULT_VALUES }

    for (const imageFilter of imageObject?.filters ?? []) {
        const config = FILTER_CONFIGS.find(
            ({ filterClass }) => filterClass.type === imageFilter?.type
        )

        if (!config)
            continue

        const rawValue = imageFilter[config.valueKey]
        if (typeof rawValue !== "number")
            continue

        const sliderValue = config.fromFilterValue(rawValue)

        nextValues[config.key] = Math.max(
            config.min,
            Math.min(config.max, Math.round(sliderValue))
        )
    }

    return nextValues
}

const buildFabricFilters = (values) =>
    FILTER_CONFIGS.reduce((acc, config) => {
        const value = values[config.key]

        if (value === config.defaultValue)
            return acc

        acc.push(
            new config.filterClass({
                [config.valueKey]: config.toFilterValue(value),
            })
        )

        return acc
    }, [])

const getPreviewElement = (canvasEditor) =>
    canvasEditor?.lowerCanvasEl ?? canvasEditor?.getElement?.() ?? null

const getRelativeFilter = (nextValues, committedValues) => {
    const nextBrightness = 1 + nextValues.brightness / 100
    const committedBrightness = 1 + committedValues.brightness / 100
    const nextContrast = 1 + nextValues.contrast / 100
    const committedContrast = 1 + committedValues.contrast / 100
    const nextSaturation = 1 + nextValues.saturation / 100 + nextValues.vibrance / 200
    const committedSaturation =
        1 + committedValues.saturation / 100 + committedValues.vibrance / 200
    const blurDelta = Math.max(0, nextValues.blur - committedValues.blur)
    const hueDelta = nextValues.hue - committedValues.hue

    return [
        `brightness(${clamp(safeRatio(nextBrightness, committedBrightness), 0, 3)})`,
        `contrast(${clamp(safeRatio(nextContrast, committedContrast), 0, 3)})`,
        `saturate(${clamp(safeRatio(nextSaturation, committedSaturation), 0, 4)})`,
        `hue-rotate(${hueDelta}deg)`,
        `blur(${blurDelta / 8}px)`,
    ].join(" ")
}

const applyPreviewFilter = (canvasEditor, nextValues, committedValues) => {
    const previewElement = getPreviewElement(canvasEditor)
    if (!previewElement)
        return

    previewElement.style.willChange = "filter"
    previewElement.style.filter = getRelativeFilter(nextValues, committedValues)
}

const clearPreviewFilter = (canvasEditor) => {
    const previewElement = getPreviewElement(canvasEditor)
    if (!previewElement)
        return

    previewElement.style.filter = ""
    previewElement.style.willChange = ""
}

const cancelScheduledCommit = (commitTimeoutRef) => {
    if (commitTimeoutRef.current === null)
        return

    clearTimeout(commitTimeoutRef.current)
    commitTimeoutRef.current = null
}

const applyFiltersToCanvas = (
    canvasEditor,
    values,
    lastAppliedSignatureRef,
    { persist = false } = {}
) => {
    if (!canvasEditor)
        return

    const imageObject = getActiveImage(canvasEditor)
    if (!imageObject)
        return

    const signature = getValuesSignature(values)

    try {
        if (signature !== lastAppliedSignatureRef.current) {
            imageObject.filters = buildFabricFilters(values)
            imageObject.applyFilters()
            imageObject.set("dirty", true)
            canvasEditor.requestRenderAll()
            lastAppliedSignatureRef.current = signature
        }

        if (persist) {
            imageObject.set("dirty", true)
            canvasEditor.fire("object:modified", { target: imageObject })
        }
    } catch (error) {
        console.error("Error applying filters: ", error)
    }
}

const AdjustControls = () => {
    const [filterValues, setFilterValues] = useState(DEFAULT_VALUES)
    const { canvasEditor } = useCanvas()
    const latestFilterValuesRef = useRef(DEFAULT_VALUES)
    const committedFilterValuesRef = useRef(DEFAULT_VALUES)
    const lastAppliedSignatureRef = useRef(getValuesSignature(DEFAULT_VALUES))
    const commitTimeoutRef = useRef(null)

    useEffect(() => {
        if (!canvasEditor)
            return

        const syncFilterValues = () => {
            const imageObject = getActiveImage(canvasEditor)
            const nextValues = imageObject
                ? getValuesFromImageFilters(imageObject)
                : { ...DEFAULT_VALUES }

            clearPreviewFilter(canvasEditor)
            cancelScheduledCommit(commitTimeoutRef)
            latestFilterValuesRef.current = nextValues
            committedFilterValuesRef.current = nextValues
            lastAppliedSignatureRef.current = getValuesSignature(nextValues)
            setFilterValues((currentValues) =>
                areValuesEqual(currentValues, nextValues) ? currentValues : nextValues
            )
        }

        syncFilterValues()

        canvasEditor.on("selection:created", syncFilterValues)
        canvasEditor.on("selection:updated", syncFilterValues)
        canvasEditor.on("selection:cleared", syncFilterValues)
        canvasEditor.on("object:added", syncFilterValues)

        return () => {
            clearPreviewFilter(canvasEditor)
            cancelScheduledCommit(commitTimeoutRef)
            canvasEditor.off("selection:created", syncFilterValues)
            canvasEditor.off("selection:updated", syncFilterValues)
            canvasEditor.off("selection:cleared", syncFilterValues)
            canvasEditor.off("object:added", syncFilterValues)
        }
    }, [canvasEditor])

    const handleValueChange = (filterKey, value) => {
        const nextValue = Array.isArray(value) ? value[0] : value
        const newValues = {
            ...latestFilterValuesRef.current,
            [filterKey]: nextValue,
        }

        if (areValuesEqual(latestFilterValuesRef.current, newValues))
            return

        latestFilterValuesRef.current = newValues
        cancelScheduledCommit(commitTimeoutRef)
        setFilterValues(newValues)
        applyPreviewFilter(canvasEditor, newValues, committedFilterValuesRef.current)
    }

    const scheduleCommit = (nextValues) => {
        cancelScheduledCommit(commitTimeoutRef)

        commitTimeoutRef.current = window.setTimeout(() => {
            commitTimeoutRef.current = null
            applyFiltersToCanvas(
                canvasEditor,
                nextValues,
                lastAppliedSignatureRef,
                { persist: true }
            )
            committedFilterValuesRef.current = nextValues
            clearPreviewFilter(canvasEditor)
        }, 120)
    }

    const handleValueCommit = (filterKey, value) => {
        const committedValue = Array.isArray(value) ? value[0] : value
        const nextValues = {
            ...latestFilterValuesRef.current,
            [filterKey]: committedValue,
        }

        latestFilterValuesRef.current = nextValues
        setFilterValues((currentValues) =>
            areValuesEqual(currentValues, nextValues) ? currentValues : nextValues
        )
        applyPreviewFilter(canvasEditor, nextValues, committedFilterValuesRef.current)
        scheduleCommit(nextValues)
    }

    const resetFilters = () => {
        const nextValues = { ...DEFAULT_VALUES }
        latestFilterValuesRef.current = nextValues
        cancelScheduledCommit(commitTimeoutRef)
        setFilterValues(nextValues)
        applyFiltersToCanvas(
            canvasEditor,
            nextValues,
            lastAppliedSignatureRef,
            { persist: true }
        )
        committedFilterValuesRef.current = nextValues
        clearPreviewFilter(canvasEditor)
    }

    if (!canvasEditor) {
        return (
            <div className='p-4'>
                <p className='text-white/70 text-sm'>
                    Load an image to start adjusting
                </p>
            </div>
        )
    }

    return (
        <div className='space-y-6'>
            <div className='flex justify-between items-center'>
                <h3 className='text-sm font-medium text-white'>
                    Image Adjustments
                </h3>
                <Button
                    variant='ghost'
                    size='sm'
                    onClick={resetFilters}
                    className="text-white/70 hover:text-white"
                >
                    <RotateCcw className='h-4 w-4 mr-2' />
                    Reset
                </Button>
            </div>

            {FILTER_CONFIGS.map((config) => (
                <div key={config.key} className='space-y-2'>
                    <div className='flex justify-between items-center'>
                        <label className="text-sm text-white">{config.label}</label>
                        <span className='text-xs text-white/70'>
                            {filterValues[config.key]}
                            {config.suffix || ""}
                        </span>
                    </div>

                    <Slider
                        value={[filterValues[config.key]]}
                        onValueChange={(value) => handleValueChange(config.key, value)}
                        onValueCommit={(value) => handleValueCommit(config.key, value)}
                        min={config.min}
                        max={config.max}
                        step={config.step}
                        className="w-full"
                    />
                </div>
            ))}

            <div className='mt-6 rounded-lg bg-slate-700/50 p-3'>
                <p className='text-xs text-white/70'>
                    Adjustments are applied in real time and saved with the canvas automatically.
                </p>
            </div>
        </div>
    )
}

export default AdjustControls
