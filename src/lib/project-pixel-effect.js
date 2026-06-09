"use client"

const clamp = (value, min, max) => Math.min(Math.max(value, min), max)

const waitForPaint = () =>
    new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve))
    })

const cleanupAnimation = async (animation) => {
    try {
        await animation.finished
    } catch {
        /* animation was cancelled */
    }
}

const commitAndCancel = (animation) => {
    try {
        animation.commitStyles?.()
    } catch {
        /* commitStyles can fail after a cancelled animation */
    }

    try {
        animation.cancel()
    } catch {
        /* already inactive */
    }
}

const getCurrentKeyframe = (element, fallbackTransform) => {
    const styles = window.getComputedStyle(element)
    return {
        transform: styles.transform === "none" ? fallbackTransform : styles.transform,
        opacity: Number(styles.opacity || 1),
        filter: styles.filter === "none" ? "blur(0px) saturate(1)" : styles.filter,
    }
}

const stripDuplicateProjectIds = (clone) => {
    clone.removeAttribute("data-project-card-id")
    clone.querySelectorAll?.("[data-project-card-id]").forEach((node) => {
        node.removeAttribute("data-project-card-id")
    })
}

const buildGrid = (rect, reduced) => {
    // Finer grid → more particles → reads as fine dust, not chunks. Tile size
    // and clamp caps both shrink so smaller cards still get a dense field.
    const tileSize = reduced ? 14 : 6
    const columns = clamp(Math.ceil(rect.width / tileSize), reduced ? 12 : 24, reduced ? 26 : 64)
    const rows = clamp(Math.ceil(rect.height / tileSize), reduced ? 9 : 18, reduced ? 18 : 48)

    return {
        columns,
        rows,
        tileWidth: rect.width / columns,
        tileHeight: rect.height / rows,
    }
}

const createTile = ({ target, rect, column, row, columns, rows, tileWidth, tileHeight }) => {
    const x = column * tileWidth
    const y = row * tileHeight
    const width = column === columns - 1 ? rect.width - x : tileWidth
    const height = row === rows - 1 ? rect.height - y : tileHeight
    const tile = document.createElement("div")

    tile.className = "project-pixel-tile"
    tile.style.left = `${x}px`
    tile.style.top = `${y}px`
    tile.style.width = `${Math.max(1, width)}px`
    tile.style.height = `${Math.max(1, height)}px`

    const clone = target.cloneNode(true)
    stripDuplicateProjectIds(clone)
    clone.classList.add("project-pixel-clone")
    clone.style.position = "absolute"
    clone.style.left = `${-x}px`
    clone.style.top = `${-y}px`
    clone.style.width = `${rect.width}px`
    clone.style.height = `${rect.height}px`
    clone.style.maxWidth = "none"
    clone.style.margin = "0"
    clone.style.opacity = "1"
    clone.style.transform = "none"
    clone.style.pointerEvents = "none"
    // The glass-panel uses a semi-transparent background + backdrop-filter.
    // Inside the fixed overlay the backdrop-filter is disabled (see CSS) so
    // the card would be nearly invisible. Replace with an opaque background
    // that approximates the original look.
    clone.style.background = "#0E1118"
    clone.style.backdropFilter = "none"
    clone.style.webkitBackdropFilter = "none"
    clone.style.boxShadow = "none"
    clone.style.border = "none"

    tile.appendChild(clone)
    return tile
}

const createMotion = ({ rect, column, row, columns, rows, reduced }) => {
    // Diagonal wave: tiles dust off in a sweep from top-left → bottom-right,
    // matching the Thanos-snap wave that crosses the body before the whole thing
    // is gone. Higher coefficient on column than row → slight up-right tilt.
    const waveProgress = (column / Math.max(1, columns - 1)) * 0.65
        + (row / Math.max(1, rows - 1)) * 0.35
    const xNorm = columns <= 1 ? 0 : column / (columns - 1) - 0.5
    const yNorm = rows <= 1 ? 0 : row / (rows - 1) - 0.5

    // Directional wind, not radial scatter. Everything drifts up-and-right with
    // small per-tile randomness so the field looks like ash blown off a body
    // rather than a firework exploding outward.
    const windX = reduced ? 26 : 48
    const windY = reduced ? -34 : -72
    const jitterX = (Math.random() - 0.5) * (reduced ? 28 : 56) + xNorm * (reduced ? 18 : 36)
    const jitterY = (Math.random() - 0.5) * (reduced ? 22 : 42) + yNorm * (reduced ? 10 : 24)
    const driftX = windX + jitterX
    const driftY = windY + jitterY

    // Slight rotation and aggressive shrink — tiles become particles, not chunks.
    const rotation = (Math.random() - 0.5) * (reduced ? 12 : 30)
    const scale = (reduced ? 0.55 : 0.32) + Math.random() * (reduced ? 0.18 : 0.22)

    // Per-tile delay along the diagonal wave, plus a small random jitter so the
    // wave looks organic rather than mechanical.
    const waveSpan = reduced ? 220 : 460
    const delay = Math.max(
        0,
        waveProgress * waveSpan + Math.random() * (reduced ? 24 : 60)
    )
    // Vary per-tile duration so some particles vanish fast and others trail.
    const duration = (reduced ? 420 : 720) + Math.random() * (reduced ? 180 : 360)
    const reverseDelay = Math.max(
        0,
        (1 - waveProgress) * (reduced ? 80 : 160) + Math.random() * (reduced ? 12 : 26)
    )

    return {
        delay,
        reverseDelay,
        duration,
        end: `translate3d(${driftX}px, ${driftY}px, 0) rotate(${rotation}deg) scale(${scale})`,
    }
}

