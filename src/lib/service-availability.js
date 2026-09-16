import { NextResponse } from "next/server"

// A configured-but-unreachable service (process down, HF Space asleep, DNS gone)
// is an availability condition, not a server fault. Routes that let it fall
// through to a generic 500 break the client's sticky unavailability latch, which
// then retries on every interaction.
const OFFLINE_PATTERNS = /fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|EHOSTUNREACH|ENETUNREACH|socket hang up|other side closed/i

export const isServiceOffline = (error) =>
  OFFLINE_PATTERNS.test(error?.message || "") ||
  OFFLINE_PATTERNS.test(error?.cause?.message || "") ||
  OFFLINE_PATTERNS.test(error?.cause?.code || "")

export const serviceOfflineResponse = (serviceName, envVar) =>
  NextResponse.json(
    {
      error: `${serviceName} is not reachable — start it locally or set ${envVar} to a running instance`,
      unavailable: true,
    },
    { status: 503 },
  )
