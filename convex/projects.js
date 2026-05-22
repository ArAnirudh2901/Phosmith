import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { getAuthUserId } from "./users";

const REVISION_LIMIT = 40;

const getOwnedProject = async (ctx, user, projectId) => {
    const project = await ctx.db.get(projectId);

    if (!project) {
        throw new Error("Project not found");
    }

    if (!user || project.userId !== user._id) {
        throw new Error("Access denied");
    }

    return project;
};

const deleteRevisionBatchForProject = async (ctx, projectId) => {
    const revisions = await ctx.db
        .query("projectRevisions")
        .withIndex("by_projectId_and_createdAt", (q) => q.eq("projectId", projectId))
        .take(64);

    for (const revision of revisions) {
        await ctx.db.delete(revision._id);
    }
};

export const create = mutation({
    args: {
        title: v.string(),
        originalImageUrl: v.optional(v.string()),
        currentImageUrl: v.optional(v.string()),
        thumbnailUrl: v.optional(v.string()),
        width: v.number(),
        height: v.number(),
        canvasState: v.optional(v.any())
    },
    handler: async (ctx, args) => {
        const user = await getAuthUserId(ctx);

        if (user.plan === "free") {
            const projectCount = await ctx.db
                .query("projects")
                .withIndex("by_user", (q) => q.eq("userId", user._id))
                .take(4);

            if (projectCount.length >= 3) {
                throw new Error("Free plan limited to 3 projects. Upgrade to pro for unlimited projects.");
            }
        }

        const projectId = await ctx.db.insert("projects", {
            title: args.title,
            userId: user._id,
            originalImageUrl: args.originalImageUrl,
            currentImageUrl: args.currentImageUrl,
            thumbnailUrl: args.thumbnailUrl,
            width: args.width,
            height: args.height,
            canvasState: args.canvasState ?? null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
        });

        const initialRevision = {
            projectId,
            userId: user._id,
            canvasState: args.canvasState ?? null,
            width: args.width,
            height: args.height,
            title: "Original import",
            summary: "Starting project state",
            changes: [],
            createdAt: Date.now(),
        };

        const initialImageUrl = args.currentImageUrl || args.originalImageUrl;
        if (initialImageUrl) {
            initialRevision.currentImageUrl = initialImageUrl;
        }

        await ctx.db.insert("projectRevisions", initialRevision);

        await ctx.db.patch(user._id, {
            projectsUsed: user.projectsUsed + 1,
            lastActiveAt: Date.now(),
        });

        return projectId;
    },
});

export const getUserProjects = query({
    args: {},
    handler: async (ctx) => {
        const user = await getAuthUserId(ctx);

        const projects = await ctx.db
            .query("projects")
            .withIndex("by_user_updated", (q) => q.eq("userId", user._id))
            .order("desc")
            .collect();

        return projects;
    },
});

export const deleteProject = mutation({
    args: {
        projectId: v.id("projects"),
    },
    handler: async (ctx, args) => {
        const user = await getAuthUserId(ctx);

        await getOwnedProject(ctx, user, args.projectId);

        await deleteRevisionBatchForProject(ctx, args.projectId);
        await ctx.db.delete(args.projectId);

        await ctx.db.patch(user._id, {
            projectsUsed: Math.max(0, user.projectsUsed - 1),
            lastActiveAt: Date.now(),
        });

        return { success: true };
    },
});

export const bulkDeleteProjects = mutation({
    args: {
        projectIds: v.array(v.id("projects")),
    },
    handler: async (ctx, args) => {
        const user = await getAuthUserId(ctx);
        const uniqueProjectIds = [...new Set(args.projectIds)];

        if (uniqueProjectIds.length === 0) {
            return { success: true, deletedCount: 0 };
        }

        const ownedProjects = [];

        for (const projectId of uniqueProjectIds) {
            const project = await ctx.db.get(projectId);

            if (!project) {
                continue;
            }

            if (project.userId !== user._id) {
                throw new Error("Access denied");
            }

            ownedProjects.push(project);
        }

        for (const project of ownedProjects) {
            await deleteRevisionBatchForProject(ctx, project._id);
            await ctx.db.delete(project._id);
        }

        if (ownedProjects.length > 0) {
            await ctx.db.patch(user._id, {
                projectsUsed: Math.max(0, user.projectsUsed - ownedProjects.length),
                lastActiveAt: Date.now(),
            });
        }

        return {
            success: true,
            deletedCount: ownedProjects.length,
        };
    },
});

export const getProject = query({
    args: {
        projectId: v.id("projects")
    },
    handler: async (ctx, args) => {
        const user = await getAuthUserId(ctx)

        const project = await ctx.db.get(args.projectId)
        if (!project)
            throw new Error("Project not found")

        if (!user || project.userId !== user._id)
            throw new Error("Access denied")

        return project
    }
})

