"use client"

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"

const clamp = (value, min, max) => Math.max(min, Math.min(max, value))

const formatValue = (value, step) => {
  if (typeof value !== "number") return value
  return value.toFixed(step < 1 ? 1 : 0)
}

const GlassSlider = ({
  min = 0,
  max = 100,
  step = 1,
  value = 50,
  onChange,
  label,
  unit = "",
  showValue = true,
  accentColor = "var(--accent-primary)",
  disabled = false,
  className = "",
}) => {
  const shellRef = useRef(null)
  const trackRef = useRef(null)
  const localValueRef = useRef(value)
  const emitFrameRef = useRef(null)
  const lastEmittedRef = useRef(value)
  const [isDragging, setIsDragging] = useState(false)
  const [isHovered, setIsHovered] = useState(false)
  const [localValue, setLocalValue] = useState(value)

  const safeRange = max === min ? 1 : max - min
  const percentage = clamp(((localValue - min) / safeRange) * 100, 0, 100)
  const displayValue = `${formatValue(localValue, step)}${unit}`
  const centerPercentage = min < 0 && max > 0 ? clamp(((0 - min) / safeRange) * 100, 0, 100) : null
  const showFloatingValue = showValue && !label && (isDragging || isHovered)

  useEffect(() => {
    if (!isDragging && value !== lastEmittedRef.current) {
      localValueRef.current = value
      lastEmittedRef.current = value
      setLocalValue(value)
    }
  }, [isDragging, value])

  useEffect(() => () => {
    if (emitFrameRef.current) cancelAnimationFrame(emitFrameRef.current)
  }, [])

  const trackStyle = useMemo(
    () => ({
      background:
        "linear-gradient(180deg, rgba(30,39,53,0.98), rgba(15,21,31,0.98))",
      border: "1px solid rgba(255,255,255,0.18)",
      boxShadow:
        "inset 0 1px 0 rgba(255,255,255,0.08), 0 10px 22px rgba(0,0,0,0.24)",
    }),
    [],
  )

  const getValueFromPointer = useCallback(
    (clientX) => {
      const rect = trackRef.current?.getBoundingClientRect()
      if (!rect) return localValueRef.current

      const ratio = clamp((clientX - rect.left) / rect.width, 0, 1)
      const rawValue = min + ratio * safeRange
      const steppedValue = Math.round(rawValue / step) * step

      return clamp(Number(steppedValue.toFixed(10)), min, max)
    },
    [max, min, safeRange, step],
  )

  const scheduleChange = useCallback((nextValue) => {
    localValueRef.current = nextValue
    setLocalValue(nextValue)
    if (nextValue === lastEmittedRef.current) return

    if (emitFrameRef.current) cancelAnimationFrame(emitFrameRef.current)
    emitFrameRef.current = requestAnimationFrame(() => {
      emitFrameRef.current = null
      lastEmittedRef.current = localValueRef.current
      onChange?.(localValueRef.current)
    })
  }, [onChange])

  const commitPointerValue = useCallback(
    (event) => {
      if (disabled) return
      const nextValue = getValueFromPointer(event.clientX)
      scheduleChange(nextValue)
    },
    [disabled, getValueFromPointer, scheduleChange],
  )

  const handlePointerDown = useCallback(
    (event) => {
      if (disabled) return
      event.preventDefault()
      setIsDragging(true)
      commitPointerValue(event)
      shellRef.current?.setPointerCapture?.(event.pointerId)
    },
    [commitPointerValue, disabled],
  )

  const handlePointerMove = useCallback(
    (event) => {
      if (!isDragging || disabled) return
      commitPointerValue(event)
    },
    [commitPointerValue, disabled, isDragging],
  )

  const handlePointerUp = useCallback(
    (event) => {
      setIsDragging(false)
      if (emitFrameRef.current) {
        cancelAnimationFrame(emitFrameRef.current)
        emitFrameRef.current = null
      }
      if (localValueRef.current !== lastEmittedRef.current) {
        lastEmittedRef.current = localValueRef.current
        onChange?.(localValueRef.current)
      }
      shellRef.current?.releasePointerCapture?.(event.pointerId)
    },
    [onChange],
  )

  const handleKeyDown = useCallback(
    (event) => {
      if (disabled) return

      let nextValue = localValueRef.current

      if (event.key === "ArrowRight" || event.key === "ArrowUp") {
        nextValue = Math.min(max, localValueRef.current + step)
      } else if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
        nextValue = Math.max(min, localValueRef.current - step)
      } else if (event.key === "Home") {
        nextValue = min
      } else if (event.key === "End") {
        nextValue = max
      } else {
        return
      }

      event.preventDefault()
      scheduleChange(nextValue)
    },
    [disabled, max, min, scheduleChange, step],
  )

  return (
    <div className={`w-full select-none ${disabled ? "opacity-50" : ""} ${className}`}>
      {label && (
        <div className="mb-2 flex items-center justify-between gap-3">
          <span className="truncate text-[12px] font-semibold text-[var(--text-primary)]">
            {label}
          </span>
          {showValue && (
            <span
              className="min-w-[48px] rounded-md px-2 py-1 text-center text-[11px] font-bold tabular-nums text-white"
              style={{
                background:
                  "linear-gradient(180deg, rgba(54,65,83,0.96), rgba(25,34,48,0.96))",
                border: "1px solid rgba(255,255,255,0.20)",
                boxShadow:
                  "inset 0 1px 0 rgba(255,255,255,0.10), 0 6px 16px rgba(0,0,0,0.22)",
              }}
            >
              {displayValue}
            </span>
          )}
        </div>
      )}

      <div
        ref={shellRef}
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-disabled={disabled}
        aria-label={label || "slider"}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={localValue}
        aria-valuetext={displayValue}
        className="group relative h-8 cursor-pointer touch-none rounded-lg outline-none transition-transform duration-100 focus-visible:ring-2 focus-visible:ring-cyan-300/70 focus-visible:ring-offset-2 focus-visible:ring-offset-[#07090e]"
        style={trackStyle}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
        onKeyDown={handleKeyDown}
      >
        <div className="pointer-events-none absolute inset-[1px] rounded-[7px] bg-[linear-gradient(120deg,rgba(255,255,255,0.08),transparent_42%,rgba(255,255,255,0.04)_72%,transparent)]" />
        <div className="pointer-events-none absolute left-3 right-3 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-black/55 shadow-[inset_0_1px_2px_rgba(0,0,0,0.62),0_1px_0_rgba(255,255,255,0.08)]">
          <div
            ref={trackRef}
            className="absolute inset-0 rounded-full"
          />

          {centerPercentage !== null && (
            <div
              className="absolute top-1/2 h-4 w-px -translate-y-1/2 rounded-full bg-white/35"
              style={{ left: `${centerPercentage}%` }}
            />
          )}

          <div
            className="absolute inset-y-0 left-0 rounded-full transition-[box-shadow] duration-100"
            style={{
              width: `${percentage}%`,
              background: `linear-gradient(90deg, color-mix(in srgb, ${accentColor} 72%, #EAF6FF), ${accentColor})`,
              boxShadow: isDragging
                ? `0 0 18px color-mix(in srgb, ${accentColor} 56%, transparent), inset 0 1px 0 rgba(255,255,255,0.44)`
                : `0 0 10px color-mix(in srgb, ${accentColor} 34%, transparent), inset 0 1px 0 rgba(255,255,255,0.28)`,
            }}
          />

          <div
            className="absolute top-1/2 rounded-full transition-[transform,box-shadow] duration-100"
            style={{
              left: `${percentage}%`,
              width: 18,
              height: 18,
              transform: `translate(-50%, -50%) scale(${isDragging ? 1.08 : 1})`,
              background:
                "linear-gradient(180deg, #FFFFFF, #C9D4E3)",
              border: "1px solid rgba(255,255,255,0.92)",
              boxShadow: isDragging
                ? "0 0 0 6px rgba(255,255,255,0.14), 0 0 22px rgba(255,255,255,0.32), 0 8px 16px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.96)"
                : "0 0 0 3px rgba(255,255,255,0.08), 0 6px 14px rgba(0,0,0,0.32), inset 0 1px 0 rgba(255,255,255,0.96)",
            }}
          >
            <div className="absolute left-[5px] top-[4px] h-[4px] w-[4px] rounded-full bg-white/95 blur-[0.2px]" />
          </div>
        </div>

        {showFloatingValue && (
          <div
            className="pointer-events-none absolute -top-8 rounded-md px-2 py-1 text-[11px] font-bold tabular-nums text-white shadow-[0_10px_28px_rgba(0,0,0,0.28)]"
            style={{
              left: `${percentage}%`,
              transform: "translateX(-50%)",
              background:
                "linear-gradient(180deg, rgba(54,65,83,0.98), rgba(20,27,39,0.98))",
              border: "1px solid rgba(255,255,255,0.20)",
            }}
          >
            {displayValue}
          </div>
        )}
      </div>
    </div>
  )
}

export default GlassSlider
