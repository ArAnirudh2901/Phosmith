"use client"

import { motion } from "framer-motion"

/*
 * ─── Page Loading Overlay ───
 * Shimmer + ink dissolve on initial load
 */

const AuroraLoader = ({ message, phase }) => {
  return (
    <div className="relative z-10 flex flex-col items-center gap-6">
      {/* Ink drop Lottie-style animated ring */}
      <motion.div
        className="relative w-24 h-24"
        animate={{ rotate: 360, scale: [1, 1.05, 1] }}
        transition={{ duration: 3, repeat: Infinity, ease: "linear" }}
      >
        <div className="absolute inset-0 rounded-full border-2 border-[#00E5FF]/30" />
        <div className="absolute inset-0 rounded-full border-2 border-transparent border-t-[#D946EF]/50" />
        <div className="absolute inset-2 rounded-full border border-[#C8956C]/20" />
        <div className="absolute inset-3 rounded-full bg-[#0A0E14]" />
        <motion.div
          className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-2 h-2 rounded-full"
          style={{ background: "#00E5FF", boxShadow: "0 0 12px #00E5FF, 0 0 24px #00E5FF/0.5" }}
          animate={{ scale: [1, 1.5, 1], opacity: [0.6, 1, 0.6] }}
          transition={{ duration: 1.5, repeat: Infinity }}
        />
      </motion.div>

      {/* Processing text */}
      <div className="text-center">
        <motion.p
          className="text-sm font-medium text-white"
          animate={{ opacity: [0.6, 1, 0.6] }}
          transition={{ duration: 1.5, repeat: Infinity }}
        >
          {message || "Processing..."}
        </motion.p>
        {phase && phase !== "initial" && (
          <motion.p
            className="text-[11px] text-[var(--text-muted)] mt-1"
            initial={{ opacity: 0, y: 5 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3 }}
          >
            {phase === "generating" && "AI models computing..."}
            {phase === "blending" && "Blending edges seamlessly..."}
            {phase === "applying" && "Applying to canvas..."}
          </motion.p>
        )}
      </div>
    </div>
  )
}

export default AuroraLoader