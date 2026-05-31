"use client"

import React, { useCallback, useEffect, useRef, useState } from "react"
import Link from "next/link"
import { api } from "@/lib/neon-api";
import { useDatabaseMutation, useDatabaseQuery } from "../../../../hooks/useDatabaseQuery"
import { useStoreUser } from "../../../../hooks/useStoreUser"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { toast } from "sonner"
import { Calendar, Check, Database, ImageIcon, Loader2, Plus, Trash2, X } from "lucide-react"
import NewProjectModel from "./_components/newProjectModel"
import ShortcutsGuide from "@/components/neo/ShortcutsGuide"
import useDashboardShortcuts from "../../../../hooks/useDashboardShortcuts"
import { motion, AnimatePresence } from "framer-motion"
import { duration, easeOut, staggerDelay } from "@/lib/motion"
import { createProjectPixelDissolver } from "@/lib/project-pixel-effect"
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import GlassPanel from "@/components/ui/glass-panel"
import NeoButton from "@/components/neo/NeoButton"

const loadingCards = Array.from({ length: 6 })

const formatRelativeTime = (timestamp) => {
    if (!timestamp) return "just now"
    const elapsedMs = timestamp - Date.now()
    const relativeTimeFormat = new Intl.RelativeTimeFormat("en", { numeric: "auto" })
    const units = [
        ["year", 1000 * 60 * 60 * 24 * 365],
        ["month", 1000 * 60 * 60 * 24 * 30],
        ["week", 1000 * 60 * 60 * 24 * 7],
        ["day", 1000 * 60 * 60 * 24],
        ["hour", 1000 * 60 * 60],
        ["minute", 1000 * 60],
    ]
    for (const [unit, unitMs] of units) {
        if (Math.abs(elapsedMs) >= unitMs) {
            return relativeTimeFormat.format(Math.round(elapsedMs / unitMs), unit)
        }
    }
    return "just now"
}

const getProjectPreview = (project) =>
    project.thumbnailUrl || project.currentImageUrl || project.originalImageUrl

const emptyDeleteConfirm = {
    open: false,
    type: null,
    projectId: null,
    projectIds: [],
    projectTitle: null,
}

const getReducedMotionPreference = () =>
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches

const getProjectCardElement = (projectId) => {
    if (typeof document === "undefined" || !projectId) return null
    return document.querySelector(`[data-project-card-id="${projectId}"]`)
}

