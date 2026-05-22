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
    const tileSize = reduced ? 22 : 14
    const columns = clamp(Math.ceil(rect.width / tileSize), reduced ? 8 : 12, reduced ? 16 : 30)
    const rows = clamp(Math.ceil(rect.height / tileSize), reduced ? 6 : 8, reduced ? 12 : 22)

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

    tile.appendChild(clone)
    return tile
}

const createMotion = ({ rect, column, row, columns, rows, reduced }) => {
    const xNorm = columns <= 1 ? 0 : column / (columns - 1) - 0.5
    const yNorm = rows <= 1 ? 0 : row / (rows - 1) - 0.5
    const distance = Math.hypot(xNorm, yNorm)
    const randomX = (Math.random() - 0.5) * (reduced ? 32 : 72)
    const randomY = (Math.random() - 0.5) * (reduced ? 22 : 48)
    const driftX = xNorm * (rect.width * 0.38 + 52) + randomX
    const driftY = yNorm * (rect.height * 0.28) - (reduced ? 22 : 56) + randomY
    const rotation = (Math.random() - 0.5) * (reduced ? 10 : 28)
    const scale = 0.82 + Math.random() * 0.24
    const wave = row * (reduced ? 10 : 18) + column * (reduced ? 2 : 4)
    const delay = Math.max(0, wave + distance * (reduced ? 12 : 28) + Math.random() * (reduced ? 8 : 28))
    const reverseDelay = Math.max(0, (rows - row - 1) * (reduced ? 6 : 10) + Math.random() * (reduced ? 8 : 18))

    return {
        delay,
        reverseDelay,
        duration: (reduced ? 360 : 560) + distance * (reduced ? 60 : 180),
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
            const to = isDisintegrating
                ? { transform: piece.end, opacity: 0, filter: "blur(1.8px) saturate(0.8)" }
                : { transform: piece.start, opacity: 1, filter: "blur(0px) saturate(1)" }

            return piece.element.animate([from, to], {
                delay: isDisintegrating ? piece.delay : piece.reverseDelay,
                duration: isDisintegrating ? piece.duration : Math.max(260, piece.duration * 0.72),
                easing: isDisintegrating ? "cubic-bezier(0.22, 1, 0.36, 1)" : "cubic-bezier(0.16, 1, 0.3, 1)",
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
