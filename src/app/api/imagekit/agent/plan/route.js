import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import {
  buildLocalVisualPlan,
  callOllamaVisionPlanner,
  getImageKitAgentSourceUrl,
} from "@/lib/imagekit-agent";
import { buildImageKitAiTransformUrl, isImageKitUrl } from "@/lib/imagekit-ai";
import { getPrisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_IMAGE_BYTES = 7 * 1024 * 1024;

const json = (body, status = 200) =>
  NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });

const parseJson = async (request) => {
  try {
    return await request.json();
  } catch {
    return null;
  }
};

const fetchImageBase64 = async (url) => {
  if (!url?.startsWith("http")) return null;

  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) return null;

  const contentType = response.headers.get("content-type") || "";
  const length = Number(response.headers.get("content-length") || 0);
  if (!contentType.startsWith("image/")) return null;
  if (length > MAX_IMAGE_BYTES) return null;

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_IMAGE_BYTES) return null;

  return buffer.toString("base64");
};

const sanitizeAdjustments = (adjustments = {}) => {
  const numberKeys = [
    "brightness",
    "contrast",
    "gamma",
    "temperature",
    "saturation",
    "vibrance",
    "hue",
    "sharpness",
    "blur",
    "noise",
    "pixelate",
  ];

  return numberKeys.reduce((acc, key) => {
    const value = Number(adjustments[key]);
    if (Number.isFinite(value)) acc[key] = value;
    return acc;
  }, {});
};

const shouldUseOllamaVision = () =>
  process.env.IMAGEKIT_AGENT_DISABLE_OLLAMA !== "true" &&
  (process.env.IMAGEKIT_AGENT_USE_OLLAMA === "true" || Boolean(process.env.OLLAMA_BASE_URL));

export async function POST(request) {
  const { userId } = await auth();
  if (!userId) return json({ error: "Unauthorized" }, 401);

  const body = await parseJson(request);
  if (!body) return json({ error: "Invalid JSON body" }, 400);

  const prompt = String(body.prompt || "").trim();
  const conversation = Array.isArray(body.messages)
    ? body.messages
        .slice(-8)
        .filter((message) => message && typeof message.content === "string")
        .map((message) => `${message.role === "assistant" ? "Agent" : "User"}: ${message.content.slice(0, 500)}`)
        .join("\n")
    : "";
  const planningPrompt = conversation
    ? `${conversation}\n\nLatest user request: ${prompt}`
    : prompt;
  const sourceUrl = getImageKitAgentSourceUrl(body.sourceUrl || "");

  if (prompt.length < 3) return json({ error: "Prompt must be at least 3 characters" }, 400);
  if (!sourceUrl) return json({ error: "sourceUrl is required" }, 400);
  if (!isImageKitUrl(sourceUrl)) {
    return json({ error: "ImageKit Agent needs an ImageKit-hosted image URL." }, 400);
  }

  const imageAnalysis = body.imageAnalysis || {};
  const project = body.project || {};
  const projectId = typeof body.projectId === "string" ? body.projectId : undefined;

  const fallbackPlan = await buildLocalVisualPlan({
    prompt: planningPrompt,
    sourceUrl,
    imageAnalysis,
    project,
  });

  let plan = fallbackPlan;
  let imageBase64 = null;

  if (shouldUseOllamaVision()) {
    try {
      imageBase64 = await fetchImageBase64(sourceUrl);
      plan = await callOllamaVisionPlanner({
        prompt: planningPrompt,
        imageBase64,
        imageAnalysis,
        docs: fallbackPlan.docs,
        fallbackPlan,
      });
    } catch (error) {
      console.info("[ImageKit Agent] Ollama vision unavailable; local planner handled the request.");
    }
  }

  const imageKitTransforms = Array.isArray(plan.imageKitTransforms)
    ? plan.imageKitTransforms.filter((item) => typeof item === "string")
    : fallbackPlan.imageKitTransforms;

  const outputUrl = imageKitTransforms.length
    ? buildImageKitAiTransformUrl(sourceUrl, imageKitTransforms, {
        preserveExistingTransforms: true,
        existingPosition: "before",
      })
    : sourceUrl;

  const responsePlan = {
    ...plan,
    sourceUrl,
    url: outputUrl,
    imageKitTransforms,
    fabricAdjustments: sanitizeAdjustments(plan.fabricAdjustments),
    docs: plan.docs || fallbackPlan.docs,
    vision: {
      imageAttachedToModel: Boolean(imageBase64 && plan.mode === "ollama-vision-rag"),
      provider: plan.mode === "ollama-vision-rag" ? "Ollama local vision" : "Local visual metrics",
    },
  };

  try {
    const prisma = await getPrisma();
    await prisma?.imageKitAgentRun.create({
      data: {
        userId,
        projectId,
        prompt,
        sourceUrl,
        outputUrl,
        mode: responsePlan.mode,
        model: responsePlan.model,
        imageAnalysis,
        retrievedDocs: responsePlan.docs,
        transformations: imageKitTransforms,
        fabricAdjustments: responsePlan.fabricAdjustments,
      },
    });
  } catch (error) {
    console.warn("[ImageKit Agent] Prisma log skipped:", error?.message);
  }

  return json({ success: true, plan: responsePlan });
}
