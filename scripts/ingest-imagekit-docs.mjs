import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const DOCS_ROOT = "https://imagekit.io/docs";
const OUTPUT = path.join(process.cwd(), "src/data/imagekit-docs.generated.json");
const LIMIT = Number(process.env.IMAGEKIT_DOCS_LIMIT || 220);

const decodeHtml = (value) =>
  String(value || "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

const stripHtml = (html) =>
  decodeHtml(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
      .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
      .replace(/<\/h[1-3]>/gi, "\n\n")
      .replace(/<\/p>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
  ).trim();

const titleFromHtml = (html, url) => {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return decodeHtml(match?.[1] || url)
    .replace(/\s*\|\s*ImageKit.*$/i, "")
    .trim();
};

const absoluteDocsUrl = (href) => {
  try {
    const url = new URL(href, DOCS_ROOT);
    url.hash = "";
    url.search = "";
    if (url.origin !== "https://imagekit.io") return null;
    if (!url.pathname.startsWith("/docs")) return null;
    return url.toString();
  } catch {
    return null;
  }
};

const discoverLinks = (html) => {
  const links = [];
  for (const match of html.matchAll(/href=["']([^"']+)["']/gi)) {
    const url = absoluteDocsUrl(match[1]);
    if (url) links.push(url);
  }
  return links;
};

const chunkText = ({ url, title, text }) => {
  const paragraphs = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const chunks = [];
  let buffer = "";
  let heading = title;

  for (const paragraph of paragraphs) {
    const isHeading = paragraph.length < 90 && !paragraph.endsWith(".") && /^[A-Z0-9]/.test(paragraph);
    if (isHeading) heading = paragraph;

    if ((buffer + "\n\n" + paragraph).length > 1800 && buffer.length > 300) {
      chunks.push({ url, title, heading, content: buffer.trim() });
      buffer = paragraph;
    } else {
      buffer = [buffer, paragraph].filter(Boolean).join("\n\n");
    }
  }

  if (buffer.trim()) chunks.push({ url, title, heading, content: buffer.trim() });

  return chunks.map((chunk) => ({
    ...chunk,
    keywords: [
      ...new Set(
        `${chunk.title} ${chunk.heading} ${chunk.content}`
          .toLowerCase()
          .match(/[a-z0-9:_-]{4,}/g) || []
      ),
    ].slice(0, 36),
    tokenSize: Math.ceil(chunk.content.length / 4),
  }));
};

const queue = [DOCS_ROOT];
const seen = new Set();
const chunks = [];
const pages = [];

while (queue.length && seen.size < LIMIT) {
  const next = queue.shift();
  if (!next || seen.has(next)) continue;
  seen.add(next);

  const response = await fetch(next);
  if (!response.ok) {
    console.warn(`skip ${next}: ${response.status}`);
    continue;
  }

  const html = await response.text();
  const title = titleFromHtml(html, next);
  const content = stripHtml(html);
  const contentHash = createHash("sha256").update(content).digest("hex");
  pages.push({ url: next, title, contentHash });
  chunks.push(...chunkText({ url: next, title, text: content }));

  for (const url of discoverLinks(html)) {
    if (!seen.has(url) && !queue.includes(url)) queue.push(url);
  }
}

await mkdir(path.dirname(OUTPUT), { recursive: true });
await writeFile(
  OUTPUT,
  JSON.stringify({ scrapedAt: new Date().toISOString(), pages, chunks }, null, 2)
);

console.log(`Wrote ${chunks.length} chunks from ${pages.length} pages to ${OUTPUT}`);
