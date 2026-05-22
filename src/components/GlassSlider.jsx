"use client"

import { ProRulerSlider } from "@/components/editor/ProRulerSlider"

/**
 * Editor slider — wraps ProRulerSlider for consistent instrument-style controls.
 */
const GlassSlider = ({
  min = 0,
  max = 100,
  step = 1,
  value = 50,
  onChange,
  label,
  unit = "",
  showValue = true,
  accentColor = "#5eb8ff",
  fillColor,
  disabled = false,
  className = "",
}) => {
  const displayLabel = label || (showValue ? "Amount" : "Adjust")
  const suffix = unit || ""

  return (
    <ProRulerSlider
      className={className}
      label={displayLabel}
      value={value}
      min={min}
      max={max}
      step={step}
      suffix={suffix}
      disabled={disabled}
      onChange={onChange}
      visual={{
        fill: fillColor ?? "rgba(35, 58, 92, 0.52)",
        accent: accentColor,
        trackBg: "rgba(20, 24, 32, 0.98)",
      }}
    />
  )
}

export default GlassSlider
