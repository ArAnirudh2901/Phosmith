"use client"

import { useState, useRef } from "react"
import { motion, AnimatePresence } from "framer-motion"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import GlassSlider from "@/components/GlassSlider"
import { Wand2, ChevronRight, ChevronLeft, Square, Circle, Monitor, Smartphone, Maximize2, Sparkles, Eye, EyeOff, RotateCcw } from "lucide-react"
import { useCanvas } from "../../../../../../context/context"
import { useDatabaseMutation, useDatabaseQuery } from "../../../../../../hooks/useDatabaseQuery"
import usePlanAccess from "../../../../../../hooks/usePlanAccess"
import { api } from "@/lib/neon-api";
import { serializeCanvasState } from "../../../../../lib/canvas-state"

const DIRECTIONS = [
  { id: "top", icon: ChevronLeft, label: "Expand Up" },
  { id: "bottom", icon: ChevronRight, label: "Expand Down" },
  { id: "left", icon: ChevronLeft, label: "Expand Left" },
  { id: "right", icon: ChevronRight, label: "Expand Right" },
]

const ASPECT_RATIOS = [
  { id: "free", label: "Free", icon: Square },
  { id: "1:1", label: "1:1", icon: Circle },
  { id: "16:9", label: "16:9", icon: Monitor },
  { id: "4:3", label: "4:3", icon: Monitor },
  { id: "9:16", label: "9:16", icon: Smartphone },
]

