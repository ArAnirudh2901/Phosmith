import { createContext, useContext } from "react";

export const CanvasContext = createContext(null)

export const useCanvas = () => {
    const context = useContext(CanvasContext)

    if (!context) {
        throw new Error("useCanvas must be used within a CanvasContext.Provider")
    }

    return context
}

export const DynamicAccentContext = createContext({
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
})

export const useDynamicAccent = () => useContext(DynamicAccentContext)
