import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { isImageKitUrl } from "@/lib/imagekit-ai";

export const runtime = "nodejs";
export const maxDuration = 60;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const json = (body, status = 200) =>
  NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });

const readBodySnippet = async (response) => {
  try {
    return (await response.clone().text()).slice(0, 400).trim();
  } catch {
    return "";
  }
};

const getHeaderSnapshot = (response) => ({
  status: response.status,
  ok: response.ok,
  contentType: response.headers.get("content-type") || "",
  contentLength: response.headers.get("content-length") || "",
  isIntermediate: response.headers.get("is-intermediate-response") === "true",
  ikError: response.headers.get("ik-error") || "",
  cacheControl: response.headers.get("cache-control") || "",
});

export async function POST(request) {
  const { userId } = await auth();
  if (!userId) return json({ error: "Unauthorized" }, 401);

  const body = await request.json().catch(() => null);
  if (!body) return json({ error: "Invalid JSON body" }, 400);

  const url = String(body.url || "").trim();
  const source = String(body.source || "unknown").slice(0, 80);
  const preset = String(body.preset || "").slice(0, 80);
  const maxAttempts = Math.max(1, Math.min(Number(body.maxAttempts) || 12, 20));
  const retryDelayMs = Math.max(1000, Math.min(Number(body.retryDelayMs) || 5000, 30000));
  const minBytes = Math.max(0, Number(body.minBytes) || 2048);
  const startedAt = Date.now();

  if (!url || !url.startsWith("http")) return json({ error: "url is required" }, 400);
  if (!isImageKitUrl(url)) return json({ error: "Only ImageKit URLs can be resolved" }, 400);

  console.log("[ImageKit Resolve] start", {
    source,
    preset,
    maxAttempts,
    retryDelayMs,
    minBytes,
    url,
  });

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        cache: "no-store",
        headers: {
          Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
          "User-Agent": "Pixxel ImageKit resolver",
        },
      });
      const headers = getHeaderSnapshot(response);
      const length = Number(headers.contentLength || 0);
      const bodySnippet =
        !response.ok || headers.isIntermediate || !headers.contentType.startsWith("image/")
          ? await readBodySnippet(response)
          : "";

      console.log("[ImageKit Resolve] attempt", {
        source,
        preset,
        attempt,
        maxAttempts,
        elapsedMs: Date.now() - startedAt,
        ...headers,
        bodySnippet,
        url,
      });

      if (
        response.ok &&
        headers.contentType.startsWith("image/") &&
        !headers.isIntermediate &&
        (length === 0 || length >= minBytes)
      ) {
        console.log("[ImageKit Resolve] ready", {
          source,
          preset,
          attempt,
          elapsedMs: Date.now() - startedAt,
          url,
        });
        return json({
          success: true,
          url,
          attempts: attempt,
          elapsedMs: Date.now() - startedAt,
          headers,
        });
      }

      if (!response.ok && response.status >= 400 && !headers.isIntermediate) {
        const detail = [headers.ikError, bodySnippet].filter(Boolean).join(": ");
        console.warn("[ImageKit Resolve] rejected", {
          source,
          preset,
          attempt,
          status: response.status,
          detail,
          url,
        });

        return json(
          {
            success: false,
            error: `ImageKit rejected the transform URL (${response.status})${detail ? `: ${detail}` : ""}`,
            status: response.status,
            headers,
            bodySnippet,
          },
          response.status
        );
      }
    } catch (error) {
      console.warn("[ImageKit Resolve] request failed", {
        source,
        preset,
        attempt,
        maxAttempts,
        message: error?.message || String(error),
        url,
      });
    }

    if (attempt < maxAttempts) {
      await sleep(retryDelayMs);
    }
  }

  console.warn("[ImageKit Resolve] timed out", {
    source,
    preset,
    attempts: maxAttempts,
    elapsedMs: Date.now() - startedAt,
    url,
  });

  return json(
    {
      success: false,
      error: "ImageKit is still preparing this AI transform. Try again in a few seconds.",
      attempts: maxAttempts,
      elapsedMs: Date.now() - startedAt,
    },
    504
  );
}