const FloatingToolbar = ({
  visible = false,
  position = { x: 0, y: 0 },
  onGenerate,
  onDirectionChange,
  onThresholdChange,
  threshold = 50,
  selectedDirections = [],
  isGenerating = false,
}) => {
  const [prompt, setPrompt] = useState("")
  const [selectedRatio, setSelectedRatio] = useState("free")
  const [showRatioDropdown, setShowRatioDropdown] = useState(false)
  const [showThreshold, setShowThreshold] = useState(true)

  const inputRef = useRef(null)
  const { hasAccess } = usePlanAccess()
  const canUseTool = hasAccess("ai_extender")

  const handleRatioSelect = (ratio) => {
    setSelectedRatio(ratio.id)
    setShowRatioDropdown(false)
  }

  const handleDirectionToggle = (directionId) => {
    const newDirections = selectedDirections.includes(directionId)
      ? selectedDirections.filter((d) => d !== directionId)
      : [...selectedDirections, directionId]
    onDirectionChange?.(newDirections)
  }

  const handleGenerate = () => {
    if (!prompt.trim()) return
    onGenerate?.({ prompt: prompt.trim(), aspectRatio: selectedRatio, threshold, directions: selectedDirections })
  }

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey && prompt.trim()) {
      e.preventDefault()
      handleGenerate()
    }
    e.stopPropagation()
  }

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          className="fixed z-40"
          style={{
            left: position.x,
            top: position.y,
            transform: "translateX(-50%)",
          }}
          initial={{ opacity: 0, scale: 0.85, y: -12 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.9, y: -8 }}
          transition={{ type: "spring", stiffness: 400, damping: 22, mass: 0.8 }}
        >
          <div className="relative rounded-2xl px-4 py-3 shadow-[0_16px_48px_rgba(0,0,0,0.5)] glass-panel border-[var(--glass-border)]"
            style={{ backdropFilter: 'blur(28px) saturate(1.6)', WebkitBackdropFilter: 'blur(28px) saturate(1.6)' }}>

            {/* Particle effects during generation */}
            {isGenerating && (
              <svg className="absolute inset-0 w-full h-full pointer-events-none overflow-visible">
                {Array.from({ length: 12 }, (_, i) => {
                  // Stable pseudo-random offsets so particle positions don't jitter on every render.
                  const angle = (i / 12) * 360
                  const radius = 40 + ((i * 7) % 20)
                  const radiusJitter = 2 + ((i * 3) % 3)
                  return (
                    <motion.circle
                      key={i}
                      cx={50 + Math.cos((angle * Math.PI) / 180) * radius}
                      cy={50 + Math.sin((angle * Math.PI) / 180) * radius}
                      r={radiusJitter}
                      fill="var(--accent-ink)"
                      initial={{ opacity: 0.8 }}
                      animate={{ opacity: [0.8, 0.2, 0.8], scale: [1, 1.8, 1] }}
                      transition={{ duration: 1.5, repeat: Infinity, ease: "easeInOut", delay: i * 0.1 }}
                    />
                  )
                })}
              </svg>
            )}

            {/* Drag handle */}
            <div className="absolute -top-1 left-1/2 -translate-x-1/2 flex items-center gap-0.5">
              <motion.div className="w-6 h-1 rounded-full" style={{ background: 'var(--border-default)' }} whileHover={{ scale: 1.2 }} />
            </div>

            <div className="flex items-center gap-3 mt-1">
              {/* Direction indicators */}
              <div className="flex items-center gap-1">
                {DIRECTIONS.map((dir) => {
                  const Icon = dir.icon
                  const isActive = selectedDirections.includes(dir.id)
                  return (
                    <motion.button
                      key={dir.id}
                      type="button"
                      onClick={() => handleDirectionToggle(dir.id)}
                      className="flex items-center justify-center w-8 h-8 rounded-full pill-control"
                      style={{
                        background: isActive ? 'rgba(6, 184, 212, 0.15)' : 'rgba(255, 255, 255, 0.03)',
                        border: isActive ? '1px solid var(--accent-ink)' : '1px solid rgba(255, 255, 255, 0.06)',
                        color: isActive ? 'var(--accent-ink)' : 'var(--text-muted)',
                      }}
                      whileTap={{ scale: 0.9 }}
                      whileHover={{ scale: 1.08 }}
                      title={dir.label}
                    >
                      <Icon className="h-3.5 w-3.5" />
                    </motion.button>
                  )
                })}
              </div>

              <div className="w-px h-8 rounded-full" style={{ background: 'var(--border-subtle)' }} />

              {/* Prompt input */}
              <div className="relative flex-1 min-w-[160px]">
                <input
                  ref={inputRef}
                  type="text"
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Describe what to generate..."
                  className="w-full bg-transparent text-sm px-3 py-1.5 rounded-full outline-none"
                  style={{
                    background: 'rgba(255, 255, 255, 0.04)',
                    border: '1px solid var(--border-subtle)',
                    color: 'var(--text-primary)',
                  }}
                />
                {prompt.trim() && (
                  <motion.div className="absolute right-3 top-1/2 -translate-y-1/2" initial={{ scale: 0, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}>
                    <Sparkles className="h-3 w-3" style={{ color: 'var(--accent-ink)' }} />
                  </motion.div>
                )}
              </div>

              {/* Threshold slider */}
              {showThreshold && (
                <div className="flex items-center gap-2" style={{ minWidth: 130 }}>
                  <GlassSlider min={0} max={100} step={1} value={threshold} onChange={(v) => onThresholdChange?.(v)} unit="%" showValue />
                </div>
              )}

              {/* Aspect ratio dropdown */}
              <div className="relative">
                <motion.button
                  type="button"
                  onClick={() => setShowRatioDropdown(!showRatioDropdown)}
                  className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[10px] font-medium pill-control"
                  style={{ background: 'rgba(255, 255, 255, 0.04)', border: '1px solid var(--border-subtle)', color: 'var(--text-primary)' }}
                  whileTap={{ scale: 0.95 }}
                >
                  {ASPECT_RATIOS.find((r) => r.id === selectedRatio)?.label || "Free"}
                  <ChevronRight className="h-3 w-3 opacity-50 rotate-90" />
                </motion.button>

                <AnimatePresence>
                  {showRatioDropdown && (
                    <motion.div
                      className="absolute bottom-full left-0 mb-2 min-w-[90px] rounded-xl py-1 shadow-2xl overflow-hidden"
                      style={{ background: 'var(--glass-bg-heavy)', border: '1px solid var(--glass-border)' }}
                      initial={{ opacity: 0, y: 8, scale: 0.96 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, y: 4, scale: 0.96 }}
                      transition={{ duration: 0.15 }}
                    >
                      {ASPECT_RATIOS.map((ratio) => (
                        <button key={ratio.id} type="button" onClick={() => handleRatioSelect(ratio)}
                          className={`flex w-full items-center px-3 py-1.5 text-[10px] transition ${selectedRatio === ratio.id ? 'font-medium' : ''}`}
                          style={{
                            background: selectedRatio === ratio.id ? 'var(--bg-hover)' : 'transparent',
                            color: selectedRatio === ratio.id ? 'var(--accent-ink)' : 'var(--text-primary)',
                          }}
                        >
                          {ratio.label}
                        </button>
                      ))}
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>

              {/* Generate button */}
              <motion.button
                onClick={handleGenerate}
                disabled={isGenerating || !prompt.trim()}
                className="flex items-center gap-2 rounded-full px-4 py-2 text-[10px] font-bold pill-control"
                style={{
                  background: isGenerating ? 'var(--glass-bg-heavy)' : 'linear-gradient(135deg, var(--accent-ink), var(--accent-ink-deep))',
                  color: isGenerating ? 'var(--text-muted)' : '#07090E',
                  border: 'none',
                  boxShadow: !isGenerating && prompt.trim() && canUseTool ? '0 0 24px rgba(6,184,212,0.2)' : 'none',
                  opacity: !canUseTool ? 0.5 : 1,
                }}
                whileTap={canUseTool ? { scale: 0.95 } : {}}
                whileHover={canUseTool ? { scale: 1.04 } : {}}
              >
                {isGenerating ? (
                  <>
                    <motion.div animate={{ rotate: 360 }} transition={{ duration: 1, repeat: Infinity, ease: "linear" }}>
                      <Wand2 className="h-3.5 w-3.5" />
                    </motion.div>
                    Generating
                  </>
                ) : (
                  <>
                    <Sparkles className="h-3.5 w-3.5" />
                    Generate
                  </>
                )}
              </motion.button>

              {/* Toggle threshold */}
              <motion.button
                type="button" onClick={() => setShowThreshold(!showThreshold)}
                className="flex items-center justify-center w-7 h-7 rounded-full pill-control"
                style={{ background: 'rgba(255,255,255,0.03)', borderColor: 'rgba(255,255,255,0.06)', color: 'var(--text-muted)' }}
                whileTap={{ scale: 0.9 }}
                title="Toggle threshold"
              >
                {showThreshold ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
              </motion.button>
            </div>

            {/* Edge blend indicator */}
            <motion.div className="mt-2 pt-2 flex items-center gap-2" style={{ borderTop: '1px solid var(--border-subtle)' }}>
              <div className="flex-1 h-0.5 rounded-full overflow-hidden" style={{ background: 'var(--bg-elevated)' }}>
                <motion.div className="h-full rounded-full"
                  style={{ background: 'linear-gradient(90deg, var(--accent-ink), var(--accent-magenta))' }}
                  initial={{ width: '0%' }} animate={{ width: `${threshold}%` }} transition={{ duration: 0.3 }}
                />
              </div>
              <span className="text-[9px]" style={{ color: 'var(--text-muted)' }}>Blend</span>
              <motion.div className="w-1.5 h-1.5 rounded-full" animate={{ scale: [1, 1.3, 1], opacity: [0.5, 1, 0.5] }}
                transition={{ duration: 2, repeat: Infinity }} style={{ background: 'var(--accent-ink)' }} />
            </motion.div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

export default FloatingToolbar