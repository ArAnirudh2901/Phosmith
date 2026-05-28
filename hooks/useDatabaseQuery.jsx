"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import { isDatabaseSetupError } from "@/lib/database-errors"
import { getNeonFunctionName } from "@/lib/neon-api"

const QUERY_ENDPOINT = "/api/neon/query"
const MUTATION_ENDPOINT = "/api/neon/mutation"
const MUTATION_EVENT = "pixxel:neon-mutated"

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

    useEffect(() => {
        if (isSkipped || typeof window === "undefined") return undefined
        const onMutation = () => setRefreshToken((value) => value + 1)
        window.addEventListener(MUTATION_EVENT, onMutation)
        return () => window.removeEventListener(MUTATION_EVENT, onMutation)
    }, [isSkipped])

    useEffect(() => {
        let cancelled = false

        const runQuery = async () => {
            if (isSkipped) {
                setData(undefined)
                setError(null)
                setIsLoading(false)
                lastErrorMessageRef.current = null
                return
            }

            setIsLoading(true)
            setError(null)

            try {
                const response = await fetch(QUERY_ENDPOINT, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({
                        name: queryName,
                        args: JSON.parse(serializedQueryArgs),
                    }),
                })
                const body = await response.json().catch(() => ({}))
                if (!response.ok) {
                    throw createDatabaseRequestError(body, response.status, "Database query failed")
                }
                if (!cancelled) {
                    setData(body.data)
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

export const useDatabaseMutation = (mutation, ...args) => {
    const mutationName = useMemo(() => getNeonFunctionName(mutation), [mutation])

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
                window.dispatchEvent(new CustomEvent(MUTATION_EVENT, { detail: { name: mutationName } }))
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
    }, [mutationName])

    return { mutate, data, isLoading, error }
}