export const createProjectPixelDissolver = async (target, options = {}) => {
    if (!(target instanceof HTMLElement)) return null

    const rect = target.getBoundingClientRect()
    if (!Number.isFinite(rect.width) || !Number.isFinite(rect.height) || rect.width < 2 || rect.height < 2) {
        return null
    }

    const reduced = options.reduced === true
    const { columns, rows, tileWidth, tileHeight } = buildGrid(rect, reduced)
    const overlay = document.createElement("div")
    overlay.className = "project-pixel-overlay"
    overlay.style.left = `${rect.left}px`
    overlay.style.top = `${rect.top}px`
    overlay.style.width = `${rect.width}px`
    overlay.style.height = `${rect.height}px`
    document.body.appendChild(overlay)

    const pieces = []

    for (let row = 0; row < rows; row += 1) {
        for (let column = 0; column < columns; column += 1) {
            const tile = createTile({ target, rect, column, row, columns, rows, tileWidth, tileHeight })
            const motion = createMotion({ rect, column, row, columns, rows, reduced })
            overlay.appendChild(tile)
            pieces.push({
                element: tile,
                start: "translate3d(0, 0, 0) rotate(0deg) scale(1)",
                ...motion,
            })
        }
    }

    let activeAnimations = []
    let removed = false

    const setSourceHidden = (hidden) => {
        target.classList.toggle("project-pixel-source-hidden", hidden)
    }

    const stopActiveAnimations = () => {
        activeAnimations.forEach(commitAndCancel)
        activeAnimations = []
    }

    const run = async (mode) => {
        if (removed) return
        stopActiveAnimations()
        setSourceHidden(true)
        await waitForPaint()

        const isDisintegrating = mode === "disintegrate"
        const animations = pieces.map((piece) => {
            const from = getCurrentKeyframe(piece.element, isDisintegrating ? piece.start : piece.end)
            // 3-keyframe disintegrate gives the "still solid → flaking → gone" arc.
            // Saturation drops, brightness lifts (ash glow), blur opens up.
            const keyframes = isDisintegrating
                ? [
                      from,
                      {
                          transform: piece.start,
                          opacity: 0.78,
                          filter: "blur(0.6px) saturate(0.55) brightness(1.05)",
                          offset: 0.35,
                      },
                      {
                          transform: piece.end,
                          opacity: 0,
                          filter: "blur(3.2px) saturate(0.18) brightness(1.18)",
                      },
                  ]
                : [from, { transform: piece.start, opacity: 1, filter: "blur(0px) saturate(1) brightness(1)" }]

            return piece.element.animate(keyframes, {
                delay: isDisintegrating ? piece.delay : piece.reverseDelay,
                duration: isDisintegrating ? piece.duration : Math.max(260, piece.duration * 0.72),
                easing: isDisintegrating ? "cubic-bezier(0.32, 0.04, 0.46, 1)" : "cubic-bezier(0.16, 1, 0.3, 1)",
                fill: "forwards",
            })
        })

        activeAnimations = animations
        await Promise.allSettled(animations.map(cleanupAnimation))
        if (activeAnimations === animations) activeAnimations = []
    }

    return {
        target,
        overlay,
        async disintegrate() {
            await run("disintegrate")
        },
        async integrate() {
            await run("integrate")
            setSourceHidden(false)
            this.cleanup()
        },
        cleanup() {
            if (removed) return
            removed = true
            stopActiveAnimations()
            overlay.remove()
            setSourceHidden(false)
        },
    }
}