const ProjectCard = ({
    project,
    index,
    isSelectionMode,
    isSelected,
    isDeletingThisProject,
    isBulkDeleting,
    isPendingDelete,
    onSelect,
    onDelete,
}) => {
    const previewUrl = getProjectPreview(project)
    const accentRgb = "83, 216, 255"

    return (
        <motion.article
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{
                duration: duration.normal,
                delay: staggerDelay(index),
                ease: easeOut,
            }}
            whileHover={!isSelectionMode ? { y: -4 } : {}}
            onClick={isSelectionMode ? (event) => onSelect(event, project._id) : undefined}
            role={isSelectionMode ? "button" : undefined}
            tabIndex={isSelectionMode ? 0 : undefined}
            aria-pressed={isSelectionMode ? isSelected : undefined}
            data-project-card-id={project._id}
            data-pending-delete={isPendingDelete ? "true" : undefined}
            className={cn(
                "group/card relative overflow-hidden glass-panel transition-all duration-500 will-change-transform",
                isSelectionMode && "cursor-pointer",
                isPendingDelete && "project-card-pending-delete pointer-events-none",
            )}
        >
            <div className="relative aspect-[16/10] overflow-hidden">
                {/* Selection overlay */}
                <div
                    className={cn(
                        "pointer-events-none absolute inset-0 z-20 transition-opacity duration-300",
                        isSelected ? "opacity-100" : "opacity-0"
                    )}
                    style={{
                        background: `linear-gradient(135deg, rgba(${accentRgb}, 0.35) 0%, rgba(${accentRgb}, 0.18) 100%)`,
                        border: `2px solid #F4F4F5`,
                        boxShadow: `inset 0 0 0 4px rgba(${accentRgb},0.35)`,
                    }}
                />

                {/* Image or gradient placeholder */}
                {previewUrl ? (
                    <div
                        className="absolute inset-0 z-0 bg-cover bg-center transition-transform duration-700 ease-out group-hover/card:scale-105"
                        style={{ backgroundImage: `url(${previewUrl})` }}
                    />
                ) : (
                    <div className="absolute inset-0 z-0 bg-[radial-gradient(circle_at_30%_30%,rgba(83,216,255,0.15),transparent_50%),linear-gradient(160deg,rgba(8,8,7,0.96),rgba(17,17,15,0.85))]" />
                )}

                {/* Dark gradient at bottom */}
                <div className="absolute inset-x-0 bottom-0 z-10 h-3/4 bg-gradient-to-t from-black/80 via-black/40 to-transparent transition-opacity duration-500 group-hover/card:from-black/90 group-hover/card:via-black/60" />

                {/* Decorative corner glow */}
                <div className="absolute top-2 right-2 w-16 h-16 rounded-full pointer-events-none opacity-0 group-hover/card:opacity-100 transition-opacity duration-500"
                    style={{
                        background: "radial-gradient(circle, rgba(83,216,255,0.15), transparent 70%)",
                        filter: "blur(8px)",
                    }}
                />

                {/* Info overlay */}
                <div className="relative z-20 flex h-full flex-col justify-between p-3">
                    <div className="flex items-start justify-between pt-2">
                        {isSelectionMode ? (
                            <button
                                type="button"
                                onClick={(event) => onSelect(event, project._id)}
                                className={cn(
                                    "flex items-center justify-center rounded-full border backdrop-blur-sm transition duration-200",
                                    isSelected
                                        ? "size-8 border-white/95 bg-white text-slate-950 shadow-[0_12px_30px_rgba(2,6,23,0.28)]"
                                        : "size-7 border-white/20 bg-black/30 text-white/70"
                                )}
                                style={isSelected ? {
                                    borderColor: "rgba(255,255,255,0.96)",
                                    background: "linear-gradient(180deg, rgba(255,255,255,0.98) 0%, rgba(244,247,250,0.92) 100%)",
                                    boxShadow: `0 0 0 3px rgba(${accentRgb}, 0.28), 0 14px 34px rgba(2,6,23,0.34), inset 0 1px 0 rgba(255,255,255,1)`,
                                } : undefined}
                                aria-label={isSelected ? `Deselect ${project.title}` : `Select ${project.title}`}
                            >
                                <Check className={isSelected ? "h-4 w-4" : "h-3 w-3"} strokeWidth={isSelected ? 3.25 : 2.25} />
                            </button>
                        ) : (
                            <button
                                type="button"
                                onClick={(event) => onDelete(event, project._id, project.title)}
                                disabled={isDeletingThisProject || isBulkDeleting}
                                className="flex size-7 items-center justify-center rounded-full border border-white/15 bg-black/30 text-white/70 opacity-0 backdrop-blur-sm transition-all duration-300 group-hover/card:opacity-100 focus-visible:opacity-100 hover:bg-black/50 disabled:opacity-60"
                                aria-label={`Delete ${project.title}`}
                            >
                                {isDeletingThisProject ? (
                                    <Loader2 className="h-3 w-3 animate-spin" />
                                ) : (
                                    <Trash2 className="h-3 w-3" />
                                )}
                            </button>
                        )}
                    </div>

                    <div className="px-1 pb-3">
                        <h3 className="line-clamp-1 text-lg font-semibold leading-snug text-white [overflow-wrap:anywhere] drop-shadow-[0_1px_8px_rgba(0,0,0,0.8)]">
                            {project.title}
                        </h3>
                        <p className="mt-0.5 text-xs font-medium text-white/70 drop-shadow-[0_1px_6px_rgba(0,0,0,0.7)]">
                            Edited {formatRelativeTime(project.updatedAt)}
                        </p>
                    </div>
                </div>
            </div>
        </motion.article>
    )
}

