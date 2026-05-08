"use client"

import React, { useEffect, useRef, useState, useCallback } from 'react'
import Image from 'next/image'
import { Button } from '@/components/ui/button'
import { Download, ImageIcon, Loader2, Palette, Search, Sparkles, Trash2 } from 'lucide-react'
import { FabricImage } from 'fabric'
import { toast } from 'sonner'
import { useCanvas } from '../../../../../../../context/context'
import { useConvexMutation } from '../../../../../../../hooks/useConvexQuery'
import { api } from '../../../../../../../convex/_generated/api'
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import Colorful from '@uiw/react-color-colorful'
import { Input } from '@/components/ui/input'
import { serializeCanvasState } from '../../../../../../lib/canvas-state'

const UNSPLASH_ACCESS_KEY = process.env.NEXT_PUBLIC_UNSPLASH_ACCESS_KEY
const UNSPLASH_API_URL = "https://api.unsplash.com"
const MAX_BACKGROUND_REMOVAL_DIMENSION = 1600
const MAX_BACKGROUND_REMOVAL_RETRIES = 20
const INITIAL_RETRY_DELAY = 1500
const MAX_RETRY_DELAY = 8000
const UNSPLASH_RESULTS_PER_PAGE = 30
const API_TIMEOUT = 120000 // 2 minutes

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