export const getProjectRevisions = query({
    args: {
        projectId: v.id("projects"),
        limit: v.optional(v.number()),
    },
    handler: async (ctx, args) => {
        const user = await getAuthUserId(ctx);
        await getOwnedProject(ctx, user, args.projectId);

        const limit = Math.min(Math.max(args.limit ?? 24, 1), 50);
        return await ctx.db
            .query("projectRevisions")
            .withIndex("by_projectId_and_createdAt", (q) => q.eq("projectId", args.projectId))
            .order("desc")
            .take(limit);
    },
});

export const createProjectRevision = mutation({
    args: {
        projectId: v.id("projects"),
        canvasState: v.any(),
        width: v.optional(v.number()),
        height: v.optional(v.number()),
        currentImageUrl: v.optional(v.string()),
        activeTransformations: v.optional(v.string()),
        title: v.optional(v.string()),
        summary: v.optional(v.string()),
        prompt: v.optional(v.string()),
        changes: v.optional(v.any()),
    },
    handler: async (ctx, args) => {
        const user = await getAuthUserId(ctx);
        const project = await getOwnedProject(ctx, user, args.projectId);

        const revision = {
            projectId: args.projectId,
            userId: user._id,
            canvasState: args.canvasState,
            width: args.width ?? project.width,
            height: args.height ?? project.height,
            changes: args.changes ?? [],
            createdAt: Date.now(),
        };

        if (args.title !== undefined) {
            revision.title = args.title;
        }

        if (args.summary !== undefined) {
            revision.summary = args.summary;
        }

        if (args.prompt !== undefined) {
            revision.prompt = args.prompt;
        }

        const currentImageUrl = args.currentImageUrl || project.currentImageUrl || project.originalImageUrl;
        if (currentImageUrl) {
            revision.currentImageUrl = currentImageUrl;
        }

        if (args.activeTransformations !== undefined) {
            revision.activeTransformations = args.activeTransformations;
        } else if (project.activeTransformations !== undefined) {
            revision.activeTransformations = project.activeTransformations;
        }

        const revisionId = await ctx.db.insert("projectRevisions", revision);

        const recentRevisions = await ctx.db
            .query("projectRevisions")
            .withIndex("by_projectId_and_createdAt", (q) => q.eq("projectId", args.projectId))
            .order("desc")
            .take(REVISION_LIMIT + 8);

        for (const oldRevision of recentRevisions.slice(REVISION_LIMIT)) {
            await ctx.db.delete(oldRevision._id);
        }

        await ctx.db.patch(user._id, {
            lastActiveAt: Date.now(),
        });

        return revisionId;
    },
});

export const restoreProjectRevision = mutation({
    args: {
        revisionId: v.id("projectRevisions"),
    },
    handler: async (ctx, args) => {
        const user = await getAuthUserId(ctx);
        const revision = await ctx.db.get(args.revisionId);

        if (!revision) {
            throw new Error("Version not found");
        }

        const project = await getOwnedProject(ctx, user, revision.projectId);

        const updateData = {
            canvasState: revision.canvasState,
            width: revision.width,
            height: revision.height,
            updatedAt: Date.now(),
        };

        if (revision.currentImageUrl !== undefined) {
            updateData.currentImageUrl = revision.currentImageUrl;
        }

        if (revision.activeTransformations !== undefined) {
            updateData.activeTransformations = revision.activeTransformations;
        }

        await ctx.db.patch(project._id, updateData);
        await ctx.db.patch(user._id, {
            lastActiveAt: Date.now(),
        });

        return revision;
    },
});

export const updateProject = mutation({
    args: {
        projectId: v.id("projects"),
        canvasState: v.optional(v.any()),
        width: v.optional(v.number()),
        height: v.optional(v.number()),
        currentImageUrl: v.optional(v.string()),
        thumbnailUrl: v.optional(v.string()),
        activeTransformations: v.optional(v.string()),
        backgroundRemoved: v.optional(v.boolean()),
    },
    handler: async (ctx, args) => {
        const user = await getAuthUserId(ctx)

        const project = await ctx.db.get(args.projectId)
        if (!project)
            throw new Error("Project not found")

        if (!user || project.userId !== user._id)
            throw new Error("Access denied")

        const updateData = {
            updatedAt: Date.now(),
        }

        if (args.canvasState !== undefined)
            updateData.canvasState = args.canvasState

        if (args.width !== undefined)
            updateData.width = args.width

        if (args.height !== undefined)
            updateData.height = args.height

        if (args.currentImageUrl !== undefined)
            updateData.currentImageUrl = args.currentImageUrl

        if (args.thumbnailUrl !== undefined)
            updateData.thumbnailUrl = args.thumbnailUrl

        if (args.activeTransformations !== undefined)
            updateData.activeTransformations = args.activeTransformations

        if (args.backgroundRemoved !== undefined)
            updateData.backgroundRemoved = args.backgroundRemoved

        await ctx.db.patch(args.projectId, updateData)

        await ctx.db.patch(user._id, {
            lastActiveAt: Date.now()
        })

        return args.projectId
    }
})
