import React, { useEffect, useRef, useState } from "react"
import { LineChart, RotateCcw } from "lucide-react"
import { arePointsIdentity, buildCurveSvgPath } from "@/lib/curves-filter"
import { CURVE_CHANNELS, CURVE_GRAPH, cloneIdentityPoints } from "./config"
import { sanitizeCurvePoints } from "./filters"
import { clamp } from "./utils"

export const HISTOGRAM_SERIES = {
    red: { label: "Red", color: "#ff5d65" },
    green: { label: "Green", color: "#64d989" },
    blue: { label: "Blue", color: "#69a7ff" },
    luma: { label: "Luminance", color: "#d8dde7" },
}

export const buildHistogramPaths = (series) => {
    if (!Array.isArray(series) || series.length === 0) return null
    const maxValue = Math.max(...series)
    if (!maxValue) return null

    const { left, right, top, bottom } = CURVE_GRAPH
    const width = right - left
    const height = bottom - top
    const maxLog = Math.log1p(maxValue)
    const points = series.map((value, index) => {
        const x = left + (index / Math.max(1, series.length - 1)) * width
        const strength = Math.log1p(value) / maxLog
        const y = bottom - clamp(strength, 0, 1) * height
        return `${index === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`
    }).join(" ")

    return {
        line: points,
        fill: `${points} L ${right} ${bottom} L ${left} ${bottom} Z`,
    }
}

export const CURVE_HIT_RADIUS_VB = 4.5

export const CURVE_POINT_MIN_GAP = 0.015

export const clientToCurvePoint = (svgEl, clientX, clientY) => {
    if (!svgEl) return null
    const rect = svgEl.getBoundingClientRect()
    if (!rect.width || !rect.height) return null
    const vbX = ((clientX - rect.left) / rect.width) * 100
    const vbY = ((clientY - rect.top) / rect.height) * 100
    const x = (vbX - CURVE_GRAPH.left) / (CURVE_GRAPH.right - CURVE_GRAPH.left)
    const y = 1 - (vbY - CURVE_GRAPH.top) / (CURVE_GRAPH.bottom - CURVE_GRAPH.top)
    return { x: clamp(x, 0, 1), y: clamp(y, 0, 1), vbX, vbY }
}

export const findNearestPointIndex = (points, vbX, vbY) => {
    if (!Array.isArray(points)) return -1
    let best = -1
    let bestDist = CURVE_HIT_RADIUS_VB
    for (let i = 0; i < points.length; i++) {
        const p = points[i]
        const px = CURVE_GRAPH.left + p.x * (CURVE_GRAPH.right - CURVE_GRAPH.left)
        const py = CURVE_GRAPH.bottom - p.y * (CURVE_GRAPH.bottom - CURVE_GRAPH.top)
        const dx = vbX - px
        const dy = vbY - py
        const dist = Math.sqrt(dx * dx + dy * dy)
        if (dist < bestDist) {
            bestDist = dist
            best = i
        }
    }
    return best
}