const BackgroundControls = ({ project }) => {
    const { canvasEditor, processingMessage, setProcessingMessage } = useCanvas()
    const { mutate: updateProject } = useConvexMutation(api.projects.updateProject)

    // States
    const [backgroundColor, setBackgroundColor] = useState("#ffffff")
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

        // Abort previous request
        if (abortControllerRef.current) {
            abortControllerRef.current.abort()
        }
        abortControllerRef.current = new AbortController()

        if (pendingBackgroundUrlRef.current === url && pendingBackgroundPromiseRef.current) {
            return pendingBackgroundPromiseRef.current
        }

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
        canvasEditor.requestRenderAll()
    }

    const applyImageBackground = async (imageUrl) => {
        if (!canvasEditor || !project) return

        try {
            const fabricImage = await FabricImage.fromURL(imageUrl, {
                crossOrigin: imageUrl.startsWith("") || imageUrl.startsWith("blob:")
                    ? undefined
                    : "anonymous"
            })

            const canvasWidth = project.width
            const canvasHeight = project.height

            const scaleX = canvasWidth / fabricImage.width
            const scaleY = canvasHeight / fabricImage.height
            const scale = Math.max(scaleX, scaleY)

            fabricImage.set({
                scaleX: scale,
                scaleY: scale,
                originX: "center",
                originY: "center",
                left: canvasWidth / 2,
                top: canvasHeight / 2,
            })

            canvasEditor.backgroundColor = null
            canvasEditor.backgroundImage = fabricImage
            canvasEditor.requestRenderAll()
        } catch (error) {
            toast.error("Failed to apply background image")
        }
    }

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
        canvasEditor.requestRenderAll()
    }

    return (
        <div className="relative flex h-full min-h-0 flex-col gap-5 overflow-hidden">
            <div>
                <div>
                    <h3 className="text-sm font-medium text-white mb-2">
                        AI Background Removal
                    </h3>
                    <p className="text-xs text-white/70 mb-4">
                        Automatically remove backgrounds using AI
                    </p>
                </div>
                <Button
                    className="w-full"
                    variant="primary"
                    onClick={handleBackgroundRemoval}
                    disabled={Boolean(processingMessage) || !mainImage}
                >
                    <Trash2 className="h-4 w-4 mr-2" />
                    Remove Image Background
                </Button>
                {!mainImage && (
                    <p className="mt-3 text-xs text-amber-400">
                        Add an image to canvas first
                    </p>
                )}
            </div>

            <Tabs defaultValue="color" className="min-h-0 w-full flex-1 overflow-hidden">
                <TabsList className="grid w-full grid-cols-3 bg-slate-700/50">
                    <TabsTrigger
                        value="color"
                        className="data-[state=active]:bg-cyan-500 data-[state=active]:text-white"
                    >
                        <Palette className="h-4 w-4 mr-2" />
                        Color
                    </TabsTrigger>
                    <TabsTrigger
                        value="image"
                        className="data-[state=active]:bg-cyan-500 data-[state=active]:text-white"
                    >
                        <ImageIcon className="h-4 w-4 mr-2" />
                        Image
                    </TabsTrigger>
                    <TabsTrigger
                        value="generate"
                        className="data-[state=active]:bg-cyan-500 data-[state=active]:text-white"
                    >
                        <Sparkles className="h-4 w-4 mr-2" />
                        Generate
                    </TabsTrigger>
                </TabsList>

            <TabsContent value="color" className="mt-5 min-h-0 overflow-y-auto pr-1">
                <div className="space-y-4">
                    <div>
                        <h3 className="text-sm font-medium text-white mb-2">Solid Color</h3>
                        <p className="text-xs text-white/70">Choose canvas background color</p>
                    </div>
                    <Colorful
                        color={backgroundColor}
                        onChange={(color) => setBackgroundColor(color.hex)}
                        disableAlpha
                        style={{ width: "100%" }}
                    />
                    <div className="flex items-center gap-3">
                        <Input
                            value={backgroundColor}
                            onChange={(e) => setBackgroundColor(e.target.value)}
                            placeholder="#ffffff"
                            className="min-w-0 flex-1 bg-slate-700 border-white/20 text-white"
                        />
                        <div
                            className="h-10 w-10 shrink-0 rounded border border-white/20"
                            style={{ backgroundColor }}
                        />
                    </div>
                    <Button onClick={handleColorBackground} className="w-full" variant="primary">
                        <Palette className="h-4 w-4 mr-2" />
                        Apply Color
                    </Button>
                </div>
            </TabsContent>

            <TabsContent value="image" className="mt-5 flex min-h-0 flex-col gap-4 overflow-hidden">
                <div>
                    <h3 className="text-sm font-medium text-white mb-2">Image Background</h3>
                    <p className="text-xs text-white/70">Search Unsplash images</p>
                </div>

                <div className="flex gap-2">
                    <Input
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        onKeyDown={handleSearchKeyPress}
                        placeholder="Search backgrounds"
                        className="flex-1 bg-slate-700 border-white/20 text-white"
                    />
                    <Button
                        onClick={searchUnsplashImages}
                        disabled={isSearching || !searchQuery.trim()}
                        variant="primary"
                    >
                        {isSearching ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                            <Search className="h-4 w-4" />
                        )}
                    </Button>
                </div>

                {unsplashImages.length > 0 && (
                    <div
                        className="grid min-h-0 flex-1 content-start grid-cols-2 gap-3 overflow-y-auto pr-2"
                        onScroll={handleResultsScroll}
                    >
                        {unsplashImages.map((image) => (
                            <button
                                key={image.id}
                                type="button"
                                onClick={() => handleImageBackground(image.urls.regular, image.id)}
                                disabled={Boolean(selectedImageId)}
                                className="group relative h-32 overflow-hidden rounded-lg border border-white/10 bg-slate-900 shadow-[0_10px_24px_rgba(2,6,23,0.24)] transition-all duration-200 hover:border-cyan-300/80 focus-visible:border-cyan-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/30"
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
                                <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 px-2 pb-2 pt-8 text-left">
                                    <p className="truncate text-xs font-medium text-white drop-shadow">
                                        by {image.user?.name || "Unsplash"}
                                    </p>
                                </div>
                                <div className="absolute inset-0 flex items-center justify-center opacity-0 transition-opacity duration-200 group-hover:opacity-100">
                                    <span className="flex size-11 items-center justify-center rounded-full border border-white/50 bg-slate-950/45 text-white shadow-lg backdrop-blur-sm">
                                        {selectedImageId === image.id ? (
                                            <Loader2 className="h-5 w-5 animate-spin" />
                                        ) : (
                                            <Download className="h-5 w-5" />
                                        )}
                                    </span>
                                </div>
                            </button>
                        ))}
                        {isLoadingMoreImages && (
                            <div className="col-span-2 flex items-center justify-center gap-2 py-3 text-xs text-white/60">
                                <Loader2 className="h-4 w-4 animate-spin" />
                                Loading more...
                            </div>
                        )}
                    </div>
                )}

          {!isSearching && searchQuery && unsplashImages.length === 0 && (
            <div className="flex min-h-0 flex-1 flex-col items-center justify-center py-4 text-center">
              <ImageIcon className="h-9 w-9 text-white/30 mb-3" />
              <p className="text-white/70 text-sm">No images for &quot;{searchQuery}&quot;</p>
              <p className="text-white/50 text-xs">Try different search</p>
            </div>
          )}
        </TabsContent>

        <TabsContent value="generate" className="mt-5 min-h-0 overflow-y-auto pr-1">
          <div className="space-y-4">
            <div>
              <h3 className="text-sm font-medium text-white mb-2">AI Background Generator</h3>
              <p className="text-xs text-white/70">Describe your perfect background</p>
            </div>

            <textarea
              value={generationPrompt}
              onChange={(e) => setGenerationPrompt(e.target.value)}
              placeholder="Soft ocean sunset, cinematic light, clean background"
              rows={5}
              className="w-full resize-none border border-white/20 bg-slate-700 px-3 py-2 text-sm text-white outline-none placeholder:text-white/40 focus:border-cyan-300"
            />

            <Button
              type="button"
              onClick={generateAiBackground}
              disabled={isGeneratingBackground || Boolean(processingMessage) || !generationPrompt.trim()}
              className="w-full"
              variant="primary"
            >
              {isGeneratingBackground ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Sparkles className="h-4 w-4 mr-2" />
              )}
              {isGeneratingBackground ? "Generating..." : "Generate Background"}
            </Button>

            {generatedBackgroundUrl && (
              <button
                type="button"
                onClick={() => applyImageBackground(generatedBackgroundUrl)}
                className="group relative h-36 w-full overflow-hidden rounded-lg border border-white/10 bg-slate-900 transition-all duration-200 hover:border-cyan-300/80"
                style={{
                  backgroundImage: `url("${generatedBackgroundUrl}")`,
                  backgroundSize: "cover",
                  backgroundPosition: "center",
                }}
              >
                <div className="absolute inset-0 bg-black/0 transition-all duration-200 group-hover:bg-black/30" />
                <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 to-transparent px-3 pb-3 pt-10 text-xs font-medium text-white">
                  Apply generated background
                </div>
              </button>
            )}
          </div>
        </TabsContent>
      </Tabs>

      <div className="pt-4 border-t border-white/20">
        <Button onClick={removeCanvasBackground} className="w-full" variant="outline">
          <Trash2 className="h-4 w-4 mr-2" />
          Clear Canvas Background
        </Button>
      </div>
    </div >
  )
}

export default BackgroundControls
