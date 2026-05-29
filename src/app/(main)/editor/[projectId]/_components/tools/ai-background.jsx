"use client"

import React, { useEffect, useRef, useState, useCallback } from 'react'
import Image from 'next/image'
import { Button } from '@/components/ui/button'
import { Download, ImageIcon, Layers, Loader2, Palette, Search, Sparkles, Trash2, Wand2 } from 'lucide-react'
import { FabricImage } from 'fabric'
import { toast } from 'sonner'
import { useCanvas } from '../../../../../../../context/context'
import { useDatabaseMutation } from '../../../../../../../hooks/useDatabaseQuery'
import { api } from "@/lib/neon-api";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import Colorful from '@uiw/react-color-colorful'
import { Input } from '@/components/ui/input'
import { serializeCanvasState } from '../../../../../../lib/canvas-state'
import {
    applyCanvasSizedBackground,
    getForegroundImages,
    mergeBackgroundWithImages,
    syncBackgroundGrade,
} from '../../../../../../lib/canvas-background'

const UNSPLASH_ACCESS_KEY = process.env.NEXT_PUBLIC_UNSPLASH_ACCESS_KEY
const UNSPLASH_API_URL = "https://api.unsplash.com"
const MAX_BACKGROUND_REMOVAL_DIMENSION = 1600
const MAX_BACKGROUND_REMOVAL_RETRIES = 2
const INITIAL_RETRY_DELAY = 1500
const MAX_RETRY_DELAY = 8000
const UNSPLASH_RESULTS_PER_PAGE = 30
const API_TIMEOUT = 120000 // 2 minutes

// Quick background-color swatches for the Color tab.
const BG_SWATCHES = [
    '#ffffff', '#000000', '#0b0d12', '#f4f4f5', '#1f2937', '#e5e7eb',
    '#fde68a', '#bfdbfe', '#fbcfe8', '#bbf7d0', '#06b8d4', '#a8794e',
]

const wait = (duration) => new Promise(resolve => setTimeout(resolve, duration))

class FatalImageKitResponseError extends Error {
    constructor(message) {
        super(message)
        this.name = "FatalImageKitResponseError"
    }
}

const getBackgroundRemovalUrl = (project) => {
    const imageUrl = project?.currentImageUrl || project?.originalImageUrl

    if (!imageUrl?.includes("ik.imagekit.io")) return null

    const width = Math.min(
        Math.max(Math.round(project?.width || MAX_BACKGROUND_REMOVAL_DIMENSION), 1),
        MAX_BACKGROUND_REMOVAL_DIMENSION
    )
    const height = Math.min(
        Math.max(Math.round(project?.height || MAX_BACKGROUND_REMOVAL_DIMENSION), 1),
        MAX_BACKGROUND_REMOVAL_DIMENSION
    )

    return `${imageUrl.split("?")[0]}?tr=w-${width},h-${height},c-at_max,e-bgremove`
}

const getReadableResponseText = async (response) => {
    const text = await response.text().catch(() => "")
    return text
        .replace(/<[^>]*>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 180)
}

const waitForProcessedImage = async (url, onStatus, options = {}) => {
    const {
        maxAttempts = MAX_BACKGROUND_REMOVAL_RETRIES,
        initialRetryDelay = INITIAL_RETRY_DELAY,
        retryStep = 1500,
        maxRetryDelay = MAX_RETRY_DELAY,
        returnObjectUrl = false,
        statusPrefix = "AI is processing",
        timeoutMessage = "ImageKit is still processing",
        signal
    } = options

    let lastError = null

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (signal?.aborted) {
            throw new DOMException('Operation aborted', 'AbortError')
        }

        try {
            const response = await fetch(url, {
                mode: "cors",
                cache: "no-store",
                signal
            })

            const contentType = response.headers.get("content-type") || ""
            const isIntermediate = response.headers.get("is-intermediate-response") === "true"

            if (response.ok && contentType.startsWith("image/")) {
                if (returnObjectUrl) {
                    const blob = await response.blob()
                    return {
                        imageUrl: url,
                        objectUrl: URL.createObjectURL(blob),
                    }
                }
                return url
            }

            const responseText = await getReadableResponseText(response)
            const isStillPreparing =
                response.ok &&
                (isIntermediate ||
                    responseText.toLowerCase().includes("currently being prepared") ||
                    contentType.includes("text/html"))

            if (!response.ok) {
                throw new FatalImageKitResponseError(
                    responseText
                        ? `ImageKit rejected: ${responseText}`
                        : "ImageKit rejected the request"
                )
            }

            if (!isStillPreparing) {
                throw new Error(
                    responseText
                        ? `ImageKit non-image response: ${responseText}`
                        : "ImageKit returned non-image"
                )
            }
        } catch (error) {
            if (error.name === 'AbortError') {
                throw error
            }
            if (error.name === 'FatalImageKitResponseError') {
                throw error
            }
            lastError = error
        }

        if (attempt < maxAttempts - 1) {
            const delay = Math.min(
                initialRetryDelay + attempt * retryStep,
                maxRetryDelay
            )
            onStatus?.(`${statusPrefix}... (${attempt + 2}/${maxAttempts})`)
            await wait(delay)
        }
    }

    throw lastError || new Error(timeoutMessage)
}

