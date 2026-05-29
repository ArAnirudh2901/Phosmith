import { useAuth } from '@clerk/nextjs'
import { useSubscription } from '@clerk/nextjs/experimental'
import { api } from '@/lib/neon-api'
import { useDatabaseQuery } from './useDatabaseQuery'

const PRO_PLAN_SLUG = "pro"

const hasActiveProSubscription = (subscription) => {
    if (!subscription?.subscriptionItems?.length) return false
    return subscription.subscriptionItems.some((item) => {
        const status = String(item?.status || "").toLowerCase()
        const slug = String(item?.plan?.slug || "").toLowerCase()
        const hasBaseFee = Boolean(item?.plan?.hasBaseFee)
        return status === "active" && (slug === PRO_PLAN_SLUG || hasBaseFee)
    })
}

const usePlanAccess = () => {

    const { isLoaded, isSignedIn, has } = useAuth()
    const { data: subscription } = useSubscription({
        enabled: Boolean(isLoaded && isSignedIn),
        keepPreviousData: true,
    })
    const { data: currentUser } = useDatabaseQuery(
        api.users.getCurrentUser,
        isLoaded && isSignedIn ? {} : "skip"
    )

    const isPro =
        has?.({ plan: PRO_PLAN_SLUG }) ||
        currentUser?.plan === PRO_PLAN_SLUG ||
        hasActiveProSubscription(subscription)
    const isFree = !isPro

    const planAccess = {
        // Free Plan tools list
        resize: true,
        crop: true,
        adjust: true,
        mask: true,
        erase: true,

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