export const CurveGraph = ({ channel, values, histogram, onBegin, onPreview, onCommit }) => {
    const svgRef = useRef(null)
    const dragRef = useRef(null)
    const [activeIndex, setActiveIndex] = useState(null)
    const [hoverIndex, setHoverIndex] = useState(null)

    const points = sanitizeCurvePoints(values[channel.pointsKey])
    const isRgb = channel.id === "rgb"
    const path = buildCurveSvgPath(points, CURVE_GRAPH)

    const commitPoints = (next, { commit }) => {
        const sanitized = sanitizeCurvePoints(next)
        if (commit) onCommit(channel.pointsKey, sanitized)
        else onPreview(channel.pointsKey, sanitized)
    }

    useEffect(() => {
        if (activeIndex === null) return undefined

        const handleMove = (event) => {
            const drag = dragRef.current
            if (!drag) return
            const svg = svgRef.current
            if (!svg) return
            const loc = clientToCurvePoint(svg, event.clientX, event.clientY)
            if (!loc) return
            const next = drag.points.map((p, i) => ({ ...p }))
            const isFirst = drag.index === 0
            const isLast = drag.index === next.length - 1
            const prev = next[drag.index - 1]
            const succ = next[drag.index + 1]
            const minX = isFirst ? 0 : (prev ? prev.x + CURVE_POINT_MIN_GAP : 0)
            const maxX = isLast ? 1 : (succ ? succ.x - CURVE_POINT_MIN_GAP : 1)
            const newX = isFirst ? 0 : isLast ? 1 : clamp(loc.x, minX, maxX)
            const newY = clamp(loc.y, 0, 1)
            next[drag.index] = { x: newX, y: newY }
            dragRef.current = { ...drag, points: next }
            commitPoints(next, { commit: false })
        }

        const handleUp = () => {
            const drag = dragRef.current
            if (drag) commitPoints(drag.points, { commit: true })
            dragRef.current = null
            setActiveIndex(null)
        }

        window.addEventListener("pointermove", handleMove)
        window.addEventListener("pointerup", handleUp)
        window.addEventListener("pointercancel", handleUp)
        return () => {
            window.removeEventListener("pointermove", handleMove)
            window.removeEventListener("pointerup", handleUp)
            window.removeEventListener("pointercancel", handleUp)
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeIndex, channel.pointsKey])

    const beginDrag = (index, event) => {
        if (event.button !== 0 && event.button !== undefined) return
        event.preventDefault()
        event.stopPropagation()
        onBegin?.()
        dragRef.current = { index, points: points.map((p) => ({ ...p })) }
        setActiveIndex(index)
    }

    const handlePointerDownGraph = (event) => {
        if (event.button !== 0 && event.button !== undefined) return
        const svg = svgRef.current
        if (!svg) return
        const loc = clientToCurvePoint(svg, event.clientX, event.clientY)
        if (!loc) return
        const existing = findNearestPointIndex(points, loc.vbX, loc.vbY)
        if (existing >= 0) {
            beginDrag(existing, event)
            return
        }
        // Add a new point at this location
        event.preventDefault()
        event.stopPropagation()
        onBegin?.()
        const next = [...points, { x: loc.x, y: loc.y }].sort((a, b) => a.x - b.x)
        const sanitized = sanitizeCurvePoints(next)
        let insertedIndex = sanitized.findIndex((p) => Math.abs(p.x - loc.x) < 0.0001 && Math.abs(p.y - loc.y) < 0.0001)
        if (insertedIndex < 0) insertedIndex = Math.max(1, Math.min(sanitized.length - 2, sanitized.length - 1))
        dragRef.current = { index: insertedIndex, points: sanitized }
        commitPoints(sanitized, { commit: false })
        setActiveIndex(insertedIndex)
    }

    const handleDoubleClickPoint = (index) => (event) => {
        event.preventDefault()
        event.stopPropagation()
        if (index === 0 || index === points.length - 1) return
        onBegin?.()
        const next = points.filter((_, i) => i !== index)
        commitPoints(next, { commit: true })
    }

    return (
        <div className="adjust-curve-graph">
            <svg ref={svgRef} viewBox="0 0 100 100" className="adjust-curve-svg" preserveAspectRatio="none" onPointerDown={handlePointerDownGraph}>
                {[20, 40, 60, 80].map((line) => (
                    <React.Fragment key={line}>
                        <line x1={line} y1="6" x2={line} y2="94" className="adjust-curve-grid" />
                        <line x1="6" y1={line} x2="94" y2={line} className="adjust-curve-grid" />
                    </React.Fragment>
                ))}
                {(channel.histogramChannels || []).map((key) => {
                    const series = HISTOGRAM_SERIES[key]
                    const paths = buildHistogramPaths(histogram?.[key])
                    if (!paths || !series) return null
                    return (
                        <g
                            key={key}
                            className={`adjust-curve-histogram-series ${isRgb ? "is-rgb" : "is-single"}`}
                            style={{ "--curve-color": series.color }}
                            pointerEvents="none"
                        >
                            <path d={paths.fill} className="adjust-curve-histogram-fill" />
                            <path d={paths.line} className="adjust-curve-histogram-line" />
                        </g>
                    )
                })}
                <line
                    x1={CURVE_GRAPH.left}
                    y1={CURVE_GRAPH.bottom}
                    x2={CURVE_GRAPH.right}
                    y2={CURVE_GRAPH.top}
                    className="adjust-curve-diagonal"
                    style={{ "--curve-color": channel.color }}
                    pointerEvents="none"
                />
                <path d={path} className="adjust-curve-path" style={{ "--curve-color": channel.color }} pointerEvents="none" />
                {points.map((p, index) => {
                    const cx = CURVE_GRAPH.left + p.x * (CURVE_GRAPH.right - CURVE_GRAPH.left)
                    const cy = CURVE_GRAPH.bottom - p.y * (CURVE_GRAPH.bottom - CURVE_GRAPH.top)
                    const isActive = activeIndex === index
                    const isHovered = hoverIndex === index
                    return (
                        <g
                            key={index}
                            className={`adjust-curve-point-group ${isActive ? "is-active" : ""} ${isHovered ? "is-hover" : ""}`}
                            style={{ "--curve-color": channel.color }}
                        >
                            <circle
                                cx={cx}
                                cy={cy}
                                r="4.5"
                                className="adjust-curve-point-hit"
                                onPointerDown={(event) => beginDrag(index, event)}
                                onDoubleClick={handleDoubleClickPoint(index)}
                                onPointerEnter={() => setHoverIndex(index)}
                                onPointerLeave={() => setHoverIndex((cur) => (cur === index ? null : cur))}
                            />
                            <circle
                                cx={cx}
                                cy={cy}
                                r="1.7"
                                className="adjust-curve-point"
                                pointerEvents="none"
                            />
                        </g>
                    )
                })}
            </svg>
        </div>
    )
}

export const CurveEditorPanel = ({ values, histogram, activeChannel, onChannelChange, onBegin, onPreview, onCommit }) => {
    const channel = CURVE_CHANNELS.find((item) => item.id === activeChannel) || CURVE_CHANNELS[0]
    const channelPoints = sanitizeCurvePoints(values[channel.pointsKey])
    const isChannelDirty = !arePointsIdentity(channelPoints)

    const handleResetChannel = () => {
        onBegin?.()
        onCommit(channel.pointsKey, cloneIdentityPoints())
    }

    return (
        <div className="adjust-curve-card" style={{ "--curve-color": channel.color }}>
            <div className="adjust-curve-card-header">
                <div className="adjust-curve-card-title">
                    <LineChart aria-hidden="true" />
                    <span>Curves</span>
                </div>
                <button
                    type="button"
                    onClick={handleResetChannel}
                    disabled={!isChannelDirty}
                    className="adjust-curve-reset"
                    title={`Reset ${channel.label} channel`}
                >
                    <RotateCcw aria-hidden="true" />
                    Reset
                </button>
            </div>
            <div className="adjust-curve-toolbar">
                <span className="adjust-curve-toolbar-label">Channel</span>
                <label className="adjust-curve-select-wrap">
                    <select
                        value={channel.id}
                        onChange={(event) => onChannelChange(event.target.value)}
                        className="adjust-curve-select"
                        style={{ "--curve-color": channel.color }}
                        aria-label="Curve channel"
                    >
                        {CURVE_CHANNELS.map((item) => (
                            <option key={item.id} value={item.id}>
                                {item.label}
                            </option>
                        ))}
                    </select>
                </label>
            </div>
            <CurveGraph
                channel={channel}
                values={values}
                histogram={histogram}
                onBegin={onBegin}
                onPreview={onPreview}
                onCommit={onCommit}
            />
            <p className="adjust-curve-hint">
                Click the curve to add a point · drag to shape · double-click a point to remove
            </p>
        </div>
    )
}
