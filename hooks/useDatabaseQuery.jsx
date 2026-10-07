"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import { isDatabaseSetupError } from "@/lib/database-errors"
import { getNeonFunctionName } from "@/lib/neon-api"

const QUERY_ENDPOINT = "/api/neon/query"
const MUTATION_ENDPOINT = "/api/neon/mutation"
const MUTATION_EVENT = "phosmith:neon-mutated"

// One network request per identical query while it is in flight. usePlanAccess is
// mounted by three editor components, so users.getCurrentUser went to the server
// three times on every editor load. The entry is dropped when the request settles,
// so a refetch after a mutation still hits the network.
const inflight = new Map()

function runQueryRequest(payload) {
    const shared = inflight.get(payload)
    if (shared) return shared

    // The root layout's inline script starts this on a hard load, and
    // lib/query-preload.js on a press that navigates here. Adopt it once, then fall
    // back to the network — a refetch after a mutation must not replay a preload.
    const preloaded = typeof window !== "undefined" ? window.__phosmithPreload?.[payload] : null
    if (preloaded) delete window.__phosmithPreload[payload]

    const promise = Promise.resolve(preloaded)
        // Only a success is worth adopting: a 401 parked by a signed-out press would
        // otherwise be served to the dashboard that loads after sign-in.
        .then((result) => (result?.ok === true ? result : null))
        .catch(() => null)
        .then((adopted) => adopted || fetch(QUERY_ENDPOINT, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: payload,
        }).then(async (response) => ({
            ok: response.ok,
            status: response.status,
            body: await response.json().catch(() => ({})),
        })))
        .finally(() => inflight.delete(payload))

    inflight.set(payload, promise)
    return promise
}

const createDatabaseRequestError = (body, status, fallbackMessage) => {
    const error = new Error(body.error || fallbackMessage)
    error.status = status
    error.code = body.code
    error.setupRequired = Boolean(body.setupRequired)
    return error
}

export const useDatabaseQuery = (query, ...args) => {
    const isSkipped = args[0] === "skip"
    const queryArgs = isSkipped ? {} : (args[0] ?? {})
    const queryName = isSkipped ? null : getNeonFunctionName(query)
    const serializedQueryArgs = JSON.stringify(queryArgs)
    const lastErrorMessageRef = useRef(null)
    const [refreshToken, setRefreshToken] = useState(0)
    const [data, setData] = useState(undefined)
    const [isLoading, setIsLoading] = useState(!isSkipped)
    const [error, setError] = useState(null)
    // Track whether we've ever successfully fetched data so we can distinguish
    // "no data yet" (show skeleton) from "genuinely empty" (show empty state).
    const hasFetchedRef = useRef(false)
    const prevSkippedRef = useRef(isSkipped)

    // When transitioning from skipped → active (e.g. auth completes),
    // synchronously set isLoading = true so the very next render shows
    // skeletons instead of a flash of the empty state.
    if (prevSkippedRef.current && !isSkipped) {
        prevSkippedRef.current = false
        if (!isLoading) setIsLoading(true)
    }
    if (!prevSkippedRef.current && isSkipped) {
        prevSkippedRef.current = true
    }

    useEffect(() => {
        if (isSkipped || typeof window === "undefined") return undefined
        const onMutation = (event) => {
            // A mutation may declare what it invalidates. When it does, a query
            // it did not name has no reason to re-run — the default (undefined)
            // stays a broadcast so existing call sites are unchanged.
            const scope = event?.detail?.invalidates
            if (Array.isArray(scope) && !scope.includes(queryName)) return
            setRefreshToken((value) => value + 1)
        }
        window.addEventListener(MUTATION_EVENT, onMutation)
        return () => window.removeEventListener(MUTATION_EVENT, onMutation)
    }, [isSkipped, queryName])

    useEffect(() => {
        let cancelled = false

        const runQuery = async () => {
            if (isSkipped) {
                // Don't clear data when skipping — preserves stale data during
                // brief auth re-checks so the UI doesn't flash empty.
                setError(null)
                setIsLoading(false)
                lastErrorMessageRef.current = null
                return
            }

            setIsLoading(true)
            setError(null)

            try {
                const payload = JSON.stringify({
                    name: queryName,
                    args: JSON.parse(serializedQueryArgs),
                })

                const { ok, status, body } = await runQueryRequest(payload)
                if (!ok) {
                    throw createDatabaseRequestError(body || {}, status, "Database query failed")
                }
                if (!cancelled) {
                    setData(body?.data)
                    hasFetchedRef.current = true
                    lastErrorMessageRef.current = null
                }
            } catch (err) {
                if (!cancelled) {
                    setError(err)
                    // A read may start from the session cookie before Clerk has
                    // resolved. If that session is stale the server answers 401 and
                    // the auth layer redirects — a toast there tells nobody anything.
                    if (err.status === 401) {
                        console.warn("Unauthorized database read.", err.message)
                    } else if (!isDatabaseSetupError(err) && lastErrorMessageRef.current !== err.message) {
                        toast.error(err.message)
                        lastErrorMessageRef.current = err.message
                    }
                }
            } finally {
                if (!cancelled) setIsLoading(false)
            }
        }

        runQuery()
        return () => {
            cancelled = true
        }
    }, [isSkipped, queryName, refreshToken, serializedQueryArgs])

    const refetch = useCallback(() => setRefreshToken((value) => value + 1), [])

    return { data, isLoading, error, refetch }
}

/**
 * @param {object} [options]
 * @param {string[]} [options.invalidates]  Query names this mutation makes
 *   stale. Omit for the old behaviour (every query refetches). An empty array
 *   means "this changed nothing anyone is showing" — `users.store` is exactly
 *   that, and broadcasting from it made every page load refetch every query,
 *   including the project row (990 bytes to 5.7 MB across this account).
 */
export const useDatabaseMutation = (mutation, options = {}) => {
    const mutationName = useMemo(() => getNeonFunctionName(mutation), [mutation])
    const invalidates = options.invalidates

    const [data, setData] = useState(undefined)
    const [isLoading, setIsLoading] = useState(false)
    const [error, setError] = useState(null)

    const mutate = useCallback(async (...args) => {
        setIsLoading(true)
        setError(null)

        try {
            const response = await fetch(MUTATION_ENDPOINT, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    name: mutationName,
                    args: args[0] ?? {},
                }),
            })
            const body = await response.json().catch(() => ({}))
            if (!response.ok) {
                throw createDatabaseRequestError(body, response.status, "Database mutation failed")
            }
            setData(body.data)
            // A refetch must not join a read that left before this write landed.
            for (const key of inflight.keys()) {
                if (!Array.isArray(invalidates) || invalidates.includes(JSON.parse(key).name)) inflight.delete(key)
            }
            if (typeof window !== "undefined") {
                window.dispatchEvent(new CustomEvent(MUTATION_EVENT, { detail: { name: mutationName, invalidates } }))
            }
            return body.data
        } catch (err) {
            setError(err)
            if (!isDatabaseSetupError(err)) {
                toast.error(err.message)
            }
            throw err // Re-throw so callers know the mutation failed
        } finally {
            setIsLoading(false)
        }
    }, [mutationName, invalidates])

    return { mutate, data, isLoading, error }
}
