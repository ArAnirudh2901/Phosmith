import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { getAuthUserId } from "./users";

// Same canvas + same prompt → same target selection. Cached forever (until
// plannerVersion bumps) so the LLM is only called once per unique (canvas, prompt).
export const getTargets = query({
    args: {
        canvasSignature: v.string(),
        promptKey: v.string(),
        plannerVersion: v.number(),
    },
    handler: async (ctx, { canvasSignature, promptKey, plannerVersion }) => {
        const row = await ctx.db
            .query("canvasTargetCache")
            .withIndex("by_signature", (q) =>
                q
                    .eq("canvasSignature", canvasSignature)
                    .eq("promptKey", promptKey)
                    .eq("plannerVersion", plannerVersion)
            )
            .first();
        if (!row) return null;
        return {
            targets: row.targets,
            needsConfirmation: row.needsConfirmation,
            reason: row.reason,
            model: row.model,
        };
    },
});

export const saveTargets = mutation({
    args: {
        canvasSignature: v.string(),
        promptKey: v.string(),
        plannerVersion: v.number(),
        targets: v.array(v.number()),
        needsConfirmation: v.boolean(),
        reason: v.optional(v.string()),
        model: v.optional(v.string()),
        rawResponse: v.optional(v.any()),
    },
    handler: async (ctx, args) => {
        const user = await getAuthUserId(ctx);
        if (!user) throw new Error("Not authenticated");

        const existing = await ctx.db
            .query("canvasTargetCache")
            .withIndex("by_signature", (q) =>
                q
                    .eq("canvasSignature", args.canvasSignature)
                    .eq("promptKey", args.promptKey)
                    .eq("plannerVersion", args.plannerVersion)
            )
            .first();

        const payload = {
            canvasSignature: args.canvasSignature,
            promptKey: args.promptKey,
            plannerVersion: args.plannerVersion,
            targets: args.targets,
            needsConfirmation: args.needsConfirmation,
            reason: args.reason,
            model: args.model,
            rawResponse: args.rawResponse,
            createdAt: Date.now(),
        };

        if (existing) {
            await ctx.db.patch(existing._id, payload);
            return existing._id;
        }
        return await ctx.db.insert("canvasTargetCache", payload);
    },
});
