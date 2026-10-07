import { motion } from 'framer-motion'
import { Loader2, Shuffle, Sparkles } from 'lucide-react'
import { Section, TemplatePreview } from './ui'

// Stylish Templates: the AI-planned gallery and its brief.

export default function TemplatesSection({
    aiAnalysis,
    aiDirection,
    applyRecipe,
    imageCount,
    isGenerating,
    isPlanning,
    processingMessage,
    regenerateTemplates,
    requestAiTemplates,
    setAiDirection,
    templateRecipes,
}) {
    // Uncompiled, like the panel it was cut from: it reads live Fabric objects in render.
    'use no memo'
    return (
        <Section title="Stylish Templates" icon={Sparkles}>
            <div className="mb-3 flex items-center justify-between gap-2">
                <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                    {isPlanning
                        ? 'Matching templates to your photos…'
                        : aiAnalysis?.contentType
                            ? `Matched to your ${aiAnalysis.contentType} photos${aiAnalysis.mood ? ` · ${aiAnalysis.mood}` : ''}.`
                            : `Ready-made looks for your ${imageCount} photos.`}
                </p>
                <button
                    type="button"
                    onClick={regenerateTemplates}
                    disabled={isGenerating}
                    className="flex items-center gap-1 rounded-md px-2 py-1 text-[10px] font-medium editor-interactive disabled:opacity-50"
                    style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}
                >
                    {isPlanning ? <Loader2 className="w-3 h-3 animate-spin" /> : <Shuffle className="w-3 h-3" />}
                    {isPlanning ? 'Matching…' : 'Shuffle'}
                </button>
            </div>

            {/* Creative direction — steer the whole plan toward a style.
                A chip or free text becomes the model's directionHint. */}
            <div className="mb-3 space-y-1.5">
                <div className="flex flex-wrap gap-1">
                    {['Editorial', 'Vintage', 'Scrapbook', 'Minimal', 'Bold', 'Cinematic'].map((d) => {
                        const active = aiDirection.trim().toLowerCase() === d.toLowerCase()
                        return (
                            <button
                                key={d}
                                type="button"
                                disabled={isGenerating}
                                onClick={() => {
                                    const next = active ? '' : d
                                    setAiDirection(next)
                                    requestAiTemplates(next)
                                }}
                                className="rounded-full px-2 py-0.5 text-[10px] font-medium editor-interactive disabled:opacity-50"
                                style={{
                                    background: active ? 'rgba(6,184,212,0.15)' : 'var(--bg-elevated)',
                                    border: `1px solid ${active ? 'var(--accent-primary)' : 'var(--border-subtle)'}`,
                                    color: active ? 'var(--accent-primary)' : 'var(--text-secondary)',
                                }}
                            >
                                {d}
                            </button>
                        )
                    })}
                </div>
                <input
                    type="text"
                    value={aiDirection}
                    onChange={(e) => setAiDirection(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); requestAiTemplates(aiDirection) } }}
                    disabled={isGenerating}
                    placeholder="Or describe a direction, then ↵ (e.g. 90s film album)"
                    className="w-full rounded-md px-2 py-1.5 text-[10px] editor-interactive disabled:opacity-50"
                    style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', color: 'var(--text-primary)' }}
                />
            </div>

            <div className="grid grid-cols-2 gap-2">
                {templateRecipes.map((recipe) => (
                    <motion.button
                        key={recipe.id}
                        type="button"
                        onClick={() => applyRecipe(recipe)}
                        disabled={isGenerating || Boolean(processingMessage)}
                        whileTap={{ scale: 0.96 }}
                        className="relative flex flex-col gap-1.5 rounded-lg p-1.5 text-left editor-interactive disabled:opacity-50"
                        style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)' }}
                        title={[
                            recipe.direction && recipe.direction !== recipe.label ? `${recipe.label} · ${recipe.direction}` : `${recipe.label}`,
                            recipe.rationale,
                        ].filter(Boolean).join(' — ')}
                    >
                        <TemplatePreview recipe={recipe} />
                        <div className="flex items-center justify-between gap-1 px-0.5">
                            <span className="truncate text-[10px] font-medium" style={{ color: 'var(--text-secondary)' }}>
                                {recipe.label}
                            </span>
                            {recipe.isAi && (
                                <span
                                    className="shrink-0 rounded px-1 text-[8px] font-semibold uppercase tracking-wide"
                                    style={{ background: 'rgba(6,184,212,0.15)', color: 'var(--accent-primary)' }}
                                >
                                    AI
                                </span>
                            )}
                        </div>
                    </motion.button>
                ))}
            </div>
        </Section>
    )
}
