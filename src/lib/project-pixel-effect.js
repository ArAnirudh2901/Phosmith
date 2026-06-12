"use client"

// Canvas2d pixel-particle disintegration effect.
// Captures the project card thumbnail to a canvas, samples pixels, then
// animates individual pixel-quads flying off (Thanos-snap style wave).
// Reverse mode (integrate) reassembles the card from scattered particles.

const CARD_BG = "#0E1118"

const waitForPaint = () =>
    new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))

const loadImage = (src) =>
    new Promise((resolve, reject) => {
        const img = new Image()
        img.crossOrigin = "anonymous"
        img.onload = () => resolve(img)
        img.onerror = () => reject(new Error("load"))
        // Browser-cached images resolve in <5ms; only real fetches hit the timeout.
        setTimeout(() => reject(new Error("timeout")), 4000)
        img.src = src
    })

const captureElement = async (target, rect) => {
    const w = Math.max(1, Math.round(rect.width))
    const h = Math.max(1, Math.round(rect.height))
    const canvas = document.createElement("canvas")
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext("2d", { willReadFrequently: true })

    // Card base background
    ctx.fillStyle = CARD_BG
    ctx.fillRect(0, 0, w, h)

    // Extract thumbnail from background-image CSS, draw it cover-fit
    const bgDiv = target.querySelector('[style*="background-image"]')
    const urlMatch = bgDiv?.style?.backgroundImage?.match(/url\(["']?([^"')]+)["']?\)/)
    if (urlMatch?.[1]) {
        try {
            const img = await loadImage(urlMatch[1])
            const scale = Math.max(w / img.naturalWidth, h / img.naturalHeight)
            const dw = img.naturalWidth * scale
            const dh = img.naturalHeight * scale
            ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh)
        } catch {
            /* keep base color */
        }
    }

    // Dark gradient overlay to match the card's visual (bottom fade)
    const grad = ctx.createLinearGradient(0, h * 0.25, 0, h)
    grad.addColorStop(0, "rgba(0,0,0,0)")
    grad.addColorStop(0.5, "rgba(0,0,0,0.4)")
    grad.addColorStop(1, "rgba(0,0,0,0.85)")
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, w, h)

    return ctx.getImageData(0, 0, w, h)
}

const easeOutCubic = (t) => 1 - (1 - t) ** 3

const buildParticles = (imageData, ox, oy, reduced) => {
    const { data, width, height } = imageData
    // Particle size = sample stride. Smaller → finer dust, more particles.
    const skip = reduced ? 4 : 3
    const particles = []

    for (let py = 0; py < height; py += skip) {
        for (let px = 0; px < width; px += skip) {
            const i = (py * width + px) * 4
            const a = data[i + 3]
            if (a < 8) continue

            // Diagonal wave: sweeps top-left → bottom-right like the Thanos snap.
            const xNorm = width > 1 ? px / (width - 1) - 0.5 : 0
            const yNorm = height > 1 ? py / (height - 1) - 0.5 : 0
            const wave = (px / Math.max(1, width - 1)) * 0.65 + (py / Math.max(1, height - 1)) * 0.35
            const waveSpan = reduced ? 220 : 460

            // Directional wind upward-right, with per-particle jitter so the
            // field looks like ash blown off rather than a radial firework.
            const windX = reduced ? 26 : 48
            const windY = reduced ? -34 : -72
            const driftX = windX + (Math.random() - 0.5) * (reduced ? 28 : 56) + xNorm * (reduced ? 18 : 36)
            const driftY = windY + (Math.random() - 0.5) * (reduced ? 22 : 42) + yNorm * (reduced ? 10 : 24)

            const delay = Math.max(0, wave * waveSpan + Math.random() * (reduced ? 24 : 60))
            const duration = (reduced ? 420 : 720) + Math.random() * (reduced ? 180 : 360)
            const reverseDelay = Math.max(
                0,
                (1 - wave) * (reduced ? 80 : 160) + Math.random() * (reduced ? 12 : 26),
            )

            particles.push({
                x: ox + px,
                y: oy + py,
                size: skip,
                r: data[i],
                g: data[i + 1],
                b: data[i + 2],
                alpha: a / 255,
                colorStr: `rgb(${data[i]},${data[i + 1]},${data[i + 2]})`,
                driftX,
                driftY,
                delay,
                duration,
                reverseDelay,
            })
        }
    }

    return particles
}

