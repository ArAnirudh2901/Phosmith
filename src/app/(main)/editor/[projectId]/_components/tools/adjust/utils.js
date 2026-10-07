export const clamp = (v, min, max) => Math.max(min, Math.min(max, v))

export const stripHex = (hex) => String(hex || "000000").replace("#", "").slice(0, 6).padEnd(6, "0")

export const signedToken = (value) => (value < 0 ? `N${Math.abs(value)}` : `${value}`)

export const imageKitOpacity = (opacity) => Math.round(clamp(opacity, 0, 100) * 0.99)
    .toString(10)
    .padStart(2, "0")
