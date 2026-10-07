import { motion } from 'framer-motion'
import { Loader2, Sparkles, Wallpaper } from 'lucide-react'
import { LabeledSlider } from '../_pixel-tool-ui'
import { Section } from './ui'

// Select Subject / Background, NL phrase and multi-subject detection.

export default function SubjectSection({
    activeInstanceIndex,
    conceptPhrase,
    dominantColor,
    handleApplyAllSubjectsUnion,
    handleApplyInstance,
    handleDetectAllSubjects,
    handleSelectBackground,
    isDetectingInstances,
    isGrounding,
    isSegmenting,
    runConcept,
    setConceptPhrase,
    setSubjectFillHoles,
    setSubjectSensitivity,
    subjectFillHoles,
    subjectInstances,
    subjectSensitivity,
}) {
    return (
        <Section title="Select Subject" icon={Sparkles} defaultOpen={true} badge="AI">
            <motion.button
                type="button"
                onClick={handleDetectAllSubjects}
                disabled={isSegmenting || isDetectingInstances}
                whileTap={{ scale: 0.97 }}
                className="mask-btn mask-btn--primary w-full py-2.5 text-xs font-semibold"
            >
                {(isSegmenting || isDetectingInstances) ? (
                    <>
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Detecting Subjects…
                    </>
                ) : (
                    <>
                        <Sparkles className="h-4 w-4" />
                        Select Subject
                    </>
                )}
            </motion.button>
            <p className="text-[10px] text-center" style={{ color: 'var(--text-muted)' }}>
                AI detects every subject as a layer — pick one below or keep them all; background stays intact
            </p>

            {/* ── AI Background: subject mask, inverted ─────────────── */}
            <motion.button
                type="button"
                onClick={handleSelectBackground}
                disabled={isSegmenting}
                whileTap={{ scale: 0.97 }}
                className="mask-btn w-full py-2 text-[11px] font-semibold"
                style={{
                    background: 'rgba(6,184,212,0.10)',
                    border: '1px solid rgba(6,184,212,0.30)',
                    color: '#67E8F9',
                }}
            >
                {isSegmenting ? (
                    <>
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        Selecting Background…
                    </>
                ) : (
                    <>
                        <Wallpaper className="h-3.5 w-3.5" />
                        Select Background
                    </>
                )}
            </motion.button>
            <p className="text-[10px] text-center" style={{ color: 'var(--text-muted)' }}>
                Everything except the subject — the reliable way to grade sky / backdrop
            </p>

            {/* ── NL phrase → mask (grounding) ─────────────────────── */}
            <div className="flex items-center gap-1.5">
                <input
                    type="text"
                    value={conceptPhrase}
                    onChange={(e) => setConceptPhrase(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') runConcept() }}
                    placeholder='e.g. the sky'
                    title='e.g. "the sky" or "everything except the person"'
                    aria-label='Describe a region to mask'
                    disabled={isGrounding}
                    className="min-w-0 flex-1 rounded-lg px-2 py-1.5 text-[11px] editor-interactive"
                    style={{
                        background: 'var(--bg-elevated)',
                        border: '1px solid var(--border-subtle)',
                        color: 'var(--text-primary)',
                    }}
                />
                <motion.button
                    type="button"
                    onClick={() => runConcept()}
                    disabled={isGrounding || !conceptPhrase.trim()}
                    whileTap={{ scale: 0.97 }}
                    className="shrink-0 whitespace-nowrap rounded-lg px-2.5 py-1.5 text-[11px] font-semibold editor-interactive disabled:opacity-40"
                    style={{
                        background: 'rgba(124,58,237,0.18)',
                        border: '1px solid rgba(124,58,237,0.45)',
                        color: '#C4B5FD',
                    }}
                >
                    {isGrounding ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Mask it'}
                </motion.button>
            </div>

            {/* ── On-device matte tuning (used on the Device fallback) ── */}
            <LabeledSlider
                label="Sensitivity"
                value={subjectSensitivity}
                min={0}
                max={100}
                suffix="%"
                onChange={setSubjectSensitivity}
                dominantColor={dominantColor}
            />
            <label className="mask-toggle" title="On-device Select Subject / Background: fill holes enclosed by the subject">
                <input type="checkbox" checked={subjectFillHoles} onChange={(e) => setSubjectFillHoles(e.target.checked)} />
                Fill enclosed holes
            </label>

            {/* ── Multi-subject: per-instance picker ──────────────────
                Populated by the primary Select Subject button, which runs
                the detect-all-subjects pass. */}
            {subjectInstances && subjectInstances.length > 0 && (
                <div className="space-y-1.5">
                    <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                        Detected {subjectInstances.length} subject{subjectInstances.length === 1 ? '' : 's'}. Pick one or All:
                    </p>
                    <div className="flex flex-wrap gap-1">
                        <button
                            type="button"
                            onClick={handleApplyAllSubjectsUnion}
                            className="rounded-md px-2 py-1 text-[10px] font-semibold editor-interactive"
                            style={{
                                background: activeInstanceIndex === -1 ? 'rgba(124,58,237,0.25)' : 'var(--bg-elevated)',
                                border: `1px solid ${activeInstanceIndex === -1 ? 'rgba(124,58,237,0.55)' : 'var(--border-subtle)'}`,
                                color: activeInstanceIndex === -1 ? '#C4B5FD' : 'var(--text-primary)',
                            }}
                        >
                            All ({subjectInstances.length})
                        </button>
                        {subjectInstances.map((inst) => {
                            const isActive = activeInstanceIndex === inst.index
                            return (
                                <button
                                    key={inst.index}
                                    type="button"
                                    onClick={() => handleApplyInstance(inst)}
                                    title={`${inst.label} · conf ${(inst.confidence * 100).toFixed(0)}%`}
                                    className="rounded-md px-2 py-1 text-[10px] font-medium editor-interactive"
                                    style={{
                                        background: isActive ? 'rgba(124,58,237,0.25)' : 'var(--bg-elevated)',
                                        border: `1px solid ${isActive ? 'rgba(124,58,237,0.55)' : 'var(--border-subtle)'}`,
                                        color: isActive ? '#C4B5FD' : 'var(--text-primary)',
                                    }}
                                >
                                    {inst.label} #{inst.index + 1}
                                </button>
                            )
                        })}
                    </div>
                </div>
            )}
        </Section>
    )
}
