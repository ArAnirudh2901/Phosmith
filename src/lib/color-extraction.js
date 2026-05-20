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
