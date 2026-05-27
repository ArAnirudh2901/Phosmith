import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
    users: defineTable({
        name: v.string(),
        tokenIdentifier: v.string(),
        imageUrl: v.optional(v.string()),
        plan: v.union(v.literal("free"), v.literal("pro")),

        // Users tracking for plan limits
        projectsUsed: v.number(),
        exportsThisMonth: v.number(),

        createdAt: v.number(),
        lastActiveAt: v.number(),
        email: v.optional(v.string())
    })
        .index("by_token", ["tokenIdentifier"])
        .index("by_email", ["email"])
        .searchIndex("search_name", { searchField: "name" })
        .searchIndex("search_email", { searchField: "email" }),

    projects: defineTable({
        // Basic information about the project
        title: v.string(),
        userId: v.id("users"),  // Foreign key to the Users table

        // Details related to the Canvas
        canvasState: v.any(), // Fabric.js canvas JSON (objects, layers, etc)
        width: v.number(),    // Canvas width in pixels
        height: v.number(),    // Canvas height in pixels

        // Image Pipeline - Tracks the image transformations
        originalImageUrl: v.optional(v.string()),  // Initial uploaded image
        currentImageUrl: v.optional(v.string()),   // Current processed image
        thumbnailUrl: v.optional(v.string()),      // HW - Small preview for dashboard

        // Imagekit transformations State
        activeTransformations: v.optional(v.string()),  // Current Imagekit URL params

        // AI Features State - Tracks what AI processing has been applied
        backgroundRemoved: v.optional(v.boolean()),

        // Organization 
        folderId: v.optional(v.id("folders")),  // Optional Folder Organization

        // Timestamps
        createdAt: v.number(),
        updatedAt: v.number(),
    })
        .index("by_user", ["userId"])
        .index("by_user_updated", ["userId", "updatedAt"])
        .index("by_folder", ["folderId"]), // Projects in Folder

    projectRevisions: defineTable({
        projectId: v.id("projects"),
        userId: v.id("users"),
        canvasState: v.any(),
        width: v.number(),
        height: v.number(),
        currentImageUrl: v.optional(v.string()),
        activeTransformations: v.optional(v.string()),
        title: v.optional(v.string()),
        summary: v.optional(v.string()),
        prompt: v.optional(v.string()),
        changes: v.optional(v.any()),
        createdAt: v.number(),
    })
        .index("by_projectId_and_createdAt", ["projectId", "createdAt"])
        .index("by_userId_and_createdAt", ["userId", "createdAt"]),

    folders: defineTable({
        name: v.string(),              // Folder name
        userId: v.id("users"),         // Owner
        createdAt: v.number(),
    })
        .index("by_user", ["userId"]),  // User's folders

    // AI Edit-Plan cache. CONTENT-ADDRESSABLE: keyed by (imageHash, promptKey,
    // plannerVersion) only — projectId is stored for audit but not part of the index.
    // This guarantees the same image bytes + same prompt return the same plan to ANY
    // user, not just the one who first computed it. The LLM is only called on the
    // first (image, prompt) miss; every subsequent user (or session) reads the same row.
    // Canvas-target cache for the multi-image AI agent. Given a canvas with N
    // images and a user prompt, Gemini picks which images the prompt is
    // referring to (by name, by description, or by visual property). The
    // (canvasSignature, promptKey) → target-indexes mapping is cached here so
    // two users with the same canvas + same prompt always pick the same
    // images. The cache row never holds image bytes — just indexes + reasoning.
    canvasTargetCache: defineTable({
        canvasSignature: v.string(),    // hash of (sorted layer names + their image hashes)
        promptKey: v.string(),
        plannerVersion: v.number(),
        targets: v.array(v.number()),    // layer indexes selected
        needsConfirmation: v.boolean(),  // true when Gemini was uncertain
        reason: v.optional(v.string()),
        model: v.optional(v.string()),
        rawResponse: v.optional(v.any()),
        createdAt: v.number(),
    })
        .index("by_signature", ["canvasSignature", "promptKey", "plannerVersion"]),

    editPlanCache: defineTable({
        imageHash: v.string(),                  // 32×32 pixel fingerprint (exact-match key)
        promptKey: v.string(),                  // normalized prompt (NFC + lowercase + collapsed whitespace)
        plannerVersion: v.number(),             // bump to invalidate cache when planner changes
        plan: v.any(),
        features: v.any(),
        source: v.string(),                     // "gemini" | "fallback" | "ollama" | "fuzzy"
        // Perceptual hashing (dHash) — for "slightly different image, same scene"
        // matches. pHash is a 16-char hex (64-bit) perceptual fingerprint.
        // Bucketed prefix/suffix indexes let us find candidates with low Hamming
        // distance without scanning the whole table.
        pHash: v.optional(v.string()),
        pHashHead: v.optional(v.string()),      // first 4 hex chars (16-bit prefix bucket)
        pHashTail: v.optional(v.string()),      // last 4 hex chars (16-bit suffix bucket)
        // Audit fields — written but never used as cache key.
        projectId: v.optional(v.id("projects")), // which project first triggered this entry
        model: v.optional(v.string()),           // e.g. "gemini-2.5-flash"
        rawResponse: v.optional(v.any()),        // pre-sanitization LLM JSON, for drift detection
        createdAt: v.number(),
    })
        .index("by_content", ["imageHash", "promptKey", "plannerVersion"])
        .index("by_phash_head", ["pHashHead", "promptKey", "plannerVersion"])
        .index("by_phash_tail", ["pHashTail", "promptKey", "plannerVersion"]),
})

// PLAN LIMITS EXAMPLE:
// - Free: 3 projects, 20 exports/month, basic features only,
// - Pro: Unlimited projects/exports, all AI Features
