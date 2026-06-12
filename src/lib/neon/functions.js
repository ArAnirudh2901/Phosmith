import { requirePrisma } from "@/lib/prisma";
import { getRedis, isRedisConfigured } from "@/lib/redis";

// The canvas-snapshot route caches project ownership in Redis (1h TTL,
// canvas:owner:<projectId>) to spare a Neon read per autosave. Deleting a
// project must fence that cache immediately, so a deleted project can't keep
// accepting snapshot writes for the rest of the TTL. Best-effort — Redis
// being unavailable never blocks a delete.
const dropOwnerCache = async (projectIds) => {
  if (!isRedisConfigured()) return;
  try {
    const redis = getRedis();
    const ids = Array.isArray(projectIds) ? projectIds : [projectIds];
    await Promise.all(ids.map((id) => redis.del(`canvas:owner:${id}`)));
  } catch {
    /* best-effort */
  }
};

const REVISION_LIMIT = 40;

const clean = (payload) =>
  Object.fromEntries(Object.entries(payload || {}).filter(([, value]) => value !== undefined));

const asDate = (value = Date.now()) =>
  value instanceof Date ? value : new Date(Number(value) || Date.now());

const toMs = (value) => {
  if (!value) return undefined;
  if (value instanceof Date) return value.getTime();
  return Number(value);
};

const ensureDb = async () => {
  return await requirePrisma();
};

const withDocFields = (row) => {
  if (!row) return row;
  const out = { ...row, _id: row.id };
  if (row.createdAt) out.createdAt = toMs(row.createdAt);
  if (row.updatedAt) out.updatedAt = toMs(row.updatedAt);
  if (row.lastActiveAt) out.lastActiveAt = toMs(row.lastActiveAt);
  if (row.appliedAt) out.appliedAt = toMs(row.appliedAt);
  if (row.removedAt) out.removedAt = toMs(row.removedAt);
  return out;
};

