/**
 * Extract dominant colors from an image URL
 * Uses canvas to analyze pixel data and return the most prominent colors
 */

export const extractDominantColors = async (imageUrl, colorCount = 5) => {
  return new Promise((resolve) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    
    img.onload = () => {
      const canvas = document.createElement('canvas')
      const ctx = canvas.getContext('2d')
      
      // Resize for performance
      const maxSize = 100
      const scale = Math.min(maxSize / img.width, maxSize / img.height)
      canvas.width = img.width * scale
      canvas.height = img.height * scale
      
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
      
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
      const pixels = imageData.data
      
      const colorMap = {}
      
      // Sample pixels (every 10th pixel for performance)
      for (let i = 0; i < pixels.length; i += 40) {
        const r = pixels[i]
        const g = pixels[i + 1]
        const b = pixels[i + 2]
        const a = pixels[i + 3]
        
        // Skip transparent pixels
        if (a < 128) continue
        
        // Quantize colors to group similar colors
        const quantize = (value) => Math.round(value / 32) * 32
        const key = `${quantize(r)},${quantize(g)},${quantize(b)}`
        
        colorMap[key] = (colorMap[key] || 0) + 1
      }
      
      // Sort by frequency
      const sortedColors = Object.entries(colorMap)
        .sort((a, b) => b[1] - a[1])
        .slice(0, colorCount)
        .map(([key]) => {
          const [r, g, b] = key.split(',').map(Number)
          return { r, g, b, hex: rgbToHex(r, g, b) }
        })
      
      resolve(sortedColors)
    }
    
    img.onerror = () => {
      // Return default colors if image fails to load
      resolve([
        { r: 0, g: 229, b: 255, hex: '#00E5FF' },
        { r: 200, g: 149, b: 108, hex: '#C8956C' },
      ])
    }
    
    img.src = imageUrl
  })
}

const rgbToHex = (r, g, b) => {
  return '#' + [r, g, b].map(x => {
    const hex = Math.round(x).toString(16)
    return hex.length === 1 ? '0' + hex : hex
  }).join('')
}

/**
 * Calculate the contrasting color (black or white) for a given color
 * Based on luminance
 */
export const getContrastingColor = (r, g, b) => {
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255
  return luminance > 0.5 ? '#000000' : '#FFFFFF'
}

/**
 * Get a lighter or darker shade of a color
 */
export const adjustColorBrightness = (hex, amount) => {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  
  const adjust = (value) => Math.max(0, Math.min(255, value + amount))
  
  return rgbToHex(adjust(r), adjust(g), adjust(b))
}

/**
 * Convert hex to RGB
 */
export const hexToRgb = (hex) => {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex)
  return result ? {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16)
  } : null
}

/* ───────────────────────────────────────────────────────────────────────────
 * Adaptive, WCAG-correct text color
 *
 * getContrastingColor() above contrasts against a FULL color, which is correct
 * for SOLID fills. But our "active/selected" UI states paint the photo's
 * dominant color at a LOW alpha over a dark panel, so the painted background is
 * mostly the dark panel — picking text by contrasting against the full (often
 * light) dominant then yields black text that disappears on the dark surface.
 *
 * The fix: composite the tint over the surface exactly like the browser does,
 * then choose the text color with the highest WCAG contrast against that REAL
 * painted color. This makes text adapt to the photo automatically and stay
 * readable in every state (faint tint → light text, solid fill → dark/light to
 * suit, etc.).
 * ─────────────────────────────────────────────────────────────────────────── */

