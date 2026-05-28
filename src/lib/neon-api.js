const ref = (name) => ({ _neonName: name });

export const getNeonFunctionName = (fn) => {
  if (typeof fn === "string") return fn;
  if (fn?._neonName) return fn._neonName;
  throw new Error("Unknown Neon function reference");
};

export const api = {
  users: {
    store: ref("users.store"),
    getCurrentUser: ref("users.getCurrentUser"),
    syncPlan: ref("users.syncPlan"),
  },
  projects: {
    create: ref("projects.create"),
    getUserProjects: ref("projects.getUserProjects"),
    deleteProject: ref("projects.deleteProject"),
    bulkDeleteProjects: ref("projects.bulkDeleteProjects"),
    getProject: ref("projects.getProject"),
    getProjectRevisions: ref("projects.getProjectRevisions"),
    createProjectRevision: ref("projects.createProjectRevision"),
    restoreProjectRevision: ref("projects.restoreProjectRevision"),
    updateProject: ref("projects.updateProject"),
  },
  agentEditSets: {
    listForProject: ref("agentEditSets.listForProject"),
    createOrUpdateDraft: ref("agentEditSets.createOrUpdateDraft"),
    getWithSnapshots: ref("agentEditSets.getWithSnapshots"),
    saveSnapshot: ref("agentEditSets.saveSnapshot"),
    markApplied: ref("agentEditSets.markApplied"),
    markPending: ref("agentEditSets.markPending"),
    markRemoved: ref("agentEditSets.markRemoved"),
  },
  editPlanCache: {
    getPlan: ref("editPlanCache.getPlan"),
    getPlanFuzzy: ref("editPlanCache.getPlanFuzzy"),
    savePlan: ref("editPlanCache.savePlan"),
  },
  canvasTargetCache: {
    getTargets: ref("canvasTargetCache.getTargets"),
    saveTargets: ref("canvasTargetCache.saveTargets"),
  },
};
