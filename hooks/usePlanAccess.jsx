import { useAuth } from '@clerk/nextjs'

const usePlanAccess = () => {

    const { has } = useAuth()

    const isPro = has?.({ plan: "pro" }) || false
    const isFree = !isPro

    const planAccess = {
        // Free Plan tools list
        resize: true,
        crop: true,
        adjust: true,

        // Pro only tools
        text: isPro,
        draw: isPro,
        images: isPro,
        ai_background: isPro,
        ai_extender: isPro,
        ai_edit: isPro,
        ai_agent: true,
    }

    // Helper function to check if the user has the access to a particular tool
    const hasAccess = (toolId) => {
        return planAccess[toolId] === true
    }

    const getRestrictedTools = () => {
        return Object.entries(planAccess)
            .filter(([_, hasAccess]) => !hasAccess)
            .map(([toolId]) => toolId)
    }

    const canCreateProject = (currentProjectCount) => {
        if (isPro) return true;

        return currentProjectCount < 3
    }

    const canExport = (currentExportsThisMonth) => {
        if (isPro) return true;

        return currentExportsThisMonth < 20;
    }

    return {
          userPlan: isPro ? "pro" : "free",
        isPro,
        isFree,
        hasAccess,
        planAccess,
        getRestrictedTools,
        canCreateProject,
        canExport,
    }
}

export default usePlanAccess