export const createProjectPixelDissolver = async (target, options = {}) => {
    if (!(target instanceof HTMLElement)) return null

    const rect = target.getBoundingClientRect()
    if (
        !Number.isFinite(rect.width) ||
        !Number.isFinite(rect.height) ||
        rect.width < 2 ||
        rect.height < 2
    ) {
        return null
    }

    const reduced = options.reduced === true

    // Capture thumbnail pixels. Image is almost always browser-cached
    // (it was displayed in the card), so this resolves in < 10ms typically.
    const imageData = await captureElement(target, rect)
    const particles = buildParticles(
        imageData,
        rect.left + window.scrollX,
        rect.top + window.scrollY,
        reduced,
    )
    if (particles.length === 0) return null

    // Full-viewport canvas: all particle movement is drawn here.
    const animCanvas = document.createElement("canvas")
    animCanvas.className = "project-pixel-canvas"
    animCanvas.width = window.innerWidth
    animCanvas.height = window.innerHeight
    document.body.appendChild(animCanvas)
    const animCtx = animCanvas.getContext("2d")

    let rafId = null
    let removed = false

    const setSourceHidden = (hidden) =>
        target.classList.toggle("project-pixel-source-hidden", hidden)

    const stopRaf = () => {
        if (rafId != null) {
            cancelAnimationFrame(rafId)
            rafId = null
        }
    }

    const run = (mode) =>
        new Promise((resolve) => {
            if (removed) { resolve(); return }
            stopRaf()
            setSourceHidden(true)

            const dis = mode === "disintegrate"
            const scrollX = window.scrollX
            const scrollY = window.scrollY
            const cw = animCanvas.width
            const ch = animCanvas.height
            let t0 = null

            const frame = (now) => {
                if (removed) { resolve(); return }
                if (t0 === null) t0 = now
                const elapsed = now - t0

                animCtx.clearRect(0, 0, cw, ch)
                let pending = 0

                for (const p of particles) {
                    const delay = dis ? p.delay : p.reverseDelay
                    const t = Math.min(1, Math.max(0, (elapsed - delay) / p.duration))
                    if (t < 1) pending++

                    const progress = easeOutCubic(t)
                    let drawX, drawY, alpha

                    if (dis) {
                        drawX = p.x - scrollX + p.driftX * progress
                        drawY = p.y - scrollY + p.driftY * progress
                        // Stays bright until ~half-way, then fades quickly (t²).
                        alpha = p.alpha * (1 - t * t)
                    } else {
                        // Integrate: reassemble from scattered → origin.
                        drawX = p.x - scrollX + p.driftX * (1 - progress)
                        drawY = p.y - scrollY + p.driftY * (1 - progress)
                        alpha = p.alpha * progress
                    }

                    if (alpha < 0.01) continue
                    const ix = Math.round(drawX)
                    const iy = Math.round(drawY)
                    if (ix + p.size <= 0 || ix >= cw || iy + p.size <= 0 || iy >= ch) continue

                    animCtx.globalAlpha = alpha
                    animCtx.fillStyle = p.colorStr
                    animCtx.fillRect(ix, iy, p.size, p.size)
                }

                // Reset globalAlpha so nothing else is affected.
                animCtx.globalAlpha = 1

                if (pending === 0) {
                    rafId = null
                    resolve()
                } else {
                    rafId = requestAnimationFrame(frame)
                }
            }

            rafId = requestAnimationFrame(frame)
        })

    return {
        target,
        animCanvas,
        async disintegrate() {
            await waitForPaint()
            await run("disintegrate")
        },
        async integrate() {
            await waitForPaint()
            await run("integrate")
            // Clear before showing source to avoid 1-frame double-render.
            animCtx.clearRect(0, 0, animCanvas.width, animCanvas.height)
            setSourceHidden(false)
            this.cleanup()
        },
        cleanup() {
            if (removed) return
            removed = true
            stopRaf()
            animCtx.clearRect(0, 0, animCanvas.width, animCanvas.height)
            animCanvas.remove()
            setSourceHidden(false)
        },
    }
}