const hammingDistance = (a, b) => {
  if (!a || !b || a.length !== 16 || b.length !== 16) return Number.POSITIVE_INFINITY;
  try {
    let n = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
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

const requireAuth = (ctx) => {
  if (!ctx?.auth) throw new Error("Not authenticated");
  return ctx.auth;
};

const findUserForAuth = async (db, auth) => {
  if (!auth) return null;
  const or = [
    auth.clerkUserId ? { clerkUserId: auth.clerkUserId } : null,
    auth.tokenIdentifier ? { tokenIdentifier: auth.tokenIdentifier } : null,
    auth.email ? { email: auth.email } : null,
  ].filter(Boolean);
  if (!or.length) return null;
  return await db.user.findFirst({
    where: { OR: or },
  });
};

const upsertAuthenticatedUser = async (db, auth) => {
  requireAuth({ auth });
  const existing = await findUserForAuth(db, auth);
  const now = new Date();
  const data = clean({
    clerkUserId: auth.clerkUserId,
    tokenIdentifier: auth.tokenIdentifier,
    name: auth.name || "Anonymous",
    email: auth.email,
    imageUrl: auth.imageUrl,
    lastActiveAt: now,
  });

  if (existing) {
    const updated = await db.user.update({
      where: { id: existing.id },
      data,
    });
    return updated;
  }

  return await db.user.create({
    data: {
      ...data,
      plan: "free",
      projectsUsed: 0,
      exportsThisMonth: 0,
      createdAt: now,
    },
  });
};

const getAuthUser = async (db, ctx) => {
  const auth = requireAuth(ctx);
  const existing = await findUserForAuth(db, auth);
  if (existing) return existing;
  return await upsertAuthenticatedUser(db, auth);
};

const getOwnedProject = async (db, user, projectId) => {
  const project = await db.project.findUnique({ where: { id: projectId } });
  if (!project) throw new Error("Project not found");
  if (!user || project.userId !== user.id) throw new Error("Access denied");
  return project;
};

const getOwnedEditSet = async (db, user, editSetId) => {
  const editSet = await db.agentEditSet.findUnique({ where: { id: editSetId } });
  if (!editSet) throw new Error("Agent edit set not found");
  if (!user || editSet.userId !== user.id) throw new Error("Access denied");
  await getOwnedProject(db, user, editSet.projectId);
  return editSet;
};

const trimProjectRevisions = async (db, projectId) => {
  const old = await db.projectRevision.findMany({
    where: { projectId },
    orderBy: { createdAt: "desc" },
    skip: REVISION_LIMIT,
    take: 100,
    select: { id: true },
  });
  if (old.length) {
    await db.projectRevision.deleteMany({ where: { id: { in: old.map((row) => row.id) } } });
  }
};

const snapshotPayload = ({ editSet, user, kind, canvasState, currentImageUrl, activeTransformations }) => {
  if (canvasState === undefined) return null;
  return clean({
    editSetId: editSet.id,
    projectId: editSet.projectId,
    userId: user.id,
    kind,
    canvasState,
    currentImageUrl,
    activeTransformations,
    updatedAt: new Date(),
  });
};

const upsertSnapshot = async (db, args) => {
  const payload = snapshotPayload(args);
  if (!payload) return null;
  return await db.agentEditSetSnapshot.upsert({
    where: {
      editSetId_kind: {
        editSetId: payload.editSetId,
        kind: payload.kind,
      },
    },
    update: payload,
    create: {
      ...payload,
      createdAt: new Date(),
    },
  });
};

const attachSnapshots = (editSet) => {
  if (!editSet) return editSet;
  const before = editSet.snapshots?.find((snapshot) => snapshot.kind === "before");
  const after = editSet.snapshots?.find((snapshot) => snapshot.kind === "after");
  const { snapshots: _snapshots, ...rest } = editSet;
  return withDocFields({
    ...rest,
    beforeCanvasState: rest.beforeCanvasState ?? before?.canvasState,
    afterCanvasState: rest.afterCanvasState ?? after?.canvasState,
    currentImageUrlBefore: rest.currentImageUrlBefore ?? before?.currentImageUrl,
    currentImageUrlAfter: rest.currentImageUrlAfter ?? after?.currentImageUrl,
    activeTransformationsBefore: rest.activeTransformationsBefore ?? before?.activeTransformations,
    activeTransformationsAfter: rest.activeTransformationsAfter ?? after?.activeTransformations,
  });
};

const functions = {
  "users.store": async (ctx) => {
    const db = await ensureDb();
    const user = await upsertAuthenticatedUser(db, requireAuth(ctx));
    return user.id;
  },

  "users.getCurrentUser": async (ctx) => {
    const db = await ensureDb();
    return withDocFields(await getAuthUser(db, ctx));
  },

  "users.syncPlan": async (ctx, args) => {
    const db = await ensureDb();
    const user = await getAuthUser(db, ctx);
    const plan = args.plan === "pro" ? "pro" : "free";
    await db.user.update({
      where: { id: user.id },
      data: { plan, lastActiveAt: new Date() },
    });
    return { plan };
  },

  "projects.create": async (ctx, args) => {
    const db = await ensureDb();
    const user = await getAuthUser(db, ctx);

    if (user.plan === "free") {
      const count = await db.project.count({ where: { userId: user.id } });
      if (count >= 3) {
        throw new Error("Free plan limited to 3 projects. Upgrade to pro for unlimited projects.");
      }
    }

    const now = new Date();
    const project = await db.$transaction(async (tx) => {
      const created = await tx.project.create({
        data: clean({
          title: args.title,
          userId: user.id,
          originalImageUrl: args.originalImageUrl,
          currentImageUrl: args.currentImageUrl,
          thumbnailUrl: args.thumbnailUrl,
          width: Math.round(args.width),
          height: Math.round(args.height),
          canvasState: args.canvasState ?? null,
          createdAt: now,
          updatedAt: now,
        }),
      });

      await tx.projectRevision.create({
        data: clean({
          projectId: created.id,
          userId: user.id,
          canvasState: args.canvasState ?? null,
          width: created.width,
          height: created.height,
          currentImageUrl: args.currentImageUrl || args.originalImageUrl,
          title: "Original import",
          summary: "Starting project state",
          changes: [],
          createdAt: now,
        }),
      });

      await tx.user.update({
        where: { id: user.id },
        data: {
          projectsUsed: { increment: 1 },
          lastActiveAt: now,
        },
      });

      return created;
    });

    return project.id;
  },

  "projects.getUserProjects": async (ctx) => {
    const db = await ensureDb();
    const user = await getAuthUser(db, ctx);
    const rows = await db.project.findMany({
      where: { userId: user.id },
      orderBy: { updatedAt: "desc" },
    });
    return rows.map(withDocFields);
  },

  "projects.deleteProject": async (ctx, args) => {
    const db = await ensureDb();
    const user = await getAuthUser(db, ctx);
    await getOwnedProject(db, user, args.projectId);
    await db.$transaction([
      db.project.delete({ where: { id: args.projectId } }),
      db.user.update({
        where: { id: user.id },
        data: {
          projectsUsed: Math.max(0, user.projectsUsed - 1),
          lastActiveAt: new Date(),
        },
      }),
    ]);
    await dropOwnerCache(args.projectId);
    return { success: true };
  },

  "projects.bulkDeleteProjects": async (ctx, args) => {
    const db = await ensureDb();
    const user = await getAuthUser(db, ctx);
    const ids = [...new Set(args.projectIds || [])];
    if (!ids.length) return { success: true, deletedCount: 0 };

    const owned = await db.project.findMany({
      where: { id: { in: ids }, userId: user.id },
      select: { id: true },
    });
    const ownedIds = owned.map((row) => row.id);

    await db.$transaction([
      db.project.deleteMany({ where: { id: { in: ownedIds }, userId: user.id } }),
      db.user.update({
        where: { id: user.id },
        data: {
          projectsUsed: Math.max(0, user.projectsUsed - ownedIds.length),
          lastActiveAt: new Date(),
        },
      }),
    ]);
    await dropOwnerCache(ownedIds);

    return { success: true, deletedCount: ownedIds.length };
  },

  "projects.getProject": async (ctx, args) => {
    const db = await ensureDb();
    const user = await getAuthUser(db, ctx);
    return withDocFields(await getOwnedProject(db, user, args.projectId));
  },

  "projects.getProjectRevisions": async (ctx, args) => {
    const db = await ensureDb();
    const user = await getAuthUser(db, ctx);
    await getOwnedProject(db, user, args.projectId);
    const limit = Math.min(Math.max(Number(args.limit ?? 24), 1), 50);
    const rows = await db.projectRevision.findMany({
      where: { projectId: args.projectId },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    return rows.map(withDocFields);
  },

  "projects.createProjectRevision": async (ctx, args) => {
    const db = await ensureDb();
    const user = await getAuthUser(db, ctx);
    const project = await getOwnedProject(db, user, args.projectId);
    const currentImageUrl = args.currentImageUrl || project.currentImageUrl || project.originalImageUrl;

    const revision = await db.projectRevision.create({
      data: clean({
        projectId: project.id,
        userId: user.id,
        canvasState: args.canvasState,
        width: Math.round(args.width ?? project.width),
        height: Math.round(args.height ?? project.height),
        currentImageUrl,
        activeTransformations: args.activeTransformations ?? project.activeTransformations,
        title: args.title,
        summary: args.summary,
        prompt: args.prompt,
        changes: args.changes ?? [],
        createdAt: new Date(),
      }),
    });

    await trimProjectRevisions(db, project.id);
    await db.user.update({ where: { id: user.id }, data: { lastActiveAt: new Date() } });
    return revision.id;
  },

  "projects.restoreProjectRevision": async (ctx, args) => {
    const db = await ensureDb();
    const user = await getAuthUser(db, ctx);
    const revision = await db.projectRevision.findUnique({ where: { id: args.revisionId } });
    if (!revision) throw new Error("Version not found");
    await getOwnedProject(db, user, revision.projectId);

    await db.project.update({
      where: { id: revision.projectId },
      data: clean({
        canvasState: revision.canvasState,
        width: revision.width,
        height: revision.height,
        currentImageUrl: revision.currentImageUrl,
        activeTransformations: revision.activeTransformations,
        updatedAt: new Date(),
      }),
    });
    await db.user.update({ where: { id: user.id }, data: { lastActiveAt: new Date() } });
    return withDocFields(revision);
  },

  "projects.updateProject": async (ctx, args) => {
    const db = await ensureDb();
    const user = await getAuthUser(db, ctx);
    await getOwnedProject(db, user, args.projectId);

    const updated = await db.project.update({
      where: { id: args.projectId },
      data: clean({
        canvasState: args.canvasState,
        width: args.width !== undefined ? Math.round(args.width) : undefined,
        height: args.height !== undefined ? Math.round(args.height) : undefined,
        currentImageUrl: args.currentImageUrl,
        thumbnailUrl: args.thumbnailUrl,
        activeTransformations: args.activeTransformations,
        backgroundRemoved: args.backgroundRemoved,
        updatedAt: new Date(),
      }),
    });
    await db.user.update({ where: { id: user.id }, data: { lastActiveAt: new Date() } });
    return updated.id;
  },

  // Optimistic-concurrency canvas flush. Bumps `revision` on every write so two
  // sessions editing the same project can't silently clobber each other.
  //   - expectedRevision given + matches  → write + return { ok, revision }
  //   - expectedRevision given + mismatch → no write, return { conflict, project }
  //   - force / no expectedRevision        → unconditional write + bump (used for
  //     "keep mine" overwrite and legacy callers).
  "projects.flushCanvasState": async (ctx, args) => {
    const db = await ensureDb();
    const user = await getAuthUser(db, ctx);
    await getOwnedProject(db, user, args.projectId); // ownership guard

    const data = clean({
      canvasState: args.canvasState,
      currentImageUrl: args.currentImageUrl,
      updatedAt: new Date(),
    });

    // Unconditional overwrite — ONLY when the caller explicitly forces it
    // ("Keep mine" conflict resolution). A merely missing/invalid revision must
    // never reach this path, or it would silently bypass the concurrency check.
    if (args.force === true) {
      const updated = await db.project.update({
        where: { id: args.projectId },
        data: { ...data, revision: { increment: 1 } },
      });
      await db.user.update({ where: { id: user.id }, data: { lastActiveAt: new Date() } });
      return { ok: true, revision: updated.revision };
    }

    const expected = Number(args.expectedRevision);
    if (!Number.isInteger(expected)) {
      // No usable baseline → refuse rather than clobber. The caller keeps the
      // work locally (IndexedDB) and reconciles on the next load.
      return { ok: false, reason: "no-base-revision" };
    }

    // Atomic conditional write: only succeeds if nobody advanced the revision
    // since the client loaded it. updateMany returns the affected-row count.
    const result = await db.project.updateMany({
      where: { id: args.projectId, revision: expected },
      data: { ...data, revision: { increment: 1 } },
    });
    if (result.count === 0) {
      const current = await db.project.findUnique({ where: { id: args.projectId } });
      return { conflict: true, project: withDocFields(current) };
    }
    await db.user.update({ where: { id: user.id }, data: { lastActiveAt: new Date() } });
    return { ok: true, revision: expected + 1 };
  },

  "agentEditSets.listForProject": async (ctx, args) => {
    const db = await ensureDb();
    const user = await getAuthUser(db, ctx);
    await getOwnedProject(db, user, args.projectId);
    const limit = Math.min(Math.max(Number(args.limit ?? 12), 1), 32);
    const rows = await db.agentEditSet.findMany({
      where: { projectId: args.projectId, userId: user.id },
      orderBy: { updatedAt: "desc" },
      take: limit,
      include: { snapshots: true },
    });
    return rows.map(attachSnapshots);
  },

  "agentEditSets.createOrUpdateDraft": async (ctx, args) => {
    const db = await ensureDb();
    const user = await getAuthUser(db, ctx);
    await getOwnedProject(db, user, args.projectId);

    const now = new Date();
    const payload = clean({
      projectId: args.projectId,
      userId: user.id,
      prompt: args.prompt,
      title: args.title,
      summary: args.summary,
      status: "pending",
      plan: args.plan,
      enabledChanges: args.enabledChanges,
      effectValues: args.effectValues,
      effectivePlan: args.effectivePlan,
      changes: args.changes,
      currentImageUrlBefore: args.currentImageUrlBefore,
      currentImageUrlAfter: args.currentImageUrlAfter,
      activeTransformationsBefore: args.activeTransformationsBefore,
      activeTransformationsAfter: args.activeTransformationsAfter,
      updatedAt: now,
    });

    let editSet;
    if (args.editSetId) {
      await getOwnedEditSet(db, user, args.editSetId);
      editSet = await db.agentEditSet.update({
        where: { id: args.editSetId },
        data: payload,
      });
    } else {
      editSet = await db.agentEditSet.create({
        data: {
          ...payload,
          createdAt: now,
        },
      });
    }

    await Promise.all([
      upsertSnapshot(db, {
        editSet,
        user,
        kind: "before",
        canvasState: args.beforeCanvasState,
        currentImageUrl: args.currentImageUrlBefore,
        activeTransformations: args.activeTransformationsBefore,
      }),
      upsertSnapshot(db, {
        editSet,
        user,
        kind: "after",
        canvasState: args.afterCanvasState,
        currentImageUrl: args.currentImageUrlAfter,
        activeTransformations: args.activeTransformationsAfter,
      }),
    ]);

    return editSet.id;
  },

  "agentEditSets.getWithSnapshots": async (ctx, args) => {
    const db = await ensureDb();
    const user = await getAuthUser(db, ctx);
    await getOwnedEditSet(db, user, args.editSetId);
    const row = await db.agentEditSet.findUnique({
      where: { id: args.editSetId },
      include: { snapshots: true },
    });
    return attachSnapshots(row);
  },

  "agentEditSets.saveSnapshot": async (ctx, args) => {
    const db = await ensureDb();
    const user = await getAuthUser(db, ctx);
    const editSet = await getOwnedEditSet(db, user, args.editSetId);
    const snapshot = await upsertSnapshot(db, {
      editSet,
      user,
      kind: args.kind,
      canvasState: args.canvasState,
      currentImageUrl: args.currentImageUrl,
      activeTransformations: args.activeTransformations,
    });
    return snapshot?.id || null;
  },

  "agentEditSets.markApplied": async (ctx, args) => {
    const db = await ensureDb();
    const user = await getAuthUser(db, ctx);
    const editSet = await getOwnedEditSet(db, user, args.editSetId);
    const now = new Date();

    await db.agentEditSet.update({
      where: { id: args.editSetId },
      data: clean({
        status: "applied",
        appliedAt: now,
        updatedAt: now,
        currentImageUrlBefore: args.currentImageUrlBefore,
        currentImageUrlAfter: args.currentImageUrlAfter,
        activeTransformationsBefore: args.activeTransformationsBefore,
        activeTransformationsAfter: args.activeTransformationsAfter,
        enabledChanges: args.enabledChanges,
        effectValues: args.effectValues,
        effectivePlan: args.effectivePlan,
        changes: args.changes,
      }),
    });

    await Promise.all([
      upsertSnapshot(db, {
        editSet,
        user,
        kind: "before",
        canvasState: args.beforeCanvasState,
        currentImageUrl: args.currentImageUrlBefore,
        activeTransformations: args.activeTransformationsBefore,
      }),
      upsertSnapshot(db, {
        editSet,
        user,
        kind: "after",
        canvasState: args.afterCanvasState,
        currentImageUrl: args.currentImageUrlAfter,
        activeTransformations: args.activeTransformationsAfter,
      }),
    ]);

    return args.editSetId;
  },

  "agentEditSets.markPending": async (ctx, args) => {
    const db = await ensureDb();
    const user = await getAuthUser(db, ctx);
    const editSet = await getOwnedEditSet(db, user, args.editSetId);

    await db.agentEditSet.update({
      where: { id: args.editSetId },
      data: clean({
        status: "pending",
        updatedAt: new Date(),
        enabledChanges: args.enabledChanges,
        effectValues: args.effectValues,
        effectivePlan: args.effectivePlan,
        changes: args.changes,
      }),
    });

    await upsertSnapshot(db, {
      editSet,
      user,
      kind: "after",
      canvasState: args.afterCanvasState,
    });

    return args.editSetId;
  },

  "agentEditSets.markRemoved": async (ctx, args) => {
    const db = await ensureDb();
    const user = await getAuthUser(db, ctx);
    await getOwnedEditSet(db, user, args.editSetId);
    await db.agentEditSet.update({
      where: { id: args.editSetId },
      data: {
        status: "removed",
        removedAt: new Date(),
        updatedAt: new Date(),
      },
    });
    return args.editSetId;
  },

  "editPlanCache.getPlan": async (_ctx, args) => {
    const db = await ensureDb();
    const row = await db.editPlanCache.findUnique({
      where: {
        imageHash_promptKey_plannerVersion: {
          imageHash: args.imageHash,
          promptKey: args.promptKey,
          plannerVersion: args.plannerVersion,
        },
      },
    });
    if (!row) return null;
    return {
      plan: row.plan,
      features: row.features,
      source: row.source,
      createdAt: toMs(row.createdAt),
      model: row.model,
    };
  },

  "editPlanCache.getPlanFuzzy": async (_ctx, args) => {
    const db = await ensureDb();
    const threshold = args.threshold ?? 8;
    const [headCandidates, tailCandidates] = await Promise.all([
      db.editPlanCache.findMany({
        where: {
          pHashHead: args.pHashHead,
          promptKey: args.promptKey,
          plannerVersion: args.plannerVersion,
        },
        take: 64,
      }),
      db.editPlanCache.findMany({
        where: {
          pHashTail: args.pHashTail,
          promptKey: args.promptKey,
          plannerVersion: args.plannerVersion,
        },
        take: 64,
      }),
    ]);

    const seen = new Set();
    let best = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const row of [...headCandidates, ...tailCandidates]) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      const distance = hammingDistance(args.pHash, row.pHash);
      if (distance <= threshold && distance < bestDistance) {
        best = row;
        bestDistance = distance;
      }
    }

    if (!best) return null;
    return {
      plan: best.plan,
      features: best.features,
      source: best.source,
      createdAt: toMs(best.createdAt),
      model: best.model,
      matchedHash: best.imageHash,
      distance: bestDistance,
    };
  },

  "editPlanCache.savePlan": async (ctx, args) => {
    const db = await ensureDb();
    const user = await getAuthUser(db, ctx);
    let auditProjectId = args.projectId;
    if (auditProjectId) {
      const project = await db.project.findUnique({ where: { id: auditProjectId } });
      if (!project || project.userId !== user.id) auditProjectId = undefined;
    }

    const existing = await db.editPlanCache.findUnique({
      where: {
        imageHash_promptKey_plannerVersion: {
          imageHash: args.imageHash,
          promptKey: args.promptKey,
          plannerVersion: args.plannerVersion,
        },
      },
    });

    const payload = clean({
      imageHash: args.imageHash,
      promptKey: args.promptKey,
      plannerVersion: args.plannerVersion,
      plan: args.plan,
      features: args.features,
      source: args.source,
      pHash: args.pHash,
      pHashHead: args.pHashHead,
      pHashTail: args.pHashTail,
      projectId: auditProjectId,
      userId: user.id,
      model: args.model,
      rawResponse: args.rawResponse,
      createdAt: new Date(),
    });

    if (existing) {
      const priority = { gemini: 3, ollama: 2, fallback: 1, cache: 0, fuzzy: 0 };
      if ((priority[args.source] ?? 0) >= (priority[existing.source] ?? 0)) {
        await db.editPlanCache.update({ where: { id: existing.id }, data: payload });
      }
      return existing.id;
    }

    const row = await db.editPlanCache.create({ data: payload });
    return row.id;
  },

  "canvasTargetCache.getTargets": async (_ctx, args) => {
    const db = await ensureDb();
    const row = await db.canvasTargetCache.findUnique({
      where: {
        canvasSignature_promptKey_plannerVersion: {
          canvasSignature: args.canvasSignature,
          promptKey: args.promptKey,
          plannerVersion: args.plannerVersion,
        },
      },
    });
    if (!row) return null;
    return {
      targets: row.targets,
      needsConfirmation: row.needsConfirmation,
      reason: row.reason,
      model: row.model,
    };
  },

  "canvasTargetCache.saveTargets": async (ctx, args) => {
    const db = await ensureDb();
    await getAuthUser(db, ctx);
    const row = await db.canvasTargetCache.upsert({
      where: {
        canvasSignature_promptKey_plannerVersion: {
          canvasSignature: args.canvasSignature,
          promptKey: args.promptKey,
          plannerVersion: args.plannerVersion,
        },
      },
      update: clean({
        targets: args.targets,
        needsConfirmation: args.needsConfirmation,
        reason: args.reason,
        model: args.model,
        rawResponse: args.rawResponse,
        createdAt: new Date(),
      }),
      create: clean({
        canvasSignature: args.canvasSignature,
        promptKey: args.promptKey,
        plannerVersion: args.plannerVersion,
        targets: args.targets,
        needsConfirmation: args.needsConfirmation,
        reason: args.reason,
        model: args.model,
        rawResponse: args.rawResponse,
        createdAt: new Date(),
      }),
    });
    return row.id;
  },

  // ── Edit-judge cache (12-axis verdicts; see /api/ai/edit-judge) ──────────
  // Same discipline as editPlanCache: identical (beforeHash, afterHash,
  // planHash, judgeVersion) tuples return byte-identical scores forever.

  "editJudgeCache.getVerdict": async (_ctx, args) => {
    const db = await ensureDb();
    const row = await db.editJudgeCache.findUnique({
      where: {
        beforeHash_afterHash_planHash_judgeVersion: {
          beforeHash: args.beforeHash,
          afterHash: args.afterHash,
          planHash: args.planHash,
          judgeVersion: args.judgeVersion,
        },
      },
    });
    if (!row) return null;
    return {
      axes: row.axes,
      overall: row.overall,
      correctiveHint: row.correctiveHint,
      source: row.source,
      model: row.model,
      createdAt: toMs(row.createdAt),
    };
  },

  "editJudgeCache.saveVerdict": async (ctx, args) => {
    const db = await ensureDb();
    const user = await getAuthUser(db, ctx);
    let auditProjectId = args.projectId;
    if (auditProjectId) {
      const project = await db.project.findUnique({ where: { id: auditProjectId } });
      if (!project || project.userId !== user.id) auditProjectId = undefined;
    }
    const row = await db.editJudgeCache.upsert({
      where: {
        beforeHash_afterHash_planHash_judgeVersion: {
          beforeHash: args.beforeHash,
          afterHash: args.afterHash,
          planHash: args.planHash,
          judgeVersion: args.judgeVersion,
        },
      },
      update: clean({
        axes: args.axes,
        overall: args.overall,
        correctiveHint: args.correctiveHint,
        source: args.source,
        model: args.model,
        rawResponse: args.rawResponse,
      }),
      create: clean({
        beforeHash: args.beforeHash,
        afterHash: args.afterHash,
        planHash: args.planHash,
        judgeVersion: args.judgeVersion,
        axes: args.axes,
        overall: args.overall,
        correctiveHint: args.correctiveHint,
        source: args.source,
        projectId: auditProjectId,
        userId: user.id,
        model: args.model,
        rawResponse: args.rawResponse,
        createdAt: new Date(),
      }),
    });
    return row.id;
  },

  // ── Durable agent-run journal (resume a crashed loop per-step) ───────────

  "agentRun.start": async (ctx, args) => {
    const db = await ensureDb();
    const user = await getAuthUser(db, ctx);
    const project = await db.project.findUnique({ where: { id: args.projectId } });
    if (!project || project.userId !== user.id) throw new Error("Project not found");
    const row = await db.agentRun.create({
      data: clean({
        projectId: args.projectId,
        userId: user.id,
        imageHash: args.imageHash,
        promptKey: args.promptKey,
        prompt: args.prompt,
        plan: args.plan,
        status: "running",
        stepIndex: 0,
        iteration: args.iteration ?? 0,
      }),
    });
    return withDocFields(row);
  },

  "agentRun.getResumable": async (ctx, args) => {
    const db = await ensureDb();
    const user = await getAuthUser(db, ctx);
    const row = await db.agentRun.findFirst({
      where: {
        projectId: args.projectId,
        userId: user.id,
        imageHash: args.imageHash,
        promptKey: args.promptKey,
        status: "running",
      },
      orderBy: { updatedAt: "desc" },
    });
    return row ? withDocFields(row) : null;
  },

  "agentRun.recordStep": async (ctx, args) => {
    const db = await ensureDb();
    const user = await getAuthUser(db, ctx);
    const run = await db.agentRun.findUnique({ where: { id: args.runId } });
    if (!run || run.userId !== user.id) throw new Error("Run not found");
    const steps = Array.isArray(run.steps) ? [...run.steps] : [];
    steps.push(args.step);
    const row = await db.agentRun.update({
      where: { id: args.runId },
      data: clean({
        steps,
        stepIndex: args.step?.stepIndex != null ? args.step.stepIndex + 1 : run.stepIndex,
        updatedAt: new Date(),
      }),
    });
    return withDocFields(row);
  },

  "agentRun.finish": async (ctx, args) => {
    const db = await ensureDb();
    const user = await getAuthUser(db, ctx);
    const run = await db.agentRun.findUnique({ where: { id: args.runId } });
    if (!run || run.userId !== user.id) throw new Error("Run not found");
    const row = await db.agentRun.update({
      where: { id: args.runId },
      data: clean({
        status: args.status, // succeeded | failed | halted
        judgeScores: args.judgeScores,
        critic: args.critic,
        iteration: args.iteration,
        error: args.error,
        updatedAt: new Date(),
        finishedAt: new Date(),
      }),
    });
    return withDocFields(row);
  },
};

export const runNeonFunction = async (name, args = {}, ctx = {}) => {
  const fn = functions[name];
  if (!fn) throw new Error(`Unknown Neon function: ${name}`);
  return await fn(ctx, args || {});
};

export const runNeonQuery = runNeonFunction;
export const runNeonMutation = runNeonFunction;