const Dashboard = () => {
    const { isLoading: isAuthLoading, isAuthenticated, databaseSetupMissing } = useStoreUser()
    const [showNewProjectModal, setShowNewProjectModal] = useState(false)
    const [isSelectionMode, setIsSelectionMode] = useState(false)
    const [selectedProjectIds, setSelectedProjectIds] = useState([])
    const [deletingProjectId, setDeletingProjectId] = useState(null)
    const [isBulkDeleting, setIsBulkDeleting] = useState(false)
    const [pendingDeleteIds, setPendingDeleteIds] = useState([])
    const [deleteConfirm, setDeleteConfirm] = useState(emptyDeleteConfirm)
    const [showShortcuts, setShowShortcuts] = useState(false)

    const { data: projects = [], isLoading: isProjectsLoading } = useDatabaseQuery(
        api.projects.getUserProjects,
        isAuthenticated ? {} : "skip"
    )
    const { mutate: deleteProjectMutate } = useDatabaseMutation(api.projects.deleteProject)
    const { mutate: bulkDeleteProjectsMutate } = useDatabaseMutation(api.projects.bulkDeleteProjects)
    const isLoading = isAuthLoading || isProjectsLoading
    const projectCount = projects.length
    const hasProjects = projectCount > 0
    const projectCountLabel = isLoading
        ? "Loading projects"
        : `${projectCount} ${projectCount === 1 ? "project" : "projects"}`
    const prevProjectIdsRef = useRef(null)
    const pixelControllersRef = useRef(new Map())

    useEffect(() => {
        const currentIds = projects.map((p) => p._id).join(",")
        if (prevProjectIdsRef.current === currentIds) return
        prevProjectIdsRef.current = currentIds
        const availableProjectIds = new Set(projects.map((project) => project._id))
        setSelectedProjectIds((currentSelectedIds) =>
            currentSelectedIds.filter((projectId) => availableProjectIds.has(projectId))
        )
        setPendingDeleteIds((currentIds) =>
            currentIds.filter((projectId) => availableProjectIds.has(projectId))
        )
    }, [projects])

    useEffect(() => {
        if (selectedProjectIds.length === 0 && !hasProjects) setIsSelectionMode(false)
    }, [hasProjects, selectedProjectIds.length])

    useEffect(() => {
        const controllers = pixelControllersRef.current
        return () => {
            controllers.forEach((controller) => controller?.cleanup?.())
            controllers.clear()
        }
    }, [])

    const stageProjectDisintegration = useCallback(async (projectIds) => {
        const ids = [...new Set(projectIds.filter(Boolean))]
        if (ids.length === 0) {
            return { finished: Promise.resolve(), stagedIds: [] }
        }

        const reduced = getReducedMotionPreference()
        const controllerEntries = await Promise.all(ids.map(async (projectId) => {
            pixelControllersRef.current.get(projectId)?.cleanup?.()

            const target = getProjectCardElement(projectId)
            const controller = await createProjectPixelDissolver(target, { reduced }).catch(() => null)
            if (controller) pixelControllersRef.current.set(projectId, controller)
            return { projectId, controller }
        }))

        const stagedIds = controllerEntries
            .filter(({ controller }) => Boolean(controller))
            .map(({ projectId }) => projectId)
        const controllers = controllerEntries
            .map(({ controller }) => controller)
            .filter(Boolean)

        if (stagedIds.length > 0) {
            setPendingDeleteIds((currentIds) => [...new Set([...currentIds, ...stagedIds])])
        }

        const finished = Promise.allSettled(
            controllers.map((controller) => controller.disintegrate())
        )

        return { finished, stagedIds }
    }, [])

    const restoreProjectIntegration = useCallback(async (projectIds) => {
        const ids = [...new Set(projectIds.filter(Boolean))]
        if (ids.length === 0) return

        const controllers = ids
            .map((projectId) => pixelControllersRef.current.get(projectId))
            .filter(Boolean)

        await Promise.allSettled(controllers.map((controller) => controller.integrate()))

        ids.forEach((projectId) => {
            pixelControllersRef.current.get(projectId)?.cleanup?.()
            pixelControllersRef.current.delete(projectId)
        })

        setPendingDeleteIds((currentIds) =>
            currentIds.filter((projectId) => !ids.includes(projectId))
        )
    }, [])

    const cleanupProjectPixels = useCallback((projectIds) => {
        const ids = [...new Set(projectIds.filter(Boolean))]
        ids.forEach((projectId) => {
            pixelControllersRef.current.get(projectId)?.cleanup?.()
            pixelControllersRef.current.delete(projectId)
        })
        setPendingDeleteIds((currentIds) =>
            currentIds.filter((projectId) => !ids.includes(projectId))
        )
    }, [])

    const handleSelectionModeToggle = () => {
        setIsSelectionMode((currentValue) => {
            if (currentValue) setSelectedProjectIds([])
            return !currentValue
        })
    }

    const handleProjectSelection = (event, projectId) => {
        event.preventDefault()
        event.stopPropagation()
        setSelectedProjectIds((currentIds) =>
            currentIds.includes(projectId)
                ? currentIds.filter((currentId) => currentId !== projectId)
                : [...currentIds, projectId]
        )
    }

    const handleDeleteProject = async (event, projectId, projectTitle) => {
        event.preventDefault()
        event.stopPropagation()
        if (deletingProjectId || isBulkDeleting || pendingDeleteIds.includes(projectId)) return
        setDeleteConfirm({ ...emptyDeleteConfirm, open: true, type: "single", projectId, projectIds: [projectId], projectTitle })
    }

    const handleDeleteSelectedProjects = async () => {
        if (selectedProjectIds.length === 0 || isBulkDeleting) return
        const selectedCount = selectedProjectIds.length
        const projectLabel = selectedCount === 1 ? "project" : "projects"
        setDeleteConfirm({
            ...emptyDeleteConfirm,
            open: true,
            type: "bulk",
            projectIds: selectedProjectIds,
            projectTitle: `${selectedCount} ${projectLabel}`,
        })
    }

    const performDelete = useCallback(async (type, projectId, projectIds = []) => {
        if (type === "single") {
            setDeletingProjectId(projectId)
            try {
                const result = await deleteProjectMutate({ projectId })
                if (result?.success) {
                    setSelectedProjectIds((currentIds) =>
                        currentIds.filter((currentId) => currentId !== projectId)
                    )
                }
            } finally {
                setDeletingProjectId(null)
            }
        } else if (type === "bulk") {
            setIsBulkDeleting(true)
            try {
                const result = await bulkDeleteProjectsMutate({ projectIds })
                if (result?.success) {
                    setSelectedProjectIds([])
                    setIsSelectionMode(false)
                }
            } finally {
                setIsBulkDeleting(false)
            }
        }
    }, [deleteProjectMutate, bulkDeleteProjectsMutate])

    const confirmDelete = useCallback(async () => {
        const { type, projectId, projectIds, projectTitle } = deleteConfirm
        const ids = type === "bulk" ? projectIds : [projectId].filter(Boolean)
        if (!type || ids.length === 0) {
            setDeleteConfirm(emptyDeleteConfirm)
            return
        }
        setDeleteConfirm(emptyDeleteConfirm)
        const label = type === "single" ? `"${projectTitle}"` : projectTitle
        let undone = false
        let finalized = false
        const stagedEffectPromise = stageProjectDisintegration(ids)
        const toastId = toast(`Deleting ${label}`, {
            duration: 5000,
            description: "Undo now to rebuild the card from pixels.",
            action: {
                label: "Undo",
                onClick: async () => {
                    undone = true
                    toast.dismiss(toastId)
                    await stagedEffectPromise
                    await restoreProjectIntegration(ids)
                },
            },
            onAutoClose: async () => {
                if (undone || finalized) return
                finalized = true
                const stagedEffect = await stagedEffectPromise
                await stagedEffect.finished
                try {
                    await performDelete(type, projectId, ids)
                    cleanupProjectPixels(ids)
                } catch (error) {
                    await restoreProjectIntegration(ids)
                    toast.error(error?.message || "Failed to delete project")
                }
            },
            onDismiss: async () => {
                if (undone || finalized) return
                finalized = true
                const stagedEffect = await stagedEffectPromise
                await stagedEffect.finished
                try {
                    await performDelete(type, projectId, ids)
                    cleanupProjectPixels(ids)
                } catch (error) {
                    await restoreProjectIntegration(ids)
                    toast.error(error?.message || "Failed to delete project")
                }
            },
        })
    }, [
        cleanupProjectPixels,
        deleteConfirm,
        performDelete,
        restoreProjectIntegration,
        stageProjectDisintegration,
    ])

    useDashboardShortcuts({
        onNewProject: () => {
            if (!databaseSetupMissing) setShowNewProjectModal(true)
        },
        onToggleShortcuts: () => setShowShortcuts((value) => !value),
        onToggleSelectMode: handleSelectionModeToggle,
        onSelectAll: () => {
            if (!projects?.length) return
            setSelectedProjectIds(projects.map((p) => p._id))
        },
        onDeleteSelected: handleDeleteSelectedProjects,
        onEscape: () => {
            // Cascade: close shortcuts → close new-project modal → exit select mode → close delete dialog
            if (showShortcuts) { setShowShortcuts(false); return }
            if (showNewProjectModal) { setShowNewProjectModal(false); return }
            if (deleteConfirm.open) { setDeleteConfirm(emptyDeleteConfirm); return }
            if (isSelectionMode) {
                setIsSelectionMode(false)
                setSelectedProjectIds([])
            }
        },
        isSelectionMode,
        selectedCount: selectedProjectIds.length,
    })

    return (
        <div className="min-h-[calc(100svh-3rem)] pt-28 pb-12 relative">
            <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-6 px-4 sm:px-6 lg:px-8 relative z-10">
                {/* Header bar */}
                <GlassPanel className="!px-6 !py-5 dashboard-projects-header">
                    <div className="flex items-center justify-between">
                        <div className="select-none">
                            <h1 className="text-2xl font-bold tracking-tight text-white sm:text-3xl">
                                Projects
                            </h1>
                            <div className="mt-1.5 flex items-center gap-4 text-sm text-[var(--text-muted)]">
                                <span className="inline-flex items-center gap-1.5">
                                    {isLoading ? (
                                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                    ) : (
                                        <ImageIcon className="h-3.5 w-3.5" />
                                    )}
                                    {projectCountLabel}
                                </span>
                                {hasProjects && (
                                    <span className="inline-flex items-center gap-1.5">
                                        <Calendar className="h-3.5 w-3.5" />
                                        Last created {formatRelativeTime(Math.max(...projects.map((p) => p._creationTime || p.updatedAt)))}
                                    </span>
                                )}
                            </div>
                        </div>
                        <NeoButton
                            variant="primary"
                            size="md"
                            onClick={() => setShowNewProjectModal(true)}
                            disabled={databaseSetupMissing}
                        >
                            <Plus className="h-4 w-4" strokeWidth={2.5} />
                            New Project
                        </NeoButton>
                    </div>
                </GlassPanel>

                {/* Project grid */}
                <section className="space-y-4">
                    {hasProjects && (
                        <div className="flex items-center justify-end gap-2">
                            {isSelectionMode ? (
                                <>
                                    <span className="text-xs text-[var(--text-muted)] mr-auto">
                                        {selectedProjectIds.length} selected
                                    </span>
                                    <Button variant="glass" className="h-9 px-3 rounded-full text-xs pill-control" onClick={handleSelectionModeToggle} disabled={isBulkDeleting}>
                                        <X className="h-3.5 w-3.5" /> Cancel
                                    </Button>
                                    <Button
                                        variant="destructive"
                                        className="h-9 rounded-full border border-red-400/20 px-3 text-xs text-red-100 pill-control"
                                        onClick={handleDeleteSelectedProjects}
                                        disabled={selectedProjectIds.length === 0 || isBulkDeleting}
                                    >
                                        {isBulkDeleting ? (
                                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                        ) : (
                                            <Trash2 className="h-3.5 w-3.5" />
                                        )}{" "}
                                        Delete
                                    </Button>
                                </>
                            ) : (
                                <Button variant="glass" className="h-9 px-3 rounded-full text-xs pill-control" onClick={handleSelectionModeToggle}>
                                    <Check className="h-3.5 w-3.5" /> Select
                                </Button>
                            )}
                        </div>
                    )}

                    {databaseSetupMissing ? (
                        <GlassPanel className="!py-14 !px-6 text-center">
                            <div className="mx-auto flex max-w-xl flex-col items-center gap-4">
                                <div
                                    className="flex h-14 w-14 items-center justify-center rounded-lg border"
                                    style={{
                                        borderColor: "rgba(6, 184, 212, 0.35)",
                                        background: "rgba(6, 184, 212, 0.08)",
                                    }}
                                >
                                    <Database className="h-7 w-7 text-cyan-300" />
                                </div>
                                <div>
                                    <p className="text-lg font-semibold text-[var(--text-primary)]">Neon database setup required</p>
                                    <p className="mt-2 text-sm leading-6 text-[var(--text-muted)]">
                                        Add `DATABASE_URL` and `DIRECT_URL`, then run `bun run db:push` before creating or loading saved projects.
                                    </p>
                                </div>
                            </div>
                        </GlassPanel>
                    ) : isLoading ? (
                        <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                            {loadingCards.map((_, index) => (
                                <div
                                    key={index}
                                    className="overflow-hidden rounded-lg border"
                                    style={{
                                        borderColor: "rgba(244,244,245,0.16)",
                                        boxShadow: "0 18px 40px rgba(0,0,0,0.22)",
                                        background: "rgba(14,17,24,0.42)",
                                    }}
                                >
                                    <div className="relative aspect-[16/10] overflow-hidden">
                                        <div className="absolute inset-0 animate-pulse bg-white/[0.035]" />
                                        <div
                                            className="absolute inset-y-0 w-1/2 -translate-x-full animate-loading-bar-sweep"
                                            style={{
                                                background: "linear-gradient(90deg, transparent, rgba(83,216,255,0.08), transparent)",
                                            }}
                                        />
                                    </div>
                                </div>
                            ))}
                        </section>
                    ) : hasProjects ? (
                        <section className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                            {projects.map((project, index) => {
                                const isSelected = selectedProjectIds.includes(project._id)
                                const isPendingDelete = pendingDeleteIds.includes(project._id)
                                const isDeletingThisProject = deletingProjectId === project._id
                                const cardContent = (
                                    <ProjectCard
                                        project={project}
                                        index={index}
                                        isSelectionMode={isSelectionMode}
                                        isSelected={isSelected}
                                        isDeletingThisProject={isDeletingThisProject}
                                        isBulkDeleting={isBulkDeleting}
                                        isPendingDelete={isPendingDelete}
                                        onSelect={handleProjectSelection}
                                        onDelete={handleDeleteProject}
                                    />
                                )
                                if (isSelectionMode)
                                    return (
                                        <div key={project._id} className={cn("group block", isPendingDelete && "pointer-events-none")}>
                                            {cardContent}
                                        </div>
                                    )
                                return (
                                    <Link
                                        key={project._id}
                                        href={`/editor/${project._id}`}
                                        className={cn("group block", isPendingDelete && "pointer-events-none")}
                                    >
                                        {cardContent}
                                    </Link>
                                )
                            })}
                        </section>
                    ) : (
                        <GlassPanel className="!py-16 !px-6 text-center">
                            <div className="flex flex-col items-center gap-4">
                                <div className="w-16 h-16 rounded-2xl flex items-center justify-center text-4xl opacity-40">🎨</div>
                                <p className="text-lg font-medium text-[var(--text-secondary)]">No projects yet</p>
                                <p className="text-sm text-[var(--text-muted)] mt-1">Upload an image to get started.</p>
                                <div className="mt-4">
                                    <NeoButton
                                        variant="primary"
                                        size="md"
                                        onClick={() => setShowNewProjectModal(true)}
                                        disabled={databaseSetupMissing}
                                    >
                                        <Plus className="h-4 w-4" strokeWidth={2.5} />
                                        Create Project
                                    </NeoButton>
                                </div>
                            </div>
                        </GlassPanel>
                    )}
                </section>

                <NewProjectModel
                    isOpen={showNewProjectModal}
                    onClose={() => setShowNewProjectModal(false)}
                    currentProjectCount={projectCount}
                />

                <ShortcutsGuide
                    open={showShortcuts}
                    onClose={() => setShowShortcuts(false)}
                    variant="dashboard"
                />

                <AlertDialog
                    open={deleteConfirm.open}
                    onOpenChange={(open) => {
                        if (!open) setDeleteConfirm(emptyDeleteConfirm)
                    }}
                >
                    <AlertDialogContent>
                        <AlertDialogHeader>
                            <AlertDialogTitle>
                                {deleteConfirm.type === "bulk"
                                    ? `Delete ${deleteConfirm.projectTitle}?`
                                    : `Delete "${deleteConfirm.projectTitle}"?`}
                            </AlertDialogTitle>
                            <AlertDialogDescription>
                                The selected card will dissolve now, with a short undo window before permanent deletion.{" "}
                                {deleteConfirm.type === "bulk"
                                    ? "Undo will rebuild all selected cards."
                                    : "Undo will rebuild this project card."}
                            </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction onClick={confirmDelete}>Delete</AlertDialogAction>
                        </AlertDialogFooter>
                    </AlertDialogContent>
                </AlertDialog>
            </div>
        </div>
    )
}

export default Dashboard
