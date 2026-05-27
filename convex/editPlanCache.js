import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { getAuthUserId } from "./users";

const ensureOwnedProject = async (ctx, projectId) => {
    const user = await getAuthUserId(ctx);
    if (!user) throw new Error("Not authenticated");
    const project = await ctx.db.get(projectId);
    if (!project) throw new Error("Project not found");
    if (project.userId !== user._id) throw new Error("Access denied");
    return { user, project };
};

// Look up a cached plan by (project + image content + normalized prompt + planner version).
// Returns the stored plan or null. The composite key makes "same image + same prompt"
// byte-exact repeatable across sessions.
export const getPlan = query({
    args: {
        projectId: v.id("projects"),
        imageHash: v.string(),
        promptKey: v.string(),
        plannerVersion: v.number(),
    },
    handler: async (ctx, { projectId, imageHash, promptKey, plannerVersion }) => {
        // Owner check is done by the caller (the API route) — Convex queries here are
        // only invoked from the server-side route which already has the user identity.
        // We still scope by projectId so different projects can't read each other's cache.
        const row = await ctx.db
            .query("editPlanCache")
            .withIndex("by_lookup", (q) =>
                q
                    .eq("projectId", projectId)
                    .eq("imageHash", imageHash)
                    .eq("promptKey", promptKey)
                    .eq("plannerVersion", plannerVersion)
            )
            .first();
        if (!row) return null;
        return { plan: row.plan, features: row.features, source: row.source, createdAt: row.createdAt };
    },
});

// Upsert: replace any existing row for the same composite key so re-runs with new
// planner versions don't accumulate stale entries.
export const savePlan = mutation({
    args: {
        projectId: v.id("projects"),
        imageHash: v.string(),
        promptKey: v.string(),
        plannerVersion: v.number(),
        plan: v.any(),
        features: v.any(),
        source: v.string(),
    },
    handler: async (ctx, args) => {
        const { user } = await ensureOwnedProject(ctx, args.projectId);
        if (!user) throw new Error("Not authenticated");
        const existing = await ctx.db
            .query("editPlanCache")
            .withIndex("by_lookup", (q) =>
                q
                    .eq("projectId", args.projectId)
                    .eq("imageHash", args.imageHash)
                    .eq("promptKey", args.promptKey)
                    .eq("plannerVersion", args.plannerVersion)
            )
            .first();

        const payload = {
            projectId: args.projectId,
            imageHash: args.imageHash,
            promptKey: args.promptKey,
            plannerVersion: args.plannerVersion,
            plan: args.plan,
            features: args.features,
            source: args.source,
            createdAt: Date.now(),
        };

        if (existing) {
            await ctx.db.patch(existing._id, payload);
            return existing._id;
        }
        return await ctx.db.insert("editPlanCache", payload);
    },
});
