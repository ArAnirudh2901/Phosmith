export const QUICK_PROMPTS = [
  { label: "Editorial", prompt: "Give it a premium editorial polish", hint: "Retouch, contrast, detail" },
  { label: "Cinematic", prompt: "Give it a cinematic color grade with crisp depth", hint: "Tone, drama, focus" },
  { label: "Studio", prompt: "Polish this for ecommerce with crisp studio detail", hint: "Clean product finish" },
  { label: "Extend", prompt: "Extend all sides by 20%", hint: "AI outpaint edges" },
  { label: "Collage", prompt: "Make a rounded collage of these photos with a soft drop shadow", hint: "Arrange photos in a template" },
];

// Collage intent → routed to the `collage.*` agent commands instead of the
// edit-plan flow. Matches explicit collage words, or a layout/grid/template
// request that mentions the photos.
export const COLLAGE_INTENT_RE =
  /\b(collage|montage|scrapbook|mosaic|photo[\s-]?grid)\b|\b(grid|template|layout|arrange)\b[^.]*\b(photo|photos|pic|pics|picture|pictures|image|images)\b|\b(photo|photos|pic|pics|picture|pictures|image|images)\b[^.]*\b(grid|template|collage)\b/i;

export const isCollageIntent = (prompt) => COLLAGE_INTENT_RE.test(String(prompt || ""));

// Turn a focus.fromDescription result into a friendly assistant message.
export const summarizeStretchResult = (result) => {
  if (result?.cleared !== undefined) return `Removed ${result.cleared} stretch layer${result.cleared === 1 ? "" : "s"}.`;
  if (result?.applied === "scanline") {
    return `Done — smeared each ${result.axis === "vertical" ? "column" : "row"} from its ${result.mode === "light" ? "darkest" : "brightest"} surviving pixel.`;
  }
  if (result?.applied === "auto") return `Done — ${result.reasoning || "placed the stretch myself"}.`;
  if (result?.applied === "warp") return `Done — ribbon bent through the ${result.preset} warp, pulled from the ${result.from}.`;
  if (result?.applied === "flow") return `Done — ribbon routed along a ${result.anchors}-point ${result.preset} path.`;
  if (result?.applied === "ribbon") return `Done — ribbon pulled from the ${result.from}, running ${result.axis === "vertical" ? "up/down" : "across"}.`;
  return "Done.";
};

export const summarizeFocusResult = (result) => {
  const parsed = result?.parsed || {};
  const what = parsed.why || "applied the effect";
  if (result?.applied === "depthOfField") {
    const how = result.source === "depth" ? "depth from the masking service"
      : result.source === "matte" ? "the subject detected on your device"
        : result.source === "defocus" ? "the photo's own focus falloff"
          : "a centred focus band (no depth evidence in this frame)";
    return `Done — ${what}, using ${how}.`;
  }
  if (result?.applied === "colorPop") {
    const pct = Math.round((result.keptFraction || 0) * 100);
    return `Done — ${what}. ${pct}% of the frame kept its colour.`;
  }
  if (result?.applied === "castShadow") {
    return `Done — ${what}.`;
  }
  if (result?.cleared) return "Cleared the focus effects.";
  return `Done — ${what}.`;
};

// Turn a collage.fromDescription result into a friendly assistant message.
export const summarizeCollageResult = (r) => {
  if (!r) return "Built the collage.";
  const layoutLabel = String(r.layout || "collage").replace(/-/g, " ");
  const parts = [`Built a ${layoutLabel} collage with ${r.placed} photo${r.placed === 1 ? "" : "s"}.`];
  if (r.style?.shape === "circle") parts.push("Circular frames.");
  else if (r.style?.radiusPct) parts.push("Rounded corners.");
  if (r.style?.shadow) parts.push("Drop shadow on.");
  if (r.generatedBackground?.applied) {
    parts.push(`Generated a ${r.generatedBackground.theme || "decorative"} background that fits the photos.`);
  } else if (r.generatedBackground && r.generatedBackground.applied === false) {
    parts.push("(Couldn't generate the themed background — kept the plain backdrop.)");
  } else if (r.background && r.background.type && r.background.type !== "none") {
    parts.push("Applied a background.");
  }
  if (r.extras) parts.push(`${r.extras} extra photo${r.extras === 1 ? "" : "s"} left for you to place.`);
  return parts.join(" ");
};