const _srgbToLinear = (channel) => {
  const c = channel / 255
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

/** WCAG 2.x relative luminance (0 = black … 1 = white). */
export const relativeLuminance = ({ r, g, b }) =>
  0.2126 * _srgbToLinear(r) + 0.7152 * _srgbToLinear(g) + 0.0722 * _srgbToLinear(b)

/** WCAG contrast ratio between two opaque colors (1:1 … 21:1). */
export const contrastRatio = (a, b) => {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/**
 * Alpha-composite a foreground over an opaque background in sRGB space —
 * matched to how the browser blends `rgba()` over a solid fill, so the result
 * equals what's actually on screen.
 */
export const compositeOver = (fg, bg, alpha) => {
  const a = Math.max(0, Math.min(1, alpha))
  return {
    r: Math.round(fg.r * a + bg.r * (1 - a)),
    g: Math.round(fg.g * a + bg.g * (1 - a)),
    b: Math.round(fg.b * a + bg.b * (1 - a)),
  }
}

/** Coerce a hex/rgb()/rgba() string or {r,g,b} object to {r,g,b}. */
const _toRgb = (color, fallback) => {
  if (!color) return fallback
  if (typeof color === 'object') return color
  const hex = hexToRgb(color)
  if (hex) return hex
  const m = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(color)
  return m ? { r: +m[1], g: +m[2], b: +m[3] } : fallback
}

const _rgbToHslArr = (r, g, b) => {
  r /= 255; g /= 255; b /= 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  const l = (max + min) / 2
  let h = 0, s = 0
  if (max !== min) {
    const d = max - min
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6
    else if (max === g) h = ((b - r) / d + 2) / 6
    else h = ((r - g) / d + 4) / 6
  }
  return [h * 360, s * 100, l * 100]
}

const _hslToRgbObj = (h, s, l) => {
  h /= 360; s /= 100; l /= 100
  if (s === 0) { const v = Math.round(l * 255); return { r: v, g: v, b: v } }
  const hue2 = (p, q, t) => {
    if (t < 0) t += 1
    if (t > 1) t -= 1
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  return {
    r: Math.round(hue2(p, q, h + 1 / 3) * 255),
    g: Math.round(hue2(p, q, h) * 255),
    b: Math.round(hue2(p, q, h - 1 / 3) * 255),
  }
}

/**
 * Pick the most readable text color for a tint painted over a surface.
 *
 * @param {string|{r,g,b}} tint     photo's dominant color (hex / rgb() / {r,g,b})
 * @param {string|{r,g,b}} surface  panel color the tint is painted on top of
 * @param {number}         alpha    opacity the tint is painted at (0..1; 1 = solid)
 * @param {object}         [opts]   { hue?: echo the photo hue in the text when it
 *                                    stays readable (default true);
 *                                    min?: contrast floor (default 4.5 — WCAG AA) }
 * @returns {{ color:string, ratio:number, passes:boolean, background:string }}
 */
export const adaptiveTextColor = (tint, surface = '#0E1118', alpha = 1, opts = {}) => {
  const { hue = true, min = 4.5 } = opts
  const tintRgb = _toRgb(tint, { r: 0, g: 0, b: 0 })
  const surfaceRgb = _toRgb(surface, { r: 14, g: 17, b: 24 })
  const bg = alpha >= 1 ? tintRgb : compositeOver(tintRgb, surfaceRgb, alpha)

  // Two safe anchors from the design system: warm off-white and near-black.
  const LIGHT = { r: 244, g: 242, b: 232 }
  const DARK = { r: 10, g: 11, b: 14 }
  const goLight = contrastRatio(LIGHT, bg) >= contrastRatio(DARK, bg)
  let chosen = goLight ? LIGHT : DARK

  // Optionally echo the photo's hue in the text for a cohesive look — but only
  // keep the tinted variant when it still clears the contrast floor, so cohesion
  // never costs readability.
  if (hue) {
    const [h, s] = _rgbToHslArr(tintRgb.r, tintRgb.g, tintRgb.b)
    const tinted = goLight
      ? _hslToRgbObj(h, Math.min(s, 18), 95)
      : _hslToRgbObj(h, Math.min(s, 28), 8)
    if (contrastRatio(tinted, bg) >= Math.max(min, 4.5)) chosen = tinted
  }

  return {
    color: rgbToHex(chosen.r, chosen.g, chosen.b),
    ratio: contrastRatio(chosen, bg),
    passes: contrastRatio(chosen, bg) >= min,
    background: rgbToHex(bg.r, bg.g, bg.b),
  }
}
