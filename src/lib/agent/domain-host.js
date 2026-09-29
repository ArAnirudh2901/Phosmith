// Lazy registration of the agent's five command domains: ~500 KB (stretch engine,
// CV core, collage solvers) that only matters once a command runs. The canvas
// publishes its accessors here; this module imports nothing.

let host = null
let pending = null
let offs = []

/** Publish the canvas accessors. Returns a teardown that also unregisters. */
export function setDomainHost(next) {
    host = next
    return () => {
        if (host !== next) return
        host = null
        pending = null
        for (const off of offs) {
            try { off() } catch { /* a domain that never registered */ }
        }
        offs = []
    }
}

/** Load and register the domains once. Resolves false when no canvas is mounted. */
export function ensureDomains() {
    if (!host) return Promise.resolve(false)
    if (pending) return pending
    const owner = host
    pending = Promise.all([
        import('@/lib/agent/command-registry'),
        import('@/lib/agent/mask-commands'),
        import('@/lib/agent/crop-commands'),
        import('@/lib/agent/collage-commands'),
        import('@/lib/agent/focus-commands'),
        import('@/lib/agent/stretch-commands'),
    ]).then(([reg, mask, crop, collage, focus, stretch]) => {
        // Canvas remounted mid-fetch: registering now would target a dead canvas.
        if (host !== owner) return false
        const { getPrimaryImage, getCanvas, getProject } = owner
        offs = [
            reg.registerDomain('mask', mask.createMaskCommands({ getPrimaryImage })),
            reg.registerDomain('crop', crop.createCropCommands({ getPrimaryImage, getCanvas })),
            reg.registerDomain('collage', collage.createCollageCommands({ getCanvas, getProject })),
            reg.registerDomain('focus', focus.createFocusCommands({ getPrimaryImage, getCanvas })),
            reg.registerDomain('stretch', stretch.createStretchCommands({ getPrimaryImage, getCanvas })),
        ]
        // Test hook, like the Mask tool's: proves the lazy load reached the registry.
        if (typeof window !== 'undefined') {
            window.__phosmith = window.__phosmith || {}
            window.__phosmith.agentDomains = offs.length
        }
        return true
    }).catch(() => {
        pending = null
        return false
    })
    return pending
}
