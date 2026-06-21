"use client"

import { useState, useEffect, useRef, useCallback } from 'react'
import { FastAverageColor } from 'fast-average-color'

const fac = new FastAverageColor()

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  let h = 0, s = 0
  const l = (max + min) / 2
  if (max !== min) {
    const d = max - min
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break
      case g: h = ((b - r) / d + 2) / 6; break
      case b: h = ((r - g) / d + 4) / 6; break
    }
  }
  return [Math.round(h * 360), s * 100, l * 100]
}

function hslToRgb(h, s, l) {
  h /= 360; s /= 100; l /= 100
  if (s === 0) {
    const v = Math.round(l * 255)
    return [v, v, v]
  }
  const hue2rgb = (p, q, t) => {
    if (t < 0) t += 1
    if (t > 1) t -= 1
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  return [
    Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
    Math.round(hue2rgb(p, q, h) * 255),
    Math.round(hue2rgb(p, q, h - 1 / 3) * 255),
  ]
}

function hslToHex(h, s, l) {
  const [r, g, b] = hslToRgb(h, s, l)
  return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('')
}

export const DEFAULT_PALETTE = {
  accent: '#00E5FF',
  accentRgb: '0, 229, 255',
  textOnAccent: '#03050A',
  isDark: true,
  panelBg: '#07090E',
  elevatedBg: '#0E1118',
  surfaceBg: '#141820',
  textPrimary: '#F4F2E8',
  textSecondary: '#C7C3B5',
  textMuted: '#9A988C',
  borderSubtle: 'rgba(255, 255, 255, 0.10)',
  borderDefault: 'rgba(255, 255, 255, 0.16)',
  borderStrong: 'rgba(255, 255, 255, 0.28)',
  accentWash: 'rgba(0, 229, 255, 0.09)',
}

function buildPalette(r, g, b) {
  const spread = Math.max(r, g, b) - Math.min(r, g, b)
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b

  // Near-grayscale image: no meaningful hue, stay with neutral defaults
  if (spread < 28) {
    return { ...DEFAULT_PALETTE, isDark: luminance < 128 }
  }

  const [h, s] = rgbToHsl(r, g, b)

  // Hue-tinted dark backgrounds. Saturation is kept assertive (55% of the
  // source, capped at 40) so the tint is VISIBLY different across different
  // images — a blue-sky photo → dark-blue panel, a sunset → warm-amber panel.
  const panelS = Math.min(s * 0.55, 40)
  const panelBg    = hslToHex(h, panelS, 7.0)
  const elevatedBg = hslToHex(h, panelS, 11.0)
  const surfaceBg  = hslToHex(h, panelS, 16.0)

  // Accent: lift dark-image colors toward a readable brightness
  const lift = luminance < 150 ? 0.62 : 0
  const nr = Math.round(r + (255 - r) * lift)
  const ng = Math.round(g + (255 - g) * lift)
  const nb = Math.round(b + (255 - b) * lift)
  const accent    = `rgb(${nr}, ${ng}, ${nb})`
  const accentRgb = `${nr}, ${ng}, ${nb}`

  // Text on accent surface: meets 4.5:1 contrast requirement
  const accentLum  = 0.2126 * nr + 0.7152 * ng + 0.0722 * nb
  const textOnAccent = accentLum > 140 ? '#03050A' : '#F4F2E8'

  // Text hierarchy: slightly tinted toward the dominant hue, always
  // high-contrast against the very dark panel backgrounds above.
  const textPrimary   = hslToHex(h, Math.min(s * 0.14, 15), 93)
  const textSecondary = hslToHex(h, Math.min(s * 0.12, 12), 75)
  const textMuted     = hslToHex(h, Math.min(s * 0.10, 10), 58)

  // Borders: mid-saturation tint at varying opacities
  const [br, bg_, bb] = hslToRgb(h, Math.min(s * 0.5, 45), 55)
  const borderSubtle  = `rgba(${br}, ${bg_}, ${bb}, 0.12)`
  const borderDefault = `rgba(${br}, ${bg_}, ${bb}, 0.22)`
  const borderStrong  = `rgba(${br}, ${bg_}, ${bb}, 0.38)`

  // Wash: the accent at low opacity for gradient overlays (more visible than a flat tint)
  const accentWash = `rgba(${accentRgb}, 0.09)`

  return {
    accent, accentRgb, textOnAccent,
    isDark: luminance < 128,
    panelBg, elevatedBg, surfaceBg,
    textPrimary, textSecondary, textMuted,
    borderSubtle, borderDefault, borderStrong,
    accentWash,
  }
}

export function useDynamicAccent(imageUrl) {
  const [palette, setPalette] = useState(DEFAULT_PALETTE)
  const lastUrlRef = useRef(null)

  const extract = useCallback(async (url) => {
    if (!url || lastUrlRef.current === url) return
    lastUrlRef.current = url

    try {
      const color = await fac.getColorAsync(url, {
        algorithm: 'simple',
        crossOrigin: 'anonymous',
      })
      setPalette(buildPalette(color.value[0], color.value[1], color.value[2]))
    } catch {
      setPalette(DEFAULT_PALETTE)
    }
  }, [])

  useEffect(() => {
    extract(imageUrl)
  }, [imageUrl, extract])

  return palette
}
