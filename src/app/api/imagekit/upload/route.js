import { auth } from "@clerk/nextjs/server";
import ImageKit from "imagekit";
import { NextResponse } from "next/server";
import { enforceRateLimit, rateLimitResponse } from "@/lib/rate-limit";

// Signs browser uploads; the file goes from the browser straight to ImageKit
// (src/lib/imagekit-upload.js). Uploading through this route capped every file
// at the host's request-body limit (4.5 MB on Vercel). The name prefix keeps
// each user's files under their own id, as the server-side upload did.

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

export async function GET() {
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

        // One-time token, signature and expiry (30 min) for one upload.
        const { token, expire, signature } = getImageKit().getAuthenticationParameters()
        return NextResponse.json(
            {
                token,
                expire,
                signature,
                publicKey: process.env.NEXT_PUBLIC_IMAGEKIT_PUBLIC_KEY,
                folder: "/yt-projects",
                namePrefix: `${userId}/${Date.now()}_`,
            },
            { headers: { "Cache-Control": "no-store" } },
        )
    } catch (error) {
        console.error("ImageKit upload auth error", error)
        return NextResponse.json({ error: "Could not authorise the upload" }, { status: 500 })
    }
}
