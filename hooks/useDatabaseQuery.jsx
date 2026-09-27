"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import { isDatabaseSetupError } from "@/lib/database-errors"
import { getNeonFunctionName } from "@/lib/neon-api"

const QUERY_ENDPOINT = "/api/neon/query"
const MUTATION_ENDPOINT = "/api/neon/mutation"
const MUTATION_EVENT = "phosmith:neon-mutated"

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

                // A server-rendered script may already have this request in
                // flight (see the editor layout). Adopt it once, then fall back
                // to fetching normally — refreshes after a mutation must always
                // hit the network rather than replay a stale preload.
                let result = null
                const preloaded = typeof window !== "undefined" ? window.__phosmithPreload?.[payload] : null
                if (preloaded) {
                    delete window.__phosmithPreload[payload]
                    result = await preloaded.catch(() => null)
                }

                let response
                let body
                if (result && typeof result.ok === "boolean") {
                    response = { ok: result.ok, status: result.status }
                    body = result.body || {}
                } else {
                    response = await fetch(QUERY_ENDPOINT, {
                        method: "POST",
                        headers: { "content-type": "application/json" },
                        body: payload,
                    })
                    body = await response.json().catch(() => ({}))
                }
                if (!response.ok) {
                    throw createDatabaseRequestError(body, response.status, "Database query failed")
                }
                if (!cancelled) {
                    setData(body.data)
                    hasFetchedRef.current = true
                    lastErrorMessageRef.current = null
                }
            } catch (err) {
                if (!cancelled) {
                    setError(err)
                    if (!isDatabaseSetupError(err) && lastErrorMessageRef.current !== err.message) {
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

    return { data, isLoading, error }
}

/**
 * @param {object} [options]
 * @param {string[]} [options.invalidates]  Query names this mutation makes
 *   stale. Omit for the old behaviour (every query refetches). An empty array
 *   means "this changed nothing anyone is showing" — `users.store` is exactly
 *   that, and broadcasting from it made every page load refetch every query,
 *   including the ~840 KB project row.
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
