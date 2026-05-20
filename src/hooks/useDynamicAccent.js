"use client"

import { useState, useEffect, useRef, useCallback } from 'react'
import { FastAverageColor } from 'fast-average-color'

const fac = new FastAverageColor()

const DEFAULT_ACCENT = '#00E5FF'
const DEFAULT_ACCENT_RGB = '0, 229, 255'

const getReadableAccent = (r, g, b) => {
  const spread = Math.max(r, g, b) - Math.min(r, g, b)
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b
  if (spread < 28) return { accent: DEFAULT_ACCENT, accentRgb: DEFAULT_ACCENT_RGB }

  const lift = luminance < 150 ? 0.62 : 0
  const nr = Math.round(r + (255 - r) * lift)
  const ng = Math.round(g + (255 - g) * lift)
  const nb = Math.round(b + (255 - b) * lift)
  return { accent: `rgb(${nr}, ${ng}, ${nb})`, accentRgb: `${nr}, ${ng}, ${nb}` }
}

export function useDynamicAccent(imageUrl) {
  const [accent, setAccent] = useState(DEFAULT_ACCENT)
  const [accentRgb, setAccentRgb] = useState('0, 229, 255')
  const [isDark, setIsDark] = useState(true)
  const lastUrlRef = useRef(null)

  const extractAccent = useCallback(async (url) => {
    if (!url) return
    if (lastUrlRef.current === url) return
    lastUrlRef.current = url

    try {
      const color = await fac.getColorAsync(url, {
        algorithm: 'simple',
        crossOrigin: 'anonymous',
      })
      const r = color.value[0]
      const g = color.value[1]
      const b = color.value[2]
      const readableAccent = getReadableAccent(r, g, b)
      setAccent(readableAccent.accent)
      setAccentRgb(readableAccent.accentRgb)
      setIsDark(color.isDark)
    } catch {
      setAccent(DEFAULT_ACCENT)
      setAccentRgb(DEFAULT_ACCENT_RGB)
      setIsDark(true)
    }
  }, [])

  useEffect(() => {
    extractAccent(imageUrl)
  }, [imageUrl, extractAccent])

  return { accent, accentRgb, isDark }
}
