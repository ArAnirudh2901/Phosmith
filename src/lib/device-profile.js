/**
 * device-profile — can this device run SlimSAM in the browser comfortably?
 *
 * Decides what the Selection engine's "Auto" picks (`ai-routing.js`), and the
 * card shows the reasons in plain words, so the choice is never a mystery.
 * Signals are the ones browsers actually expose; a missing signal is unknown,
 * never "low" (Safari and Firefox report no `deviceMemory`).
 *
 * Pure (`assessDevice`) plus one reader of `navigator` (`readDeviceSignals`).
 */

// navigator.deviceMemory is bucketed (0.25…8) and capped at 8.
export const LOW_MEMORY_GB = 4
// The browser's WASM path is pinned to one thread (no cross-origin isolation),
// so without WebGPU a small CPU spends seconds on every image encode.
export const LOW_CORES = 4

/**
 * @param {{ memoryGb?: number|null, cores?: number|null, webgpu?: boolean|null, saveData?: boolean }} signals
 * @returns {{ low: boolean, reasons: string[], memoryGb: number|null, cores: number|null, webgpu: boolean|null, saveData: boolean }}
 */
export const assessDevice = ({ memoryGb = null, cores = null, webgpu = null, saveData = false } = {}) => {
    const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null)
    const mem = num(memoryGb)
    const cpu = num(cores)
    const gpu = typeof webgpu === 'boolean' ? webgpu : null
    const reasons = []
    if (mem != null && mem <= LOW_MEMORY_GB) reasons.push(`${mem} GB of memory`)
    if (gpu === false && cpu != null && cpu <= LOW_CORES) reasons.push(`no WebGPU and ${cpu} CPU cores`)
    // The device model is a 40 MB download; Data Saver asked us not to.
    if (saveData === true) reasons.push('Data Saver is on')
    return { low: reasons.length > 0, reasons, memoryGb: mem, cores: cpu, webgpu: gpu, saveData: saveData === true }
}

export const readDeviceSignals = () => {
    if (typeof navigator === 'undefined') return {}
    let saveData = false
    try { saveData = Boolean((navigator.connection || navigator.webkitConnection)?.saveData) } catch { /* unknown */ }
    return {
        memoryGb: navigator.deviceMemory ?? null,
        cores: navigator.hardwareConcurrency ?? null,
        // Presence only: requestAdapter is async and can still fail later, which
        // the device path already survives (WebGPU → WASM retry).
        webgpu: 'gpu' in navigator ? Boolean(navigator.gpu) : false,
        saveData,
    }
}

let cached = null
/** This device's profile, read once per page (signals do not change mid-session). */
export const getDeviceProfile = () => {
    if (!cached) cached = assessDevice(readDeviceSignals())
    return cached
}
