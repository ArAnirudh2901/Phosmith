export const imageKitDocsSeed = [
  {
    url: "https://imagekit.io/docs/overview",
    title: "ImageKit docs overview",
    heading: "ImageKit delivery and transformations",
    content:
      "ImageKit is an image and video optimization, transformation, and digital asset platform. Image transformation URLs use a query parameter named tr. Multiple transformations can be composed into one chain, such as width, height, crop mode, focus, quality, format, effects, overlays, and AI transformations. Pixel-GPT should prefer generated ImageKit URLs when the source image is hosted on an ik.imagekit.io endpoint.",
    keywords: ["overview", "delivery", "transformation", "url", "tr", "imagekit"],
  },
  {
    url: "https://imagekit.io/docs/image-transformations",
    title: "Image transformations",
    heading: "Resize, crop, focus, and output quality",
    content:
      "ImageKit transformations are composed as comma-separated tokens in the tr parameter. Width and height use w-N and h-N. Crop and resize behavior can be controlled with crop modes. Focus can guide crops toward faces, center, top, bottom, left, right, or object-aware areas. Format and quality transformations such as f-auto and q-auto are useful final delivery optimizations.",
    keywords: ["resize", "crop", "focus", "quality", "format", "w", "h", "f-auto", "q-auto"],
  },
  {
    url: "https://imagekit.io/docs/ai-transformations",
    title: "AI transformations",
    heading: "Background removal, generative fill, retouch, and upscale",
    content:
      "ImageKit AI transformations include background removal, generative fill, image variation, retouching, and upscaling. Background removal can be used for ecommerce cutouts and transparent assets. Generative fill can extend or fill empty regions when paired with explicit width, height, and pad resize or extract behavior. Retouching and upscaling are useful for improving portraits, product photos, and low-resolution images.",
    keywords: ["ai", "bgremove", "background", "genfill", "retouch", "upscale", "e-bgremove", "bg-genfill"],
  },
  {
    url: "https://imagekit.io/docs/effects-and-enhancements",
    title: "Effects and enhancements",
    heading: "Professional enhancement effects",
    content:
      "Useful enhancement effects include contrast, sharpening, unsharp mask, blur, grayscale, drop shadow, and progressive enhancement chains. Retouching can be paired with contrast and sharpening for professional but natural-looking results. For product photography, remove background before adding shadow. For portraits, keep transformations restrained and pair server-side retouching with local color grading.",
    keywords: ["effects", "enhance", "contrast", "sharpen", "usm", "blur", "shadow", "retouch"],
  },
  {
    url: "https://imagekit.io/docs/add-overlays-on-images",
    title: "Image overlays",
    heading: "Text, image, and brand overlays",
    content:
      "ImageKit supports image and text overlays for watermarks, labels, captions, badges, and product information. Overlays are best treated as a separate design layer in an editor when precise interactive placement matters. URL overlays are useful for repeatable batch generation and templated assets.",
    keywords: ["overlay", "text", "watermark", "caption", "badge", "template"],
  },
  {
    url: "https://imagekit.io/docs/media-library",
    title: "Media library",
    heading: "Asset management and file URLs",
    content:
      "ImageKit's media library stores uploaded files and returns stable asset URLs, dimensions, file IDs, and metadata. For an editing workflow, keep the original asset URL, the current transformed URL, and the active transformation chain separately so the user can revert, compare, or build another edit from the source.",
    keywords: ["media", "upload", "fileId", "metadata", "asset", "library"],
  },
  {
    url: "https://imagekit.io/docs/performance",
    title: "Performance",
    heading: "Optimize transformed delivery",
    content:
      "For production delivery, combine creative transformations with delivery optimizations. Prefer automatic format and quality where possible, use dimensions appropriate for the canvas or export target, and avoid repeated destructive transformations when the same source URL can be transformed lazily.",
    keywords: ["performance", "optimize", "delivery", "quality", "format", "cache"],
  },
];
