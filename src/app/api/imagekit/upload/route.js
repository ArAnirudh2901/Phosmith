import { auth } from "@clerk/nextjs/server";
import ImageKit from "imagekit";
import { NextResponse } from "next/server";
import { enforceRateLimit, rateLimitResponse } from "@/lib/rate-limit";

let imagekit = null

const getImageKit = () => {
    if (!imagekit) {
        imagekit = new ImageKit({
            publicKey: process.env.NEXT_PUBLIC_IMAGEKIT_PUBLIC_KEY,
            privateKey: process.env.IMAGEKIT_PRIVATE_KEY,
            urlEndpoint: process.env.NEXT_PUBLIC_IMAGEKIT_URL_ENDPOINT
        })
    }

    return imagekit
}

const isUploadableFile = (value) =>
    value && typeof value.arrayBuffer === "function" && Number(value.size || 0) > 0

const getFormString = (formData, key) => {
    const value = formData.get(key)
    return typeof value === "string" ? value : ""
}

const sanitizeFileName = (fileName) =>
    String(fileName || "upload")
        .replace(/[/\\?%*:|"<>]/g, "_")
        .replace(/[^a-zA-Z0-9._-]/g, "_")
        .replace(/_+/g, "_")
        .slice(0, 140) || "upload"

export async function POST(request) {
    try {
        const { userId } = await auth()
        if (!userId) {
            return NextResponse.json({ error: "Unauthorised" }, { status: 401 })
        }

        // 30 uploads / minute / user — high enough that a multi-image add
        // batch won't trip; low enough that an abusive script can't drain
        // the org's ImageKit storage credits.
        const limitResult = await enforceRateLimit("imagekit-upload", userId)
        const limited = rateLimitResponse(limitResult)
        if (limited) return limited

        const formData = await request.formData()
        const file = formData.get("file")
        const rasterFile = formData.get("rasterFile")
        const fileName = getFormString(formData, "fileName")
        const rasterFileName = getFormString(formData, "rasterFileName")
        const usingRasterFile = isUploadableFile(rasterFile)
        const uploadFile = usingRasterFile ? rasterFile : file

        if (!isUploadableFile(uploadFile))
            return NextResponse.json({ error: "No file provided" }, { status: 400 })

        const bytes = await uploadFile.arrayBuffer()
        const buffer = Buffer.from(bytes)

        const timestamp = Date.now()
        const uploadName = usingRasterFile
            ? rasterFileName || uploadFile.name || fileName
            : fileName || uploadFile.name
        const sanitizedFileName = sanitizeFileName(uploadName)

        const uniqueFileName = `${userId}/${timestamp}_${sanitizedFileName}`

        const ik = getImageKit()
        const uploadResponse = await ik.upload({
            file: buffer,
            fileName: uniqueFileName,
            folder: "/yt-projects"
        })

        const thumbnailUrl = ik.url({
            src: uploadResponse.url,
            transformation: [
                {
                    width: 400,
                    height: 300,
                    cropMode: "maintain_ar",
                    quality: "80"
                },
            ],
        })

        return NextResponse.json({
            success: true,
            url: uploadResponse.url,
            thumbnailUrl: thumbnailUrl,
            fileId: uploadResponse.fileId,
            width: uploadResponse.width || Number(getFormString(formData, "rasterWidth")) || undefined,
            height: uploadResponse.height || Number(getFormString(formData, "rasterHeight")) || undefined,
            size: uploadResponse.size,
            name: uploadResponse.name,
            source: usingRasterFile ? "browser-raster" : "raw-upload",
        })
    } catch (error) {
        console.error("ImageKit upload error", error)

        return NextResponse.json({
            success: false,
            error: "Failed to upload image",
            details: error.message,
        },
            { status: 500 }
        )
    }
}
