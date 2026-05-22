import { imageKitDocsSeed } from "@/data/imagekit-docs-seed";

const GENERATED_DOCS_PATH = "src/data/imagekit-docs.generated.json";

const normalize = (value) =>
  String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9:_-]+/g, " ")
    .trim();

const tokenize = (value) =>
  normalize(value)
    .split(/\s+/)
    .filter((token) => token.length > 2);

const unique = (items) => [...new Set(items.filter(Boolean))];

export const getImageKitDocs = async () => {
  if (typeof window !== "undefined") return imageKitDocsSeed;

  try {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const filePath = path.join(process.cwd(), GENERATED_DOCS_PATH);
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed?.chunks) && parsed.chunks.length > 0) {
      return parsed.chunks;
    }
  } catch {
    // The generated crawl is optional; seed docs keep the agent useful.
  }

  return imageKitDocsSeed;
};

export const retrieveImageKitDocs = async ({ prompt, imageAnalysis, limit = 5 }) => {
  const docs = await getImageKitDocs();
  const imageTerms = [];

  if (imageAnalysis?.isDark) imageTerms.push("brightness", "contrast", "quality");
  if (imageAnalysis?.isLowContrast) imageTerms.push("contrast", "sharpen", "enhance");
  if (imageAnalysis?.isLowSaturation) imageTerms.push("color", "vibrance", "professional");
  if (imageAnalysis?.subjectHint) imageTerms.push(imageAnalysis.subjectHint);

  const queryTokens = unique([
    ...tokenize(prompt),
    ...imageTerms.flatMap(tokenize),
  ]);

  const scored = docs.map((doc) => {
    const haystack = normalize(
      [doc.title, doc.heading, doc.content, ...(doc.keywords || [])].join(" ")
    );
    const keywordSet = new Set((doc.keywords || []).map(normalize));

    const score = queryTokens.reduce((total, token) => {
      if (keywordSet.has(token)) return total + 6;
      if (haystack.includes(token)) return total + 2;
      if (token.includes("background") && haystack.includes("bgremove")) return total + 4;
      if (token.includes("upscale") && haystack.includes("upscale")) return total + 4;
      return total;
    }, 0);

    return { ...doc, score };
  });

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ score, ...doc }) => doc);
};
