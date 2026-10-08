// Uploads go from the browser straight to ImageKit; our server only signs them
// (GET /api/imagekit/upload). Through our own route every upload was capped by
// the host's request-body limit — 4.5 MB on Vercel — and a DSLR photo, a 4096 px
// stretch bake or a 24 MP fill result is over it.

const UPLOAD_URL = 'https://upload.imagekit.io/api/v1/files/upload'

export const sanitizeFileName = (fileName) =>
    String(fileName || 'upload')
        .replace(/[/\\?%*:|"<>]/g, '_')
        .replace(/[^a-zA-Z0-9._-]/g, '_')
        .replace(/_+/g, '_')
        .slice(0, 140) || 'upload'

// Same 400×300 thumbnail the server used to build with the SDK.
const thumbnailFor = (url) => `${url}${url.includes('?') ? '&' : '?'}tr=w-400,h-300,cm-maintain_ar,q-80`

// `stage` tells our own refusal (auth: signed out, rate limit) from ImageKit's.
const fail = (message, status, stage) => Object.assign(new Error(message), { status, stage })

/**
 * Upload a File/Blob to the project's ImageKit folder.
 * @returns {Promise<{ url, thumbnailUrl, fileId, width, height, size, name }>}
 */
export async function uploadToImageKit(file, { fileName, signal } = {}) {
    if (!file) throw fail('Nothing to upload', 400, 'input')
    const authResp = await fetch('/api/imagekit/upload', { cache: 'no-store', signal })
    const auth = await authResp.json().catch(() => null)
    if (!authResp.ok || !auth?.signature) {
        throw fail(auth?.error || `Upload was not authorised (${authResp.status})`, authResp.status, 'auth')
    }
    const name = `${auth.namePrefix || ''}${sanitizeFileName(fileName || file.name)}`
    const form = new FormData()
    form.append('file', file, name)
    form.append('fileName', name)
    form.append('folder', auth.folder)
    form.append('publicKey', auth.publicKey)
    form.append('signature', auth.signature)
    form.append('expire', String(auth.expire))
    form.append('token', auth.token)
    const resp = await fetch(UPLOAD_URL, { method: 'POST', body: form, signal })
    const data = await resp.json().catch(() => null)
    if (!resp.ok || !data?.url) throw fail(`Upload failed: ${data?.message || resp.status}`, resp.status, 'upload')
    return {
        url: data.url,
        thumbnailUrl: thumbnailFor(data.url),
        fileId: data.fileId,
        width: data.width,
        height: data.height,
        size: data.size,
        name: data.name,
    }
}
