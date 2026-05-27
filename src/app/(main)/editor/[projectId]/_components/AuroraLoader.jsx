"use client"

import { motion } from "framer-motion"

// Phase-specific subtitles. Adding a new phase only needs one line here.
const PHASE_LABELS = {
  generating: "Computing pixels",
  blending: "Blending edges",
  applying: "Applying to canvas",
  uploading: "Uploading",
  analyzing: "Analyzing image",
}

const PROGRESS_BLOCK_COUNT = 8

const AuroraLoader = ({ message, phase }) => {
  const phaseLabel = phase && phase !== "initial" ? PHASE_LABELS[phase] : null
  const headline = (message || "Processing").toString()

  return (
    <div className="neo-loader" role="status" aria-live="polite">
      {/* ── Header row: brand mark + kicker + status pill ────────────── */}
      <div className="neo-loader-header">
        <div className="neo-loader-mark" aria-hidden="true">
          N
        </div>
        <div className="neo-loader-kicker">
          <span>System</span>
          <em>Status</em>
        </div>
        <div className="neo-loader-pill">
          <span className="neo-loader-dot" aria-hidden="true" />
          LIVE
        </div>
      </div>

      {/* ── Body: headline + segmented progress + phase ──────────────── */}
      <div className="neo-loader-body">
        <h2 className="neo-loader-headline">{headline}</h2>

        <div className="neo-loader-progress" aria-hidden="true">
          {Array.from({ length: PROGRESS_BLOCK_COUNT }).map((_, index) => (
            <motion.span
              key={index}
              className="neo-loader-block"
              animate={{ opacity: [0.15, 1, 0.15] }}
              transition={{
                duration: 1.4,
                repeat: Infinity,
                ease: "easeInOut",
                delay: index * 0.12,
              }}
            />
          ))}
        </div>

        <div className="neo-loader-phase">
          <span>{phaseLabel || "Standby"}</span>
        </div>
      </div>

      {/* ── Footer: tabular telemetry strip ──────────────────────────── */}
      <div className="neo-loader-footer">
        <span>READ</span>
        <em>STDIN</em>
        <span className="neo-loader-divider" aria-hidden="true">
          ·
        </span>
        <em>WAIT</em>
      </div>
    </div>
  )
}

export default AuroraLoader
