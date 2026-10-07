import { renderFabricObjectElement } from "@/lib/canvas-snapshot";
import { extractImageFeatures } from "@/lib/image-features";
import { computeImageFingerprint, computeLayerThumbnail, computePerceptualHash } from "@/lib/image-fingerprint";

export const SAMPLE_SIZE = 48;

export const getSourceUrl = (image, project) =>
  image?.getSrc?.() ||
  image?._originalElement?.src ||
  image?._element?.src ||
  project?.currentImageUrl ||
  project?.originalImageUrl ||
  "";

export const isVisibleImageOnCanvas = (obj) =>
  obj && obj.type?.toLowerCase?.() === "image" && obj.visible !== false;

// Collect every visible image on the canvas as a layer payload for the
// multi-image targeting endpoint. Each entry carries enough data for the
// server to: (a) ask Gemini which layers the user is talking about
// (thumbnail + name) and (b) compute a per-image plan (sourceUrl + hash).
// Mirror the server's MAX_LAYERS cap (in the edit-plan route) so the client
// never renders/encodes more layers than the server will accept — otherwise a
// canvas with many images would do N wasted renders + base64 encodes before the
// server truncates to 12.
export const MAX_AGENT_LAYERS = 12;

// Mirror the server's MAX_RENDERED_BASE64_CHARS bound so we never POST a render
// the server would just discard.
export const MAX_AGENT_RENDER_CHARS = 3 * 1024 * 1024;

export const collectLayersForTargeting = (canvasEditor, project) => {
  const objects = canvasEditor?.getObjects?.() || [];
  const visibleImages = objects.filter(isVisibleImageOnCanvas).slice(0, MAX_AGENT_LAYERS);
  const isMultiLayer = visibleImages.length >= 2;
  return visibleImages.map((img, idx) => {
    // Render THIS layer WITH its current filters/masks applied so the agent's
    // context (hash / perceptual hash / features / thumbnail / grading bytes)
    // reflects manual edits rather than the immutable original bitmap. Only
    // worth doing in the multi-layer case — the single-image path flattens the
    // whole canvas itself. Falls back to the raw FabricImage if the per-object
    // render fails (e.g. a tainted or WebGL-filtered layer).
    const renderedEl = isMultiLayer ? renderFabricObjectElement(img, { maxEdge: 1024 }) : null;
    const analysisSource = renderedEl || img;
    let renderedBase64 = null;
    let renderedMime = null;
    if (renderedEl) {
      try {
        const durl = renderedEl.toDataURL("image/jpeg", 0.85);
        const commaIdx = durl.indexOf(",");
        if (commaIdx >= 0) {
          renderedBase64 = durl.slice(commaIdx + 1);
          renderedMime = "image/jpeg";
        }
      } catch {
        /* tainted layer — leave null; server falls back to the layer's sourceUrl */
      }
    }
    const fingerprint = computeImageFingerprint(analysisSource);
    const pHash = computePerceptualHash(analysisSource);
    const thumb = computeLayerThumbnail(analysisSource, 256);
    const layerName =
      (typeof img.phosmithLayerName === "string" && img.phosmithLayerName.trim()) ||
      (typeof img.name === "string" && img.name.trim()) ||
      `Image ${idx + 1}`;
    return {
      index: idx,
      name: layerName,
      sourceUrl: getSourceUrl(img, project),
      imageHash: fingerprint?.hash || `nohash-${idx}`,
      pHash: pHash || null,
      features: extractImageFeatures(analysisSource),
      thumbBase64: thumb?.base64 || null,
      thumbMime: thumb?.mime || null,
      // Flattened render of this layer (reflects manual edits) for grading.
      renderedBase64,
      renderedMime,
      // Reference to the canvas object so we can apply per-layer filters later.
      __canvasObject: img,
    };
  });
};

export const getImageElement = (image) =>
  image?._element || image?._originalElement || image?.getElement?.() || null;

export const analyzeActiveImage = (image, project) => {
  const element = getImageElement(image);
  const width = image?.width || element?.naturalWidth || project?.width || 0;
  const height = image?.height || element?.naturalHeight || project?.height || 0;
  const fallback = {
    width,
    height,
    aspectRatio: height ? width / height : 1,
    averageLuminance: 0.5,
    contrast: 0.35,
    saturation: 0.35,
    warmth: 0,
    isDark: false,
    isLowContrast: false,
    isLowSaturation: false,
    isSoft: false,
  };

  if (!element) return fallback;

  try {
    const canvas = document.createElement("canvas");
    canvas.width = SAMPLE_SIZE;
    canvas.height = SAMPLE_SIZE;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(element, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
    const { data } = ctx.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE);

    let luminance = 0;
    let saturation = 0;
    let warmth = 0;
    const lumas = [];

    for (let i = 0; i < data.length; i += 4) {
      const r = data[i] / 255;
      const g = data[i + 1] / 255;
      const b = data[i + 2] / 255;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      lumas.push(luma);
      luminance += luma;
      saturation += max === 0 ? 0 : (max - min) / max;
      warmth += r - b;
    }

    const pixels = data.length / 4;
    const averageLuminance = luminance / pixels;
    const averageSaturation = saturation / pixels;
    const averageWarmth = warmth / pixels;
    const variance = lumas.reduce((sum, luma) => sum + (luma - averageLuminance) ** 2, 0) / lumas.length;
    const contrast = Math.sqrt(variance);

    return {
      ...fallback,
      averageLuminance: Number(averageLuminance.toFixed(3)),
      contrast: Number(contrast.toFixed(3)),
      saturation: Number(averageSaturation.toFixed(3)),
      warmth: Number(averageWarmth.toFixed(3)),
      isDark: averageLuminance < 0.38,
      isLowContrast: contrast < 0.19,
      isLowSaturation: averageSaturation < 0.24,
      isWarm: averageWarmth > 0.08,
      isCool: averageWarmth < -0.08,
      isSoft: contrast < 0.22,
    };
  } catch (error) {
    console.warn("[ImageKit Agent] visual analysis failed:", error);
    return fallback;
  }
};
