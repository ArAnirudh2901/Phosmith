import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert'
import React, { useState } from 'react'
import usePlanAccess from '../../../../../hooks/usePlanAccess'
import { useDatabaseMutation } from '../../../../../hooks/useDatabaseQuery'
import { api } from "@/lib/neon-api";
import { Crown, ImageIcon, Loader2, Upload, X } from 'lucide-react'
import { useDropzone } from 'react-dropzone'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { toast } from 'sonner'
import { useRouter } from 'next/navigation'
import UpgradeModel from '@/components/upgradeModel'
import { stripImageMetadata } from '@/lib/strip-metadata'

const loadImageFromObjectUrl = (url) =>
    new Promise((resolve, reject) => {
        const image = new Image()

        image.onload = () => resolve(image)
        image.onerror = () => reject(new Error("Could not read the selected image"))
        image.decoding = "async"
        image.src = url
    })

const canvasToBlob = (canvas, mimeType, quality) =>
    new Promise((resolve) => {
        canvas.toBlob(resolve, mimeType, quality)
    })

const getSafeBaseName = (fileName) => {
    const baseName = String(fileName || "upload").replace(/\.[^/.]+$/, "") || "upload"
    return baseName
        .replace(/[/\\?%*:|"<>]/g, "_")
        .replace(/[^a-zA-Z0-9._-]/g, "_")
        .replace(/_+/g, "_")
        .slice(0, 96) || "upload"
}

/**
 * Safe limits for rasterised uploads.
 *
 * TWO independent constraints must be satisfied:
 *   1. Browser canvas limits — toBlob() silently returns null beyond these.
 *        • Edge length ≤ 8 192 px  (Safari hard limit)
 *        • Total area  ≤ 67 M px   (Chrome/Firefox memory guard)
 *   2. ImageKit serving limit — images above 25 MP get a 400 ("ELIMIT").
 *
 * We cap at 24 MP (safety margin below ImageKit's 25 MP hard cut-off) with an
 * 8 192 px edge cap. An 8K image (7680×4320 = 33 MP) is above 24 MP and will
 * be proportionally downscaled to ≈6400×3600, which is still very high quality.
 */
const MAX_CANVAS_EDGE = 8192
const IMAGEKIT_MAX_MP = 24_000_000              // 24 MP — stay safely below ImageKit's 25 MP cap
const MAX_CANVAS_AREA = IMAGEKIT_MAX_MP         // use the tighter constraint
const IMAGEKIT_MAX_BYTES = 25 * 1024 * 1024     // 25 MB — ImageKit upload hard limit

const fitToCanvasLimits = (srcW, srcH) => {
    let w = srcW
    let h = srcH

    // Clamp longest edge first
    if (w > MAX_CANVAS_EDGE || h > MAX_CANVAS_EDGE) {
        const edgeScale = MAX_CANVAS_EDGE / Math.max(w, h)
        w = Math.round(w * edgeScale)
        h = Math.round(h * edgeScale)
    }

    // Then clamp total area (can still be too large if both sides are close to the limit)
    if (w * h > MAX_CANVAS_AREA) {
        const areaScale = Math.sqrt(MAX_CANVAS_AREA / (w * h))
        w = Math.round(w * areaScale)
        h = Math.round(h * areaScale)
    }

    // Ensure at least 1×1
    return { w: Math.max(1, w), h: Math.max(1, h) }
}

const rasterizeSelectedImage = async (file, objectUrl) => {
    if (!file || !objectUrl) {
        throw new Error("No image selected")
    }

    const image = await loadImageFromObjectUrl(objectUrl)
    const origW = Math.round(image.naturalWidth || image.width || 0)
    const origH = Math.round(image.naturalHeight || image.height || 0)

    if (!origW || !origH) {
        throw new Error("Could not read the selected image dimensions")
    }

    // Use native size when safe, otherwise scale down to stay within canvas limits.
    // `let` so the stage-3 dimension-reduction step can update them if needed.
    let { w: canvasW, h: canvasH } = fitToCanvasLimits(origW, origH)

    const canvas = document.createElement("canvas")
    canvas.width = canvasW
    canvas.height = canvasH

    const context = canvas.getContext("2d", {
        alpha: true,
        colorSpace: "srgb",
    }) || canvas.getContext("2d")

    if (!context) {
        throw new Error("Could not prepare the selected image")
    }

    context.clearRect(0, 0, canvasW, canvasH)
    context.drawImage(image, 0, 0, canvasW, canvasH)

    // ── Stage 1: WebP with progressive quality reduction ─────────────────────
    // Floor is 0.60 — WebP at this quality is still visually excellent for
    // photography (roughly equivalent to JPEG q82) while being 3-4× smaller
    // than the same image as lossless PNG. An 8K photo at 24 MP fits comfortably
    // under 25 MB at q0.65–0.70 for most subjects.
    const QUALITY_START = 0.92
    const QUALITY_FLOOR = 0.60
    const QUALITY_STEP  = 0.04

    let blob = null
    for (let q = QUALITY_START; q >= QUALITY_FLOOR; q -= QUALITY_STEP) {
        const candidate = await canvasToBlob(canvas, "image/webp", q)
        if (candidate?.size && candidate.type === "image/webp" && candidate.size <= IMAGEKIT_MAX_BYTES) {
            blob = candidate
            break
        }
    }

    // ── Stage 2: JPEG fallback (lossy — never PNG for photos) ────────────────
    // PNG is lossless and produces files 3-5× larger than JPEG/WebP for photos,
    // so it is the wrong fallback. JPEG with its own quality ladder handles
    // browsers that don't support WebP encoding and extreme worst-case images.
    if (!blob) {
        for (let q = 0.88; q >= 0.55; q -= 0.05) {
            const candidate = await canvasToBlob(canvas, "image/jpeg", q)
            if (candidate?.size && candidate.size <= IMAGEKIT_MAX_BYTES) {
                blob = candidate
                break
            }
        }
    }

    // ── Stage 3: dimension reduction to 16 MP then WebP ──────────────────────
    // Only reached if the image is both extremely large AND extremely detailed
    // (e.g. synthetic noise patterns, dense HDR panoramas). Scales down to
    // 16 MP — still higher than any standard display — and retries WebP.
    if (!blob) {
        const FALLBACK_MP = 16_000_000
        const fbScale = Math.sqrt(FALLBACK_MP / (canvasW * canvasH))
        if (fbScale < 1) {
            const fbW = Math.max(1, Math.round(canvasW * fbScale))
            const fbH = Math.max(1, Math.round(canvasH * fbScale))
            const fbCanvas = document.createElement("canvas")
            fbCanvas.width = fbW
            fbCanvas.height = fbH
            const fbCtx = fbCanvas.getContext("2d") || fbCanvas.getContext("2d", { alpha: true })
            if (fbCtx) {
                fbCtx.drawImage(canvas, 0, 0, fbW, fbH)
                const candidate = await canvasToBlob(fbCanvas, "image/webp", 0.85)
                if (candidate?.size && candidate.size <= IMAGEKIT_MAX_BYTES) {
                    blob = candidate
                    canvasW = fbW
                    canvasH = fbH
                }
            }
        }
    }

    if (!blob?.size) {
        throw new Error("Could not encode the selected image")
    }

    if (blob.size > IMAGEKIT_MAX_BYTES) {
        throw new Error(
            `Image is still too large (${(blob.size / 1024 / 1024).toFixed(1)} MB) after compression. ` +
            `Try a smaller image or lower resolution.`
        )
    }

    const mimeToExt = { "image/webp": "webp", "image/jpeg": "jpg", "image/png": "png" }
    const extension = mimeToExt[blob.type] ?? "webp"
    const rasterFileName = `${getSafeBaseName(file.name)}-visible.${extension}`

    return {
        file: new File([blob], rasterFileName, {
            type: blob.type || `image/${extension}`,
            lastModified: Date.now(),
        }),
        width: canvasW,
        height: canvasH,
        rasterFileName,
    }
}

const NewProjectModel = ({ isOpen, onClose, currentProjectCount = 0 }) => {

    const [isUploading, setIsUploading] = useState(false)
    const [projectTitle, setProjectTitle] = useState("")
    const [selectedFile, setSelectedFile] = useState(null)
    const [previewUrl, setPreviewUrl] = useState(null)
    const [showUpgradeModel, setShowUpgradeModel] = useState(false)
    const router = useRouter()

    const { isFree, canCreateProject, isPro } = usePlanAccess()
    const canCreate = canCreateProject(currentProjectCount)

    const { mutate: createProject } = useDatabaseMutation(api.projects.create)

    const clearSelectedFile = () => {
        if (previewUrl) {
            URL.revokeObjectURL(previewUrl)
        }

        setSelectedFile(null)
        setPreviewUrl(null)
        setIsUploading(false)
        setProjectTitle("")
    }

    const onDrop = (acceptedFiles) => {
        const file = acceptedFiles[0]

        if (file) {
            setSelectedFile(file)
            setPreviewUrl(URL.createObjectURL(file))

            const nameWithoutExtension = file.name.replace(/\.[^/.]+$/, "")
            setProjectTitle(nameWithoutExtension || "Untitled Project")
        }
    }

    const onDropRejected = (fileRejections) => {
        const rejection = fileRejections[0]
        if (!rejection) return

        const code = rejection.errors?.[0]?.code
        if (code === "file-too-large") {
            toast.error("Image is too large — please use an image under 20 MB")
        } else if (code === "file-invalid-type") {
            toast.error("Unsupported image format — try PNG, JPEG, or WebP")
        } else {
            toast.error(rejection.errors?.[0]?.message || "Could not accept this file")
        }
    }

    const { getRootProps, getInputProps, isDragActive } = useDropzone({
        onDrop,
        onDropRejected,
        accept: {
            "image/*": [".png", ".jpg", ".webp", ".jpeg", ".gif", ".svg", ".avif", ".apng"]
        },
        maxFiles: 1,
        maxSize: 20 * 1024 * 1024,   // 20mb file size limit
        disabled: !canCreate || isUploading,
    })

    /** Standard raster formats that can go to ImageKit untouched */
    const DIRECT_UPLOAD_TYPES = new Set([
        "image/jpeg", "image/png", "image/webp", "image/avif",
    ])

    const handleCreateProject = async () => {
        if (!canCreate) {
            setShowUpgradeModel(true)
            return
        }

        if (!selectedFile || !projectTitle.trim()) {
            toast.error("Please select an image or enter a project title")
            return
        }

        setIsUploading(true)

        try {
            const formData = new FormData()
            formData.append("fileName", selectedFile.name)

            // Standard raster formats (JPEG, PNG, WebP, AVIF) can skip the
            // canvas rasterisation step — UNLESS the resolution exceeds
            // ImageKit's 25 MP serving limit. In that case we must downscale
            // through the canvas (fitToCanvasLimits caps at 24 MP).
            //
            // Non-raster / animated formats (SVG, GIF, APNG) always go through
            // the canvas so we get a clean static raster.

            // Read dimensions to decide the path
            const image = await loadImageFromObjectUrl(previewUrl)
            const origW = Math.round(image.naturalWidth  || image.width  || 0)
            const origH = Math.round(image.naturalHeight || image.height || 0)
            const megapixels = origW * origH
            const isStandardRaster = DIRECT_UPLOAD_TYPES.has(selectedFile.type)
            const canSkipRaster = isStandardRaster && megapixels <= IMAGEKIT_MAX_MP

            if (canSkipRaster) {
                // Strip EXIF, GPS, XMP, IPTC, comments — binary-level, no re-encoding
                const cleanFile = await stripImageMetadata(selectedFile)
                formData.append("file", cleanFile)
                formData.append("rasterWidth",  String(origW || 0))
                formData.append("rasterHeight", String(origH || 0))
                formData.append("sourceMetadata", JSON.stringify({
                    originalName: selectedFile.name,
                    originalType: selectedFile.type,
                    originalSize: selectedFile.size,
                    originalLastModified: selectedFile.lastModified,
                }))
            } else {
                const rasterizedImage = await rasterizeSelectedImage(selectedFile, previewUrl)
                formData.append("rasterFile", rasterizedImage.file)
                formData.append("rasterFileName", rasterizedImage.rasterFileName)
                formData.append("rasterWidth", String(rasterizedImage.width))
                formData.append("rasterHeight", String(rasterizedImage.height))
                formData.append("sourceMetadata", JSON.stringify({
                    originalName: selectedFile.name,
                    originalType: selectedFile.type,
                    originalSize: selectedFile.size,
                    originalLastModified: selectedFile.lastModified,
                    rasterizedType: rasterizedImage.file.type,
                    rasterizedSize: rasterizedImage.file.size,
                }))
            }

            const uploadResponse = await fetch("/api/imagekit/upload", {
                method: "POST",
                body: formData
            })

            // 401/403 = the Clerk session is missing or expired for this request
            // (common after a dev session times out, or when the app is opened on
            // a different host than the one you signed in on — Clerk's session
            // cookie is host-scoped). Guide the user back to sign in instead of
            // surfacing a raw "Unauthorised" error.
            if (uploadResponse.status === 401 || uploadResponse.status === 403) {
                toast.error("Your session has expired. Please sign in again.")
                router.push("/sign-in")
                return
            }

            const uploadData = await uploadResponse.json().catch(() => ({}))

            if (!uploadResponse.ok || !uploadData.success)
                throw new Error(uploadData.error || "Failed to upload the image")

            // Creating a project in Neon
            const projectId = await createProject({
                title: projectTitle.trim(),
                originalImageUrl: uploadData.url,
                currentImageUrl: uploadData.url,
                thumbnailUrl: uploadData.thumbnailUrl,
                width: uploadData.width || 800,
                height: uploadData.height || 600,
                canvasState: null,
            })

            if (!projectId) {
                return
            }

            toast.success("Project created successfully")
            router.push(`/editor/${projectId}`)

        } catch (error) {
            console.error("Error creating project:", error)
            toast.error(
                error.message || "Failed to create project. Please try again."
            )
        } finally {
            setIsUploading(false)
        }
    }

    return (
        <>

            <Dialog open={isOpen} onOpenChange={(open) => {
                if (!open) {
                    onClose()
                }
            }}>
                <DialogContent className="sm:max-w-2xl">
                    <DialogHeader>
                        <DialogTitle className="text-2xl font-bold text-white">
                            Create New Project
                        </DialogTitle>
                        <DialogDescription className="text-slate-300">
                            Start a fresh canvas from your dashboard. Free accounts can keep up to 3 projects at a time.
                        </DialogDescription>
                    </DialogHeader>

                    <div className='space-y-6'>
                        {isFree && currentProjectCount >= 2 &&
                            (<Alert className='bg-amber-500/10 border-amber-500/20'>
                                <Crown className='h-5 w-5 text-amber-400' />
                                <AlertDescription className="text-amber-400/80">
                                    <div className="font-semibold text-amber-400 mb-1">
                                        {currentProjectCount === 2
                                            ? "Last Free Project"
                                            : "Project Limit Reached"
                                        }
                                    </div>
                                </AlertDescription>
                                {!canCreate && (
                                    <AlertAction>
                                        <Button variant="outline" onClick={onClose}>Close</Button>
                                    </AlertAction>
                                )}
                            </Alert>)}

                        {/* Area for uploading images */}
                        {!selectedFile
                            ? <div
                                {...getRootProps()}
                                className={`border-2 border-dashed rounded-xl p-12 text-center cursor-pointer transition-all ${isDragActive
                                    ? "border-cyan-400 bg-cyan-400/5"
                                    : "border-white/20 hover:border-white/40"
                                    } ${!canCreate ? "opacity-50 pointer-events-none" : ""}`}
                            >
                                <input {...getInputProps()} />

                                <Upload className='h-12 w-12 text-white/50 mx-auto mb-4' />

                                <h3 className='text-xl font-semibold text-white mb-2'>
                                    {isDragActive ? "Drop your image here" : "Upload an Image"}
                                </h3>

                                <p className='mb-4 whitespace-nowrap text-sm text-white/70'>
                                    {canCreate
                                        ? "Drag and drop your image, or click to browse"
                                        : "Upgrade to Pro to create more projects"}
                                </p>{" "}

                                <p className='whitespace-nowrap text-xs text-white/50'>
                                    Supports all the image formats upto 20MB
                                </p>
                            </div>
                            : <div className='space-y-6'>
                                <div className='relative overflow-hidden rounded-xl border border-white/10 bg-[radial-gradient(circle_at_top,rgba(56,189,248,0.14),transparent_42%),linear-gradient(160deg,rgba(15,23,42,0.92),rgba(15,23,42,0.74))]'>
                                    <img
                                        className='h-64 w-full object-contain p-3'
                                        src={previewUrl}
                                        alt="Uploaded image preview" />

                                    <Button
                                        className='absolute top-2 right-2 bg-black/50 text-white hover:bg-black/100 rounded-md'
                                        variant='ghost'
                                        size='sm'
                                        onClick={clearSelectedFile}
                                    >
                                        <X className='h-4 w-4' />
                                    </Button>
                                </div>
                                <div className='space-y-2'>
                                    <Label htmlFor="project-title" className="text-white">
                                        Project Title
                                    </Label>
                                    <Input
                                        id="project-title"
                                        type="text"
                                        value={projectTitle}
                                        onChange={(e) => setProjectTitle(e.target.value)}
                                        onKeyDown={(e) => {
                                            // Enter submits the form when it's valid — no need to
                                            // reach for the Create button.
                                            if (e.key === 'Enter' && selectedFile && projectTitle.trim() && !isUploading) {
                                                e.preventDefault()
                                                handleCreateProject()
                                            }
                                        }}
                                        placeholder="Enter project name..."
                                        className={"bg-slate-700 border-white/20 text-white placeholder-white/50 focus:border-cyan-400 focus:ring-cyan-400"}
                                    >
                                    </Input>
                                </div>
                                <div className='bg-slate-700/50 rounded-lg p-4'>
                                    <div className='flex items-center gap-3'>
                                        <ImageIcon className='h-5 w-5 text-cyan-400' />
                                        <div>
                                            <p className='text-white font-medium'>
                                                {selectedFile.name}
                                            </p>
                                            <p className='text-white/70 text-sm'>
                                                {(selectedFile.size / 1024 / 1024).toFixed(2)} MB
                                            </p>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        }

                    </div>

                    {isFree && (
                        <Badge variant='secondary' className="bg-slate-700 text-white/70">
                            {currentProjectCount}/3 projects
                        </Badge>
                    )}
                    <DialogFooter>
                        <Button
                            className="text-white/70 hover:text-white"
                            variant="ghost"
                            onClick={onClose}
                            disabled={isUploading}
                        >
                            Cancel
                        </Button>

                        <Button
                            variant="primary"
                            onClick={handleCreateProject}
                            disabled={!selectedFile || !projectTitle.trim() || isUploading}
                        >
                            {isUploading
                                ? (
                                    <>
                                        <Loader2 className='h-4 w-4 animate-spin' />
                                    </>
                                ) : (
                                    "Create Project"
                                )
                            }
                        </Button>

                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <UpgradeModel
                isOpen={showUpgradeModel}
                onClose={() => { setShowUpgradeModel(false) }}
                restrictedTool="projects"
                isPro={isPro}
                reason="Free plan is limited to 3 projects. Upgrade to Pro 
                for unlimited projects and access to all AI editing tools."
            />
        </>
    )
}

export default NewProjectModel