const getMainImage = (canvasEditor) => {
    if (!canvasEditor) return null
    return canvasEditor
        .getObjects()
        .find((obj) => obj.type?.toLowerCase() === "image") || null
}

const getToastErrorMessage = (error) => {
    const message = error?.message || ""
    if (message.toLowerCase().includes("extensions limit exceeded")) {
        return "ImageKit extension limit exceeded. Try again after the quota resets or disable AI transforms."
    }
    if (message.includes("Internal Server Error") || message.includes("generate")) {
        return "AI service busy. Try again in 1-2 minutes."
    }
    if (message.includes("still generating")) {
        return "Still generating. Try again soon."
    }
    if (message.includes("rejected") || message.includes("timeout")) {
        return "Try smaller image or simpler prompt."
    }
    return "Background operation failed. Retrying soon..."
}

const BackgroundControls = ({ project, dominantColor, contrastingColor, lighterColor }) => {
    const { canvasEditor, processingMessage, setProcessingMessage } = useCanvas()
    const { mutate: updateProject } = useDatabaseMutation(api.projects.updateProject)

    // States
    const [backgroundColor, setBackgroundColor] = useState(dominantColor || "#ffffff")
    const [searchQuery, setSearchQuery] = useState("")
    const [unsplashImages, setUnsplashImages] = useState([])
    const [searchPage, setSearchPage] = useState(0)
    const [totalSearchPages, setTotalSearchPages] = useState(0)
    const [isSearching, setIsSearching] = useState(false)
    const [isLoadingMoreImages, setIsLoadingMoreImages] = useState(false)
    const [selectedImageId, setSelectedImageId] = useState(null)
    const [generationPrompt, setGenerationPrompt] = useState("")
    const [generatedBackgroundUrl, setGeneratedBackgroundUrl] = useState("")
    const [isGeneratingBackground, setIsGeneratingBackground] = useState(false)
    // After an image background is applied, offer to merge it with the photo(s).
    const [pendingMerge, setPendingMerge] = useState(false)
    const [isMerging, setIsMerging] = useState(false)
    // Whether color grading (user or agent) also applies to the background.
    const [gradeBackground, setGradeBackground] = useState(false)

    // Refs for deduping/abort
    const abortControllerRef = useRef(null)
    const readyBackgroundUrlRef = useRef(null)
    const pendingBackgroundUrlRef = useRef(null)
    const pendingBackgroundPromiseRef = useRef(null)
    const statusUpdaterRef = useRef(null)
    const isLoadingMoreImagesRef = useRef(false)
    const isGeneratingBackgroundRef = useRef(false)
    const generatedBackgroundObjectUrlRef = useRef(null)

    const backgroundRemovalUrl = getBackgroundRemovalUrl(project)
    const mainImage = getMainImage(canvasEditor)

    // Cleanup all refs
    useEffect(() => {
        return () => {
            abortControllerRef.current?.abort()
            if (generatedBackgroundObjectUrlRef.current) {
                URL.revokeObjectURL(generatedBackgroundObjectUrlRef.current)
            }
        }
    }, [])

    const ensureBackgroundRemovalReady = useCallback(async (url) => {
        if (readyBackgroundUrlRef.current === url) {
            return Promise.resolve(url)
        }

        if (pendingBackgroundUrlRef.current === url && pendingBackgroundPromiseRef.current) {
            return pendingBackgroundPromiseRef.current
        }

        // Abort previous request
        if (abortControllerRef.current) {
            abortControllerRef.current.abort()
        }
        abortControllerRef.current = new AbortController()

        pendingBackgroundUrlRef.current = url
        const controller = abortControllerRef.current

        pendingBackgroundPromiseRef.current = waitForProcessedImage(url, (message) => {
            statusUpdaterRef.current?.(message)
        }, { signal: controller.signal }).then((readyUrl) => {
            readyBackgroundUrlRef.current = readyUrl
            return readyUrl
        }).catch((error) => {
            if (error.name === 'AbortError') {
                throw error
            }
            if (pendingBackgroundUrlRef.current === url) {
                pendingBackgroundUrlRef.current = null
                pendingBackgroundPromiseRef.current = null
            }
            throw error
        })

        return pendingBackgroundPromiseRef.current
    }, [])

    const setGeneratedBackgroundPreview = useCallback((url) => {
        if (generatedBackgroundObjectUrlRef.current && generatedBackgroundObjectUrlRef.current !== url) {
            URL.revokeObjectURL(generatedBackgroundObjectUrlRef.current)
        }
        if (url && url.startsWith("blob:")) {
            generatedBackgroundObjectUrlRef.current = url
        }
        setGeneratedBackgroundUrl(url)
    }, [])

    // Background removal effect - single active request
    useEffect(() => {
        if (!backgroundRemovalUrl) return

        let isActive = true
        ensureBackgroundRemovalReady(backgroundRemovalUrl).catch((error) => {
            if (isActive && error.name !== 'AbortError') {
                console.warn("Background ready failed:", error)
            }
        })

        return () => {
            isActive = false
            abortControllerRef.current?.abort()
        }
    }, [backgroundRemovalUrl, ensureBackgroundRemovalReady])

    const handleBackgroundRemoval = async () => {
        const imageToReplace = getMainImage(canvasEditor)
        if (!imageToReplace || !project || !backgroundRemovalUrl) {
            toast.error("Background removal only works with ImageKit images")
            return
        }

        setProcessingMessage("Preparing AI background removal...")
        statusUpdaterRef.current = setProcessingMessage

        try {
            const readyImageUrl = await ensureBackgroundRemovalReady(backgroundRemovalUrl)
            setProcessingMessage("Applying background removal...")

            const processedImage = await FabricImage.fromURL(readyImageUrl, {
                crossOrigin: "anonymous",
            })

            const renderedWidth = imageToReplace.getScaledWidth()
            const renderedHeight = imageToReplace.getScaledHeight()

            processedImage.set({
                left: imageToReplace.left,
                top: imageToReplace.top,
                scaleX: renderedWidth / (processedImage.width || 1),
                scaleY: renderedHeight / (processedImage.height || 1),
                angle: imageToReplace.angle,
                originX: imageToReplace.originX,
                originY: imageToReplace.originY,
                selectable: imageToReplace.selectable,
                evented: imageToReplace.evented,
            })

            // Compute the bounding box of the visible (non-transparent) pixels
            processedImage.setCoords()
            const boundingRect = processedImage.getBoundingRect(true, true)
            const croppedWidth = boundingRect.width
            const croppedHeight = boundingRect.height

            // If the processed image tightly fits the foreground, recenter it visually
            if (croppedWidth > 0 && croppedHeight > 0) {
                const canvasWidth = project.width
                const canvasHeight = project.height

                // Calculate the offset of the bounding box relative to the image center
                const offsetX = (processedImage.width * processedImage.scaleX) / 2 - (boundingRect.left - processedImage.left + croppedWidth / 2)
                const offsetY = (processedImage.height * processedImage.scaleY) / 2 - (boundingRect.top - processedImage.top + croppedHeight / 2)

                // Center the cropped bounding box on the canvas
                processedImage.set({
                    left: canvasWidth / 2 + offsetX,
                    top: canvasHeight / 2 + offsetY,
                })
            }

            canvasEditor.remove(imageToReplace)
            canvasEditor.add(processedImage)
            canvasEditor.setActiveObject(processedImage)
            processedImage.setCoords()
            canvasEditor.calcOffset()
            canvasEditor.requestRenderAll()

            await updateProject({
                projectId: project._id,
                currentImageUrl: readyImageUrl,
                canvasState: serializeCanvasState(canvasEditor),
                backgroundRemoved: true,
            })

            toast.success("Background removed successfully!")
        } catch (error) {
            console.warn("Background removal failed:", error)
            toast.error(getToastErrorMessage(error))
        } finally {
            statusUpdaterRef.current = null
            setProcessingMessage(null)
            if (abortControllerRef.current) {
                abortControllerRef.current = null
            }
        }
    }

    const handleColorBackground = () => {
        if (!canvasEditor) return
        canvasEditor.backgroundImage = null
        canvasEditor.backgroundColor = backgroundColor
        canvasEditor.__pixxelGradeBackground = false
        canvasEditor.requestRenderAll()
        canvasEditor.__pushHistoryState?.()
        canvasEditor.__saveCanvasState?.()
        setPendingMerge(false)
        setGradeBackground(false)
    }

    const applyImageBackground = async (imageUrl) => {
        if (!canvasEditor) return

        try {
            // Sizes the background to EXACTLY the canvas (cover-crop, no overflow,
            // no distortion) while keeping the remote URL so saves stay small.
            await applyCanvasSizedBackground(canvasEditor, FabricImage, imageUrl, project)
            canvasEditor.__pushHistoryState?.()
            canvasEditor.__saveCanvasState?.()
            // If there's a photo on the canvas, offer to merge the background into it.
            setPendingMerge(getForegroundImages(canvasEditor).length >= 1)
        } catch (error) {
            console.warn('[ai-background] apply failed:', error)
            toast.error("Failed to apply background image")
        }
    }

    // Flatten the background + photo layer(s) into a single uploaded image.
    const handleMergeBackground = async () => {
        if (!canvasEditor || isMerging) return
        setIsMerging(true)
        const toastId = toast.loading('Merging background with photo...')
        try {
            const merged = await mergeBackgroundWithImages(canvasEditor, FabricImage, project)
            if (merged) {
                setPendingMerge(false)
                setGradeBackground(false)
                toast.success('Merged into a single layer', { id: toastId })
            } else {
                toast.error('Nothing to merge', { id: toastId })
            }
        } catch (error) {
            console.warn('[ai-background] merge failed:', error)
            toast.error('Merge failed — keeping the layers separate', { id: toastId })
        } finally {
            setIsMerging(false)
        }
    }

    // Enable/disable color grading on the background (mirrors the photo's grade).
    const toggleGradeBackground = () => {
        if (!canvasEditor) return
        const next = !gradeBackground
        setGradeBackground(next)
        canvasEditor.__pixxelGradeBackground = next
        syncBackgroundGrade(canvasEditor, next)
        canvasEditor.__pushHistoryState?.()
        canvasEditor.__saveCanvasState?.()
    }

    // Keep the panel in sync with the canvas: initialize the grade toggle, and on
    // any canvas change (undo, external background removal, merge) drop a stale
    // merge prompt and re-read the grade flag, forcing a re-render via bgRevision.
    const [, setBgRevision] = useState(0)
    useEffect(() => {
        if (!canvasEditor) return undefined
        const sync = () => {
            setGradeBackground(Boolean(canvasEditor.__pixxelGradeBackground))
            if (!canvasEditor.backgroundImage) setPendingMerge(false)
            setBgRevision((v) => v + 1)
        }
        sync()
        canvasEditor.on('history:changed', sync)
        canvasEditor.on('object:removed', sync)
        return () => {
            canvasEditor.off('history:changed', sync)
            canvasEditor.off('object:removed', sync)
        }
    }, [canvasEditor])

    const fetchUnsplashImages = async (query, page, signal) => {
        const params = new URLSearchParams({
            query,
            page: String(page),
            per_page: String(UNSPLASH_RESULTS_PER_PAGE),
            orientation: "landscape",
            client_id: UNSPLASH_ACCESS_KEY,
        })

        const response = await fetch(`${UNSPLASH_API_URL}/search/photos?${params}`, { signal })
        if (!response.ok) {
            const errorBody = await response.json().catch(() => ({}))
            throw new Error(
                Array.isArray(errorBody?.errors)
                    ? errorBody.errors.join(", ")
                    : "Unsplash search failed"
            )
        }
        return response.json()
    }

    const searchUnsplashImages = async () => {
        const trimmedQuery = searchQuery.trim()
        if (!trimmedQuery || !UNSPLASH_ACCESS_KEY) {
            toast.error("Unsplash not configured")
            return
        }

        setIsSearching(true)
        if (abortControllerRef.current) {
            abortControllerRef.current.abort()
        }
        abortControllerRef.current = new AbortController()

        try {
            const data = await fetchUnsplashImages(trimmedQuery, 1, abortControllerRef.current.signal)
            setUnsplashImages(data.results || [])
            setSearchPage(1)
            setTotalSearchPages(data.total_pages || 0)
        } catch (error) {
            if (error.name === 'AbortError') return
            toast.error(error.message || "Search failed")
        } finally {
            setIsSearching(false)
        }
    }

    const loadMoreUnsplashImages = async () => {
        if (isSearching || isLoadingMoreImagesRef.current) return

        const nextPage = searchPage + 1
        isLoadingMoreImagesRef.current = true
        setIsLoadingMoreImages(true)

        try {
            const data = await fetchUnsplashImages(searchQuery, nextPage)
            const nextImages = data.results || []
            const existingIds = new Set(unsplashImages.map(image => image.id))
            const uniqueNextImages = nextImages.filter(image => !existingIds.has(image.id))

            setUnsplashImages(prev => [...prev, ...uniqueNextImages])
            setSearchPage(nextPage)
            setTotalSearchPages(data.total_pages || totalSearchPages)
        } catch (error) {
            toast.error(error.message || "Failed to load more images")
        } finally {
            isLoadingMoreImagesRef.current = false
            setIsLoadingMoreImages(false)
        }
    }

    const handleResultsScroll = (e) => {
        const { scrollTop, scrollHeight, clientHeight } = e.currentTarget
        if (scrollHeight - scrollTop - clientHeight < 180) {
            loadMoreUnsplashImages()
        }
    }

    const handleSearchKeyPress = (e) => {
        if (e.key === "Enter") searchUnsplashImages()
    }

    const handleImageBackground = async (imageUrl, imageId) => {
        setSelectedImageId(imageId)
        try {
            if (UNSPLASH_ACCESS_KEY) {
                await fetch(`${UNSPLASH_API_URL}/photos/${imageId}/download`, {
                    headers: { Authorization: `Client-ID ${UNSPLASH_ACCESS_KEY}` },
                }).catch(() => { })
            }
            await applyImageBackground(imageUrl)
        } catch (error) {
            toast.error("Failed to set background")
        } finally {
            setSelectedImageId(null)
        }
    }

    const generateAiBackground = async () => {
        if (isGeneratingBackgroundRef.current || !generationPrompt.trim()) {
            return
        }

        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT)

        isGeneratingBackgroundRef.current = true
        setIsGeneratingBackground(true)
        setProcessingMessage("Generating AI background...")

        try {
            const response = await fetch("/api/ai/background", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ prompt: generationPrompt.trim() }),
                signal: controller.signal,
            })

            clearTimeout(timeoutId)

            if (!response.ok) {
                const data = await response.json().catch(() => ({}))
                const errorMsg = data.error || data.message || `HTTP ${response.status}`
                throw new Error(errorMsg)
            }

            const data = await response.json()
            if (!data?.imageUrl) {
                throw new Error("No image URL returned")
            }

            setProcessingMessage("Applying AI background...")
            setGeneratedBackgroundPreview(data.imageUrl)
            await applyImageBackground(data.imageUrl)
            toast.success("AI background generated!")
        } catch (error) {
            if (error.name === 'AbortError') {
                toast.error("Request timed out - try simpler prompt")
                return
            }
            console.warn("AI background failed:", error)
            toast.error(getToastErrorMessage(error))
        } finally {
            clearTimeout(timeoutId)
            setProcessingMessage(null)
            setIsGeneratingBackground(false)
            isGeneratingBackgroundRef.current = false
        }
    }

    const removeCanvasBackground = () => {
        if (!canvasEditor) return
        canvasEditor.backgroundColor = null
        canvasEditor.backgroundImage = null
        canvasEditor.__pixxelGradeBackground = false
        canvasEditor.requestRenderAll()
        canvasEditor.__pushHistoryState?.()
        canvasEditor.__saveCanvasState?.()
        setPendingMerge(false)
        setGradeBackground(false)
    }

    return (
        <div className="relative flex h-full min-h-0 flex-col gap-5 overflow-hidden">
            <div>
                <div className="mb-3">
                    <label className="panel-label">AI Background Removal</label>
                    <p className="text-[11px] mt-1" style={{ color: 'var(--text-muted)' }}>
                        Automatically remove backgrounds using AI
                    </p>
                </div>
                <button
                    onClick={handleBackgroundRemoval}
                    disabled={Boolean(processingMessage) || !mainImage}
                    className="flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2.5 text-xs font-semibold editor-interactive disabled:opacity-40"
                    style={{ background: 'var(--accent-primary)', color: '#fff', border: 'none', boxShadow: 'var(--shadow-glow)' }}
                >
                    <Trash2 className="h-3.5 w-3.5" />
                    Remove Image Background
                </button>
                {!mainImage && (
                    <p className="mt-2 text-[11px]" style={{ color: 'var(--accent-warning)' }}>
                        ⚠ Add an image to canvas first
                    </p>
                )}
            </div>

            {/* Background layer: after applying a background, offer to merge it with
                the photo, or keep it separate with an optional color-grade link. */}
            {(pendingMerge || canvasEditor?.backgroundImage) && (
                <div className="space-y-2" style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: '12px' }}>
                    {pendingMerge ? (
                        <>
                            <label className="panel-label">Background applied</label>
                            <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                                Merge it with your photo into one layer, or keep them separate to edit each independently.
                            </p>
                            <div className="grid grid-cols-2 gap-1.5">
                                <button
                                    type="button"
                                    onClick={handleMergeBackground}
                                    disabled={isMerging}
                                    className="flex items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-xs font-semibold editor-interactive disabled:opacity-50"
                                    style={{ background: 'var(--accent-primary)', color: '#03050A', border: 'none' }}
                                >
                                    {isMerging ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Layers className="h-3.5 w-3.5" />}
                                    Merge
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setPendingMerge(false)}
                                    disabled={isMerging}
                                    className="flex items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-xs font-medium editor-interactive"
                                    style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}
                                >
                                    Keep separate
                                </button>
                            </div>
                        </>
                    ) : (
                        <>
                            <label className="panel-label">Background</label>
                            <button
                                type="button"
                                onClick={toggleGradeBackground}
                                aria-pressed={gradeBackground}
                                className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left editor-interactive"
                                style={{
                                    background: gradeBackground ? 'rgba(6,184,212,0.1)' : 'transparent',
                                    border: `1px solid ${gradeBackground ? 'var(--accent-primary)' : 'var(--border-subtle)'}`,
                                    color: gradeBackground ? 'var(--accent-primary)' : 'var(--text-secondary)',
                                }}
                            >
                                <div className="flex h-8 w-8 items-center justify-center rounded-lg shrink-0"
                                    style={{ background: gradeBackground ? 'rgba(6,184,212,0.15)' : 'var(--bg-elevated)', border: `1px solid ${gradeBackground ? 'var(--accent-primary)' : 'var(--border-default)'}` }}>
                                    <Wand2 className="h-4 w-4" />
                                </div>
                                <div className="min-w-0">
                                    <div className="text-xs font-semibold">Color grade background: {gradeBackground ? 'On' : 'Off'}</div>
                                    <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>Apply your photo&apos;s grade (and the agent&apos;s) to the background too</div>
                                </div>
                            </button>
                            {getForegroundImages(canvasEditor).length >= 1 && (
                                <button
                                    type="button"
                                    onClick={handleMergeBackground}
                                    disabled={isMerging}
                                    className="flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2 text-xs font-medium editor-interactive disabled:opacity-50"
                                    style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}
                                >
                                    {isMerging ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Layers className="h-3.5 w-3.5" />}
                                    Merge background with photo
                                </button>
                            )}
                        </>
                    )}
                </div>
            )}

            <Tabs defaultValue="color" className="min-h-0 w-full flex-1 overflow-hidden">
                <TabsList className="grid w-full grid-cols-3" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)' }}>
                    <TabsTrigger
                        value="color"
                        className="text-xs data-[state=active]:text-white"
                        style={{ '--tw-shadow': 'none' }}
                    >
                        <Palette className="h-3.5 w-3.5 mr-1.5" />
                        Color
                    </TabsTrigger>
                    <TabsTrigger
                        value="image"
                        className="text-xs data-[state=active]:text-white"
                    >
                        <ImageIcon className="h-3.5 w-3.5 mr-1.5" />
                        Image
                    </TabsTrigger>
                    <TabsTrigger
                        value="generate"
                        className="text-xs data-[state=active]:text-white"
                    >
                        <Sparkles className="h-3.5 w-3.5 mr-1.5" />
                        Generate
                    </TabsTrigger>
                </TabsList>

            <TabsContent value="color" className="mt-4 min-h-0 overflow-y-auto pr-1 panel-scroll">
                <div className="space-y-4">
                    <div>
                        <label className="panel-label">Solid Color</label>
                        <p className="text-[11px] mt-1" style={{ color: 'var(--text-muted)' }}>Choose canvas background color</p>
                    </div>
                    <Colorful
                        color={backgroundColor}
                        onChange={(color) => setBackgroundColor(color.hex)}
                        disableAlpha
                        style={{ width: "100%" }}
                    />
                    <div className="flex items-center gap-3">
                        <input
                            value={backgroundColor}
                            onChange={(e) => setBackgroundColor(e.target.value)}
                            placeholder="#ffffff"
                            className="panel-input flex-1 min-w-0"
                        />
                        <div
                            className="h-9 w-9 shrink-0 rounded-lg"
                            style={{ backgroundColor, border: '1px solid var(--border-default)' }}
                        />
                    </div>
                    <div className="grid grid-cols-6 gap-1.5">
                        {BG_SWATCHES.map((c) => (
                            <button
                                key={c}
                                type="button"
                                onClick={() => setBackgroundColor(c)}
                                aria-label={`Use ${c}`}
                                className="h-6 rounded-md editor-interactive"
                                style={{
                                    backgroundColor: c,
                                    border: `2px solid ${String(backgroundColor).toLowerCase() === c ? 'var(--accent-primary)' : 'transparent'}`,
                                    boxShadow: String(backgroundColor).toLowerCase() === c ? '0 0 0 1px rgba(6,184,212,0.3)' : 'none',
                                }}
                            />
                        ))}
                    </div>
                    <button
                        onClick={handleColorBackground}
                        className="flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2.5 text-xs font-medium editor-interactive"
                        style={{ background: 'var(--accent-primary)', color: '#fff', border: 'none' }}
                    >
                        <Palette className="h-3.5 w-3.5" />
                        Apply Color
                    </button>
                </div>
            </TabsContent>

            <TabsContent value="image" className="mt-4 flex min-h-0 flex-col gap-3 overflow-hidden">
                <div>
                    <label className="panel-label">Image Background</label>
                    <p className="text-[11px] mt-1" style={{ color: 'var(--text-muted)' }}>Search Unsplash images</p>
                </div>

                <div className="flex gap-2">
                    <input
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        onKeyDown={handleSearchKeyPress}
                        placeholder="Search backgrounds"
                        className="panel-input flex-1"
                    />
                    <button
                        onClick={searchUnsplashImages}
                        disabled={isSearching || !searchQuery.trim()}
                        className="flex items-center justify-center rounded-lg px-3 editor-interactive disabled:opacity-40"
                        style={{ background: 'var(--accent-primary)', color: '#fff', border: 'none' }}
                    >
                        {isSearching ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                            <Search className="h-3.5 w-3.5" />
                        )}
                    </button>
                </div>

                {unsplashImages.length > 0 && (
                    <div
                        className="grid min-h-0 flex-1 content-start grid-cols-[repeat(auto-fit,minmax(100px,1fr))] gap-2 overflow-y-auto pr-1 panel-scroll"
                        onScroll={handleResultsScroll}
                    >
                        {unsplashImages.map((image) => (
                            <button
                                key={image.id}
                                type="button"
                                onClick={() => handleImageBackground(image.urls.regular, image.id)}
                                disabled={Boolean(selectedImageId)}
                                className="group relative h-28 overflow-hidden rounded-lg editor-interactive"
                                style={{ border: '1px solid var(--border-subtle)', background: 'var(--bg-app)' }}
                                title={image.alt_description || "Unsplash image"}
                            >
                                <Image
                                    src={image.urls.small}
                                    alt={image.alt_description || "Background"}
                                    fill
                                    sizes="160px"
                                    unoptimized
                                    className="object-cover"
                                />
                                <div className="absolute inset-0 bg-black/0 transition-all duration-200 group-hover:bg-black/35" />
                                <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 px-2 pb-1.5 pt-6 text-left">
                                    <p className="truncate text-[10px] font-medium text-white drop-shadow">
                                        by {image.user?.name || "Unsplash"}
                                    </p>
                                </div>
                                <div className="absolute inset-0 flex items-center justify-center opacity-0 transition-opacity duration-200 group-hover:opacity-100">
                                    <span className="flex size-9 items-center justify-center rounded-full text-white backdrop-blur-sm"
                                          style={{ background: 'rgba(11, 13, 18, 0.6)', border: '1px solid var(--border-default)' }}>
                                        {selectedImageId === image.id ? (
                                            <Loader2 className="h-4 w-4 animate-spin" />
                                        ) : (
                                            <Download className="h-4 w-4" />
                                        )}
                                    </span>
                                </div>
                            </button>
                        ))}
                        {isLoadingMoreImages && (
                            <div className="col-span-2 flex items-center justify-center gap-2 py-3 text-[11px]"
                                 style={{ color: 'var(--text-muted)' }}>
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                Loading more...
                            </div>
                        )}
                    </div>
                )}

          {!isSearching && searchQuery && unsplashImages.length === 0 && (
            <div className="flex min-h-0 flex-1 flex-col items-center justify-center py-4 text-center">
              <ImageIcon className="h-8 w-8 mb-3" style={{ color: 'var(--text-muted)' }} />
              <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>No images for &quot;{searchQuery}&quot;</p>
              <p className="text-[11px] mt-1" style={{ color: 'var(--text-muted)' }}>Try different search</p>
            </div>
          )}
        </TabsContent>

        <TabsContent value="generate" className="mt-4 min-h-0 overflow-y-auto pr-1 panel-scroll">
          <div className="space-y-4">
            <div>
              <label className="panel-label">AI Background Generator</label>
              <p className="text-[11px] mt-1" style={{ color: 'var(--text-muted)' }}>Describe your perfect background</p>
            </div>

            <textarea
              value={generationPrompt}
              onChange={(e) => setGenerationPrompt(e.target.value)}
              placeholder="Soft ocean sunset, cinematic light, clean background"
              rows={5}
              className="panel-input resize-none"
              style={{ minHeight: '100px' }}
            />

            <button
              type="button"
              onClick={generateAiBackground}
              disabled={isGeneratingBackground || Boolean(processingMessage) || !generationPrompt.trim()}
              className="flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2.5 text-xs font-semibold editor-interactive disabled:opacity-40"
              style={{ background: 'var(--accent-primary)', color: '#fff', border: 'none', boxShadow: 'var(--shadow-glow)' }}
            >
              {isGeneratingBackground ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Sparkles className="h-3.5 w-3.5" />
              )}
              {isGeneratingBackground ? "Generating..." : "Generate Background"}
            </button>

            {generatedBackgroundUrl && (
              <button
                type="button"
                onClick={() => applyImageBackground(generatedBackgroundUrl)}
                className="group relative h-32 w-full overflow-hidden rounded-lg editor-interactive"
                style={{
                  backgroundImage: `url("${generatedBackgroundUrl}")`,
                  backgroundSize: "cover",
                  backgroundPosition: "center",
                  border: '1px solid var(--border-subtle)',
                }}
              >
                <div className="absolute inset-0 bg-black/0 transition-all duration-200 group-hover:bg-black/30" />
                <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 to-transparent px-3 pb-2 pt-8 text-[11px] font-medium text-white">
                  Apply generated background
                </div>
              </button>
            )}
          </div>
        </TabsContent>
      </Tabs>

      <div className="pt-3" style={{ borderTop: '1px solid var(--border-subtle)' }}>
        <button
            onClick={removeCanvasBackground}
            className="flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2 text-xs font-medium editor-interactive"
            style={{ background: 'var(--bg-elevated)', color: 'var(--text-secondary)', border: '1px solid var(--border-subtle)' }}
        >
          <Trash2 className="h-3.5 w-3.5" />
          Clear Canvas Background
        </button>
      </div>
    </div >
  )
}

export default BackgroundControls
