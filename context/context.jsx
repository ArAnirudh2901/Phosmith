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
    isDark: true,
})

export const useDynamicAccent = () => useContext(DynamicAccentContext)