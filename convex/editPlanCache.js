import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { getAuthUserId } from "./users";

// Hamming distance between two 16-char hex strings (64-bit hashes).
// Convex runtime is V8 so BigInt is available.
const hammingDistance = (a, b) => {
    if (!a || !b || a.length !== 16 || b.length !== 16) return Number.POSITIVE_INFINITY;
    try {
        const x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
        let n = x;
        let count = 0;
        while (n !== 0n) {
            n &= n - 1n;
            count++;
        }
        return count;
    } catch {
        return Number.POSITIVE_INFINITY;
    }
};

// Look up a cached plan by content alone. Returns the same plan to every user
// who hits the same (imageHash, promptKey, plannerVersion). This is what
// guarantees that "two users editing the same image with the same prompt get
// the same output" — the LLM is only called on the FIRST miss for that key.
export const getPlan = query({
    args: {
        imageHash: v.string(),
        promptKey: v.string(),
        plannerVersion: v.number(),
    },
    handler: async (ctx, { imageHash, promptKey, plannerVersion }) => {
        const row = await ctx.db
            .query("editPlanCache")
            .withIndex("by_content", (q) =>
                q
                    .eq("imageHash", imageHash)
                    .eq("promptKey", promptKey)
                    .eq("plannerVersion", plannerVersion)
            )
            .first();
        if (!row) return null;
        return {
            plan: row.plan,
            features: row.features,
            source: row.source,
            createdAt: row.createdAt,
            model: row.model,
        };
    },
});

// Fuzzy lookup: if the exact hash misses, find the cached row with the
// SMALLEST Hamming distance from the query pHash, as long as it's within
// threshold. This is what makes "two users with slightly different
// versions of the same image" map to the same plan.
//
// Strategy: query both prefix and suffix bucket indexes. Pigeonhole means
// these together catch a wide range of near-matches without a full scan.
// Then compute exact Hamming distance on candidates and pick the closest.
export const getPlanFuzzy = query({
    args: {
        pHash: v.string(),
        pHashHead: v.string(),
        pHashTail: v.string(),
        promptKey: v.string(),
        plannerVersion: v.number(),
        threshold: v.optional(v.number()),
    },
    handler: async (ctx, args) => {
        const threshold = args.threshold ?? 8;
        // Fetch candidates from both bucket indexes in parallel.
        const [headCandidates, tailCandidates] = await Promise.all([
            ctx.db
                .query("editPlanCache")
                .withIndex("by_phash_head", (q) =>
                    q
                        .eq("pHashHead", args.pHashHead)
                        .eq("promptKey", args.promptKey)
                        .eq("plannerVersion", args.plannerVersion)
                )
                .take(64),
            ctx.db
                .query("editPlanCache")
                .withIndex("by_phash_tail", (q) =>
                    q
                        .eq("pHashTail", args.pHashTail)
                        .eq("promptKey", args.promptKey)
                        .eq("plannerVersion", args.plannerVersion)
                )
                .take(64),
        ]);

        const seen = new Set();
        let best = null;
        let bestDistance = Number.POSITIVE_INFINITY;
        for (const row of [...headCandidates, ...tailCandidates]) {
            if (seen.has(row._id)) continue;
            seen.add(row._id);
            if (!row.pHash) continue;
            const d = hammingDistance(args.pHash, row.pHash);
            if (d <= threshold && d < bestDistance) {
                best = row;
                bestDistance = d;
            }
        }

        if (!best) return null;
        return {
            plan: best.plan,
            features: best.features,
            source: best.source,
            createdAt: best.createdAt,
            model: best.model,
            matchedHash: best.imageHash,
            distance: bestDistance,
        };
    },
});

// Upsert by content key. projectId is recorded for audit (who first triggered
// this entry) but never used as part of the cache key.
export const savePlan = mutation({
    args: {
        imageHash: v.string(),
        promptKey: v.string(),
        plannerVersion: v.number(),
        plan: v.any(),
        features: v.any(),
        source: v.string(),
        pHash: v.optional(v.string()),
        pHashHead: v.optional(v.string()),
        pHashTail: v.optional(v.string()),
        projectId: v.optional(v.id("projects")),
        model: v.optional(v.string()),
        rawResponse: v.optional(v.any()),
    },
    handler: async (ctx, args) => {
        const user = await getAuthUserId(ctx);
        if (!user) throw new Error("Not authenticated");

        // If a projectId is supplied, sanity-check the caller actually owns it.
        // We still write the plan even on a mismatch (it's content-addressable)
        // but we won't pollute the audit field with someone else's project id.
        let auditProjectId = args.projectId;
        if (auditProjectId) {
            const project = await ctx.db.get(auditProjectId);
            if (!project || project.userId !== user._id) auditProjectId = undefined;
        }

        const existing = await ctx.db
            .query("editPlanCache")
            .withIndex("by_content", (q) =>
                q
                    .eq("imageHash", args.imageHash)
                    .eq("promptKey", args.promptKey)
                    .eq("plannerVersion", args.plannerVersion)
            )
            .first();

        const payload = {
            imageHash: args.imageHash,
            promptKey: args.promptKey,
            plannerVersion: args.plannerVersion,
            plan: args.plan,
            features: args.features,
            source: args.source,
            // Perceptual hash + bucket prefixes for fuzzy lookups. Optional —
            // older rows without these fields will simply never match fuzzily.
            pHash: args.pHash,
            pHashHead: args.pHashHead,
            pHashTail: args.pHashTail,
            projectId: auditProjectId,
            model: args.model,
            rawResponse: args.rawResponse,
            createdAt: Date.now(),
        };

        if (existing) {
            // Only overwrite when the new entry is a higher-quality source.
            // Specifically: never overwrite a cached "gemini" result with a
            // "fallback" one — that would erode cross-user determinism.
            const priority = { gemini: 3, ollama: 2, fallback: 1, cache: 0 };
            const existingPri = priority[existing.source] ?? 0;
            const newPri = priority[args.source] ?? 0;
            if (newPri >= existingPri) {
                await ctx.db.patch(existing._id, payload);
            }
            return existing._id;
        }
        return await ctx.db.insert("editPlanCache", payload);
    },
});
