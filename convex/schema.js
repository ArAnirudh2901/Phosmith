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

    // AI Edit-Plan cache. Same (image content + normalized prompt + planner version)
    // always returns the same plan, so "edit the same image multiple times using the
    // same instructions" is byte-exact repeatable across sessions.
    editPlanCache: defineTable({
        projectId: v.id("projects"),
        imageHash: v.string(),          // 32×32 pixel fingerprint of the source image
        promptKey: v.string(),          // normalized prompt (lowercase, collapsed whitespace)
        plannerVersion: v.number(),     // bump to invalidate cache when planner changes
        plan: v.any(),
        features: v.any(),
        source: v.string(),             // "gemini" | "fallback" | "ollama"
        createdAt: v.number(),
    })
        .index("by_lookup", ["projectId", "imageHash", "promptKey", "plannerVersion"]),
})

// PLAN LIMITS EXAMPLE:
// - Free: 3 projects, 20 exports/month, basic features only,
// - Pro: Unlimited projects/exports, all AI Features
