# Graph Report - phosmith  (2026-09-16)

## Corpus Check
- Large corpus: 275 files · ~1,141,304 words. Semantic extraction will be expensive (many Claude tokens). Consider running on a subfolder.

## Summary
- 2729 nodes · 5976 edges · 201 communities (155 shown, 46 thin omitted)
- Extraction: 97% EXTRACTED · 3% INFERRED · 0% AMBIGUOUS · INFERRED: 162 edges (avg confidence: 0.86)
- Token cost: 359,499 input · 0 output

## Community Hubs (Navigation)
- Pixel Stretch Engine
- Collage Planner And Layouts
- Brush Mask And Inpaint Hooks
- AI Extend Pipeline
- In-Browser AI Engines
- Mask And Erase Tool Panels
- Python Mask Lab Prototype
- Dashboard And Shortcuts
- NL Mask Planning
- Mask Layer State
- App UI Screenshots
- Agent Chat Panel
- Package Scripts
- Agent Command Registry
- Layer Grade Editor
- New Project Modal
- Clerk Scaffold Manifest
- Canvas Shim For Tests
- Megashader Filter Binding
- AI Routing And NL Mask Executor
- Adjust Tool Panel
- Canvas Context And Shortcuts
- Database Query Hooks
- Gemini Edit Planner Route
- Megashader Renderer
- Mask Service Client
- Curves Filter LUT
- ImageKit AI URL Builders
- GLSL Mask Kind Builders
- Neon Data Functions
- Component Config
- Change Journal Verification
- Masking Service SAM Endpoints
- Canvas Image Management
- Landing Page Screenshots
- Canvas Sync API Routes
- Landing Feature Sections
- Mask Agent Commands
- Edit Planner And Style Profiles
- Editor Topbar And Export
- Edge Snap Verification
- Masking Service Depth And Ground
- ImageKit Agent Plan Route
- Change History Panel
- Segment Service Matting
- Segment Service Model Loading
- Gemini Edit Judge Route
- Canvas Editor Core
- AI Background Tool
- RAW Preview Extraction
- Masking Service Matting
- Segment Service Endpoints
- AI Extend API Route
- Env Logging And Error Boundaries
- Text Tool And Sidebar
- Brand Logo System
- Path Raster And Mask Harness
- Landing Hero And Chrome
- Redis And Server Cache
- Mask Lab Matting Mockup
- Auto-Crop Strategies
- Segmentation API Route
- Root Layout And Providers
- Package Manifest
- Dev Dependencies
- Mask Render Harness
- Depth Verification Script
- Masking Service Inference
- Canvas Snapshot API
- Auth Pages And Shortcut Guides
- Crop Tool
- Editor Sidebar And Color Extraction
- Crop Agent Commands
- Megashader Compiler
- Matting Research Citations
- Masking Service Startup
- Image Feature Extraction
- Architecture Docs
- ImageKit Docs Ingest
- Services Main
- Ai Route
- Ai Route
- Draw
- Adjust
- Adjust
- Image Fingerprint
- Verify Client Ai
- Editor Sidebar
- Imagekit Agent
- Agent Overview
- Services Main
- Ai Route
- Imagekit Ai
- Jsconfig
- Bundle
- Imagekit Docs
- Requirements
- Verify Auto Crop
- Verify Mask Render
- Verify Semantic
- Preload Models
- Ai Route
- Ai Route
- Header
- Canvas Sync
- Package
- Manifest
- Verify Depth
- Verify Inpaint
- Ai Route
- Imagekit Agent
- Liquid Cursor Effect
- Mockups Index
- Readme
- Mockups Index
- Readme
- Verify Segment
- Extend Route
- Ai Route
- Ai Route
- Imagekit Route
- Usedynamicaccent
- Readme
- Services Main
- Ai Route
- Ai Route
- Imagekit Route
- Adjust
- Canvas Presence
- Project Pixel Effect
- Strip Metadata
- Tsconfig
- Setup Ort
- Verify Instances
- Services Main
- Floatingparticles
- Layout
- Imagekit Agent
- Professional Image Filters
- Useintersectionobserver
- Services Main
- Services Main
- Services Main
- Ai Route
- Adjust
- Tilt Card
- Vercel
- Jsconfig
- File
- Next.config
- Not Found
- Lottieinkdrop
- Countup
- Proxy
- Package
- Eslint.config
- Next.config
- Postcss.config
- Package
- Package
- Package
- Eslint.config
- Package
- Package
- Package
- Package
- Package
- Package
- Package
- Package
- Package
- Package
- Package
- Package
- Package
- Package
- Package
- Package
- Package
- Package
- Package
- Package
- Package
- Package
- Package
- Package
- Postcss.config
- Ink Drop Logo
- Agent Overview
- Readme

## God Nodes (most connected - your core abstractions)
1. `MaskControls()` - 47 edges
2. `cn()` - 47 edges
3. `ImageKitAgent()` - 44 edges
4. `useCanvas()` - 40 edges
5. `PixelStretchControls()` - 39 edges
6. `CanvasEditor()` - 37 edges
7. `enforceRateLimit()` - 36 edges
8. `scripts` - 35 edges
9. `rateLimitResponse()` - 35 edges
10. `usePixelMaskTool()` - 33 edges

## Surprising Connections (you probably didn't know these)
- `fillHoles()` --semantically_similar_to--> `cleanSubjectMatte (on-device matte cleanup under test)`  [INFERRED] [semantically similar]
  mockups/mask-lab/index.html → scripts/mask-verify/README.md
- `pymattingRefine()` --semantically_similar_to--> `cleanSubjectMatte (on-device matte cleanup under test)`  [INFERRED] [semantically similar]
  mockups/mask-lab/index.html → scripts/mask-verify/README.md
- `Phosmith Favicon` --semantically_similar_to--> `Phosmith Badge Logo`  [INFERRED] [semantically similar]
  src/app/icon.svg → public/logo.svg
- `Megashader Mask Harness (standalone WebGL2 page)` --references--> `Megashader Masking Engine`  [INFERRED]
  mockups/mask-harness/index.html → AGENT_OVERVIEW.md
- `Phosmith Mask Service (FastAPI, HF Space)` --conceptually_related_to--> `Local FastAPI AI Selection Service`  [INFERRED]
  services/segment/README.md → AGENT_OVERVIEW.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Select & Mask five-stage matting pipeline** — mockups_mask_lab_py_readme_coarse_stage, mockups_mask_lab_py_readme_trimap_stage, mockups_mask_lab_py_readme_fine_matte_stage, mockups_mask_lab_py_readme_decontaminate_stage, mockups_mask_lab_index_runpipeline, mockups_mask_lab_index_production_mapping [EXTRACTED 1.00]
- **Local mask-service CV model stack** — readme_birefnet, readme_sam2, readme_depth_anything_v2, readme_yolo26n_seg, readme_clipseg, readme_lama, services_segment_readme_phosmith_mask_service [EXTRACTED 1.00]
- **SAM 3.1 install constraint web (numpy<2, triton stub, undeclared deps)** — services_masking_requirements_numpy_sam3_pin, services_masking_requirements_triton_stub, services_masking_requirements_sam3_undeclared_deps, services_masking_requirements_sam3_gated_install, services_segment_requirements_shared_global_env [EXTRACTED 1.00]
- **Untouched create-next-app scaffold assets** — clerk_nextjs_public_file_documenticon, clerk_nextjs_public_globe_globeicon, clerk_nextjs_public_window_windowicon, clerk_nextjs_public_next_nextjswordmark, clerk_nextjs_public_vercel_verceltriangle [INFERRED 0.85]
- **Stream-convergence mark construction system** — public_logo_mark_originnode, public_logo_mark_streamfan, public_logo_mark_streamgradientset, public_logo_mark_glowfilterset, public_logo_mark_pixeldiamondnode [INFERRED 0.85]
- **Three-tier brand asset ladder (badge / transparent mark / favicon)** — public_logo_phosmithlogo, public_logo_mark_phosmithlogomark, src_app_icon_phosmithfavicon [INFERRED 0.85]
- **Shared Dark Terminal Design System Across Marketing, Dashboard, Editor** — docs_screenshots_dashboard_dark_terminal_design_language, docs_screenshots_dashboard, docs_screenshots_editor, docs_screenshots_features, docs_screenshots_dashboard_pixxel_brand_header [INFERRED 0.85]
- **Editor Workspace Shell: Toolbar, Properties Panel, Canvas, Zoom, Export** — docs_screenshots_editor_floating_toolbar, docs_screenshots_editor_tool_properties_panel, docs_screenshots_editor_canvas_stage, docs_screenshots_editor_zoom_control_bar, docs_screenshots_editor_export_menu, docs_screenshots_editor_chrome_out_of_the_way [INFERRED 0.85]
- **Landing Toolkit Pitch: Marquee to Headline to Capability Cards** — docs_screenshots_features_capability_marquee, docs_screenshots_features_toolkit_section, docs_screenshots_features_zero_round_trips_positioning, docs_screenshots_features_capability_card_row [EXTRACTED 1.00]
- **Shared Pixxel Marketing Design System** — docs_screenshots_hero_screenshot, docs_screenshots_pricing_screenshot, docs_screenshots_hero_terminal_brutalist_aesthetic, docs_screenshots_hero_global_nav, docs_screenshots_hero_offset_shadow_button_treatment [INFERRED 0.85]
- **Landing Page Conversion Funnel** — docs_screenshots_hero_version_eyebrow_badge, docs_screenshots_hero_headline_edit_pixels_with_intent, docs_screenshots_hero_dual_cta, docs_screenshots_pricing_stat_bar, docs_screenshots_pricing_two_tier_model [INFERRED 0.75]
- **Mask Harness Hard-Case Evaluation Criteria** — mockups_mask_harness_test_fixture, mockups_mask_harness_test_backlit_silhouette_case, mockups_mask_harness_test_haze_soft_edge_boundary, mockups_mask_harness_test_thin_appendage_detail [INFERRED 0.85]

## Communities (201 total, 46 thin omitted)

### Community 0 - "Pixel Stretch Engine"
Cohesion: 0.05
Nodes (104): attempt(), fails, HOSTILE_NUM, nonFinite(), ok(), canvasToScreen(), encodeToPngBlob(), getActiveImage() (+96 more)

### Community 1 - "Collage Planner And Layouts"
Cohesion: 0.06
Nodes (74): callGemini(), callGeminiOnce(), GEMINI_ENDPOINT(), isGemini3Model(), maxDuration, POST(), runtime, tuneGenerationConfig() (+66 more)

### Community 2 - "Brush Mask And Inpaint Hooks"
Cohesion: 0.06
Nodes (71): blobToDataUrl(), buildCompactInpaintPayload(), canvasToBlob(), commitMaskChange(), compositeInpaintPatch(), decodeBlobImage(), DEFAULT_BRUSH_SIZE, findInpaintMaskBounds() (+63 more)

### Community 3 - "AI Extend Pipeline"
Cohesion: 0.09
Nodes (43): AIExtender(), buildExtendRequest(), getBlobExtension(), getVisibleImageUrl(), isRemoteImageUrl(), buildExpansionComposite(), buildExpansionCompositeBlob(), buildVisibleImageBlob() (+35 more)

### Community 4 - "In-Browser AI Engines"
Cohesion: 0.12
Nodes (48): buildSelfTestScene(), calibrateGround(), canvasToRawImage(), CAPABILITY_LOADERS, clientDepthMap(), clientGroundPhrase(), clientSamBox(), clientSamClick() (+40 more)

### Community 5 - "Mask And Erase Tool Panels"
Cohesion: 0.07
Nodes (39): MAX_BRUSH, MIN_BRUSH, buildBackgroundRemovalUrls(), EraseControls(), fetchProcessedImage(), getReadableResponseText(), loadImageElement(), contrastFillFromHex() (+31 more)

### Community 6 - "Python Mask Lab Prototype"
Cohesion: 0.08
Nodes (47): _apply_block(), apply_local(), luma(), main(), mask_linear(), mask_radial(), mask_sky(), mask_subject() (+39 more)

### Community 7 - "Dashboard And Shortcuts"
Cohesion: 0.09
Nodes (32): INTERACTIVE_TAGS, isTypingContext(), useDashboardShortcuts(), emptyDeleteConfirm, formatRelativeTime(), getProjectCardElement(), getProjectPreview(), loadingCards (+24 more)

### Community 8 - "NL Mask Planning"
Cohesion: 0.08
Nodes (37): callGemini(), GEMINI_ENDPOINT(), maxDuration, POST(), runtime, bboxArea(), clampNum(), COLOR_NAME_HEX (+29 more)

### Community 9 - "Mask Layer State"
Cohesion: 0.17
Nodes (32): computeSignature(), NOTE: we intentionally do NOT free the texture cache entry here., reducer(), useMaskLayers(), KIND_SCHEMAS, ADJUST_FIELDS, BLEND_OPS, brushLayer() (+24 more)

### Community 10 - "App UI Screenshots"
Cohesion: 0.07
Nodes (36): Dashboard Screenshot, Dark Terminal Design Language, New Project CTA, PIXXEL Brand Header, PRO Plan Badge and Account Avatar, Project Thumbnail Card Grid, Projects Header Card, Recency Metadata On Cards (+28 more)

### Community 11 - "Agent Chat Panel"
Cohesion: 0.10
Nodes (34): adaptPlanV2(), ADJUSTMENT_DEFAULTS, ADJUSTMENT_HELP, ADJUSTMENT_LABELS, AgentThinkingRow(), analyzeActiveImage(), chatStorageKey(), checkServerTransformCache() (+26 more)

### Community 12 - "Package Scripts"
Cohesion: 0.06
Nodes (35): scripts, build, db:push, dev, imagekit:docs, lint, mask:dev, mask:install (+27 more)

### Community 13 - "Agent Command Registry"
Cohesion: 0.12
Nodes (26): calls, getCommand(), listCommands(), IMPORTANT: This is the seam ONLY — no agent is wired to it yet. Building, registerCommand(), registerDomain(), registry, runCommand() (+18 more)

### Community 14 - "Layer Grade Editor"
Cohesion: 0.13
Nodes (31): buildHistogramPaths(), clamp(), clientToCurvePoint(), cloneIdentity(), ColorWheel(), CURVE_CHANNELS, CURVE_GRAPH, CurveGraph() (+23 more)

### Community 15 - "New Project Modal"
Cohesion: 0.14
Nodes (23): canvasToBlob(), fitToCanvasLimits(), getSafeBaseName(), loadImageFromObjectUrl(), NewProjectModel(), rasterizeSelectedImage(), Alert(), AlertAction() (+15 more)

### Community 16 - "Clerk Scaffold Manifest"
Cohesion: 0.07
Nodes (30): dependencies, next, react, react-dom, devDependencies, babel-plugin-react-compiler, eslint, eslint-config-next (+22 more)

### Community 17 - "Canvas Shim For Tests"
Cohesion: 0.07
Nodes (4): Canvas, Ctx2D, ImageData, parseColor()

### Community 18 - "Megashader Filter Binding"
Cohesion: 0.13
Nodes (22): applyRefineStroke(), beginLayerRefine(), drawTextureInto(), expandLayerBoundary(), getFilter(), TEXTURE_BACKED_KINDS, applyMegashaderFilter(), disposeMegashader() (+14 more)

### Community 19 - "AI Routing And NL Mask Executor"
Cohesion: 0.15
Nodes (27): check(), liveGroundCheck(), MASK_SERVICE_URL, reachable(), createNlMaskRunner(), DEPTH_RANGES, LUMINANCE_RANGES, classifyColor() (+19 more)

### Community 20 - "Adjust Tool Panel"
Cohesion: 0.09
Nodes (28): AI_TRANSFORM_PREFIXES, ALL_VALUE_KEYS, buildImageKitTokens(), ColorWheelPicker(), computeImageHistogram(), CURVE_CHANNELS, CURVE_GRAPH, CURVE_POINTS_KEYS (+20 more)

### Community 21 - "Canvas Context And Shortcuts"
Cohesion: 0.14
Nodes (20): CanvasContext, DynamicAccentContext, useCanvas(), INTERACTIVE_TAGS, isTextObject(), isTypingContext(), useEditorShortcuts(), AuroraLoader() (+12 more)

### Community 22 - "Database Query Hooks"
Cohesion: 0.17
Nodes (19): createDatabaseRequestError(), useDatabaseMutation(), useDatabaseQuery(), useStoreUser(), createUser(), Dashboard(), getReducedMotionPreference(), ASPECT_RATIOS (+11 more)

### Community 23 - "Gemini Edit Planner Route"
Cohesion: 0.14
Nodes (26): ALLOWED_IMAGE_HOST_SUFFIXES, buildCanvasSignature(), buildStandardizedVisionUrl(), callGemini(), callGeminiForTargeting(), callGeminiOnce(), computePlanForImage(), DIRECT_ADJUSTMENT_RULES (+18 more)

### Community 24 - "Megashader Renderer"
Cohesion: 0.15
Nodes (25): getKindSchema(), normaliseUniformValue(), fillModeToFloat(), getMaskTextureVersion(), bindCachedMaskTexture(), bindKindTextures(), compileShader(), ensureGl() (+17 more)

### Community 25 - "Mask Service Client"
Cohesion: 0.19
Nodes (22): asDrawable(), MaskControls(), computeImageHistogram(), emptyHistogram(), getHistogramSourceElement(), HISTOGRAM_BUCKETS, HISTOGRAM_SAMPLE_SIZE, base64PngToBlob() (+14 more)

### Community 26 - "Curves Filter LUT"
Cohesion: 0.14
Nodes (12): buildCurveSvgPath(), buildLut(), clamp01(), DEFAULT_CURVE_POINTS, evalSegment(), identityLut(), isIdentityLut(), LUT_SIZE (+4 more)

### Community 27 - "ImageKit AI URL Builders"
Cohesion: 0.18
Nodes (23): buildAiEditPresetUrl(), buildFocusedGenfillUrl(), buildGenerativeFillUrl(), buildGenfillFromCompositeUrl(), buildGenfillPromptSegment(), buildImageKitAiTransformSteps(), buildImageKitAiTransformUrl(), buildImageKitBackgroundRemovalUrls() (+15 more)

### Community 28 - "GLSL Mask Kind Builders"
Cohesion: 0.08
Nodes (11): BRUSH_SCHEMA, COLOR_SCHEMA, DEPTH_SCHEMA, KIND_BUILDERS, LASSO_SCHEMA, LINEAR_SCHEMA, LUMINANCE_SCHEMA, PATH_SCHEMA (+3 more)

### Community 29 - "Neon Data Functions"
Cohesion: 0.13
Nodes (17): attachSnapshots(), clean(), findUserForAuth(), functions, getAuthUser(), getOwnedEditSet(), getOwnedProject(), MUTATION_FUNCTIONS (+9 more)

### Community 30 - "Component Config"
Cohesion: 0.09
Nodes (21): aliases, components, hooks, lib, ui, utils, iconLibrary, menuAccent (+13 more)

### Community 31 - "Change Journal Verification"
Cohesion: 0.12
Nodes (17): added, check(), entries, moved, removed, runSyncScenario(), sleep(), typed (+9 more)

### Community 32 - "Masking Service SAM Endpoints"
Cohesion: 0.13
Nodes (21): _bbox_of(), _ensure_triton_stub(), health(), _load_sam3(), _parse_clicks(), _patch_sam3_fused_mlp_for_cpu(), get, Phosmith masking service. Focused FastAPI service for the editor's AI selection… (+13 more)

### Community 33 - "Canvas Image Management"
Cohesion: 0.19
Nodes (20): ImageManager, ensureUid(), getImageThumbSrc(), ImageManager(), isImageObject(), addImageFilesToCanvas(), addImageFileToCanvas(), bakeOrientation() (+12 more)

### Community 34 - "Landing Page Screenshots"
Cohesion: 0.13
Nodes (21): Capability Chip Row (AI Extend, Upscale, Chat Edits, Multi-Image), Dual CTA: Open Studio / See The Tools, Global Nav Bar (Features, Pricing, Dashboard, Pro, Avatar), Headline: Edit Pixels With Intent, Cyan Offset-Shadow Bordered Component Treatment, Positioning: Browser-Native Editor Plus AI Agent, Pixxel Hero Landing Screenshot, Terminal-Brutalist Visual Language (+13 more)

### Community 35 - "Canvas Sync API Routes"
Cohesion: 0.21
Nodes (15): POST(), metaKey(), POST(), stateKey(), ensureOwnershipCached(), ownerKey(), parseMap(), POST() (+7 more)

### Community 36 - "Landing Feature Sections"
Cohesion: 0.20
Nodes (16): FEATURES, HeroFeatures(), STATS, Marquee(), NeoCard(), PLANS, Pricing(), fadeIn (+8 more)

### Community 37 - "Mask Agent Commands"
Cohesion: 0.22
Nodes (19): buildGradientMag(), createMaskCommands(), decodeBase64Png(), decodePng(), fetchSubjectInstances(), getFilter(), getSourceEl(), getStack() (+11 more)

### Community 38 - "Edit Planner And Style Profiles"
Cohesion: 0.18
Nodes (17): IMAGEKIT_AI_KEYS, VALIDATOR_VERSION, applyGain(), buildEditPlan(), clamp(), computeCorrections(), enumerateEntries(), isNonZero() (+9 more)

### Community 39 - "Editor Topbar And Export"
Cohesion: 0.19
Nodes (17): useDynamicAccent(), hasActiveProSubscription(), usePlanAccess(), EditorTopbar(), EXPORT_PRESETS, SCALE_OPTIONS, TOOLS, FloatingToolbar() (+9 more)

### Community 40 - "Edge Snap Verification"
Cohesion: 0.10
Nodes (16): brushErase, brushFill, cFill, cTwo, edgeImg, edgeStrength, flat, gmap (+8 more)

### Community 41 - "Masking Service Depth And Ground"
Cohesion: 0.22
Nodes (20): _decode_image(), depth(), ground_text(), _parse_box(), post, Response, UploadFile, Subject background-removal → RGBA PNG (alpha = subject). SAM 3 concept first,… (+12 more)

### Community 42 - "ImageKit Agent Plan Route"
Cohesion: 0.17
Nodes (14): fetchImageBase64(), json(), maxDuration, parseJson(), POST(), runtime, sanitizeAdjustments(), shouldUseOllamaVision() (+6 more)

### Community 43 - "Change History Panel"
Cohesion: 0.25
Nodes (16): journalMaskEdit(), HistoryPanel(), relativeTime(), clearChanges(), emit(), entries, getChanges(), hasWindow() (+8 more)

### Community 44 - "Segment Service Matting"
Cohesion: 0.16
Nodes (19): _bbox_from_mask(), clean_matte(), _disk(), _fine_matte(), _guided_filter_np(), _make_trimap(), _mask_png_b64(), ndarray (+11 more)

### Community 45 - "Segment Service Model Loading"
Cohesion: 0.14
Nodes (19): detect_providers(), detect_torch_device(), _ensure_depth(), _ensure_lama(), _ensure_sam3(), lifespan(), _load_depth(), _load_lama() (+11 more)

### Community 46 - "Gemini Edit Judge Route"
Cohesion: 0.18
Nodes (18): axisSchema, buildHeuristicVerdict(), buildNoChangeVerdict(), buildResponseSchema(), buildSystemPrompt(), callGemini(), callGeminiOnce(), clamp01() (+10 more)

### Community 47 - "Canvas Editor Core"
Cohesion: 0.22
Nodes (16): CanvasEditor(), clamp(), fitImageInsideProject(), getPrimaryRemoteImageUrl(), readPreviewZoomPercent(), createDebouncedFlusher(), fetchCachedSnapshot(), flushToNeon() (+8 more)

### Community 48 - "AI Background Tool"
Cohesion: 0.18
Nodes (15): BackgroundControls(), BG_SWATCHES, FatalImageKitResponseError, getBackgroundRemovalUrls(), getMainImage(), getReadableResponseText(), getToastErrorMessage(), wait() (+7 more)

### Community 49 - "RAW Preview Extraction"
Cohesion: 0.19
Nodes (18): bmpMeta(), exifOrientation(), extractRawPreview(), gifMeta(), isoImageMeta(), jpegMeta(), jpegSof(), parseTiff() (+10 more)

### Community 50 - "Masking Service Matting"
Cohesion: 0.18
Nodes (18): _bbox_from_mask(), clean_matte(), _disk(), _fine_matte(), _guided_filter_np(), _make_trimap(), _mask_png_b64(), ndarray (+10 more)

### Community 51 - "Segment Service Endpoints"
Cohesion: 0.16
Nodes (17): health(), _instances_from_sam3_output(), _lama_loadable(), _parse_shape_points(), get, _rasterize_shape_mask(), Phosmith mask service. Wraps `rembg` and Meta SAM 3.1 in a tiny FastAPI HTTP…, Cheap capability probe: are torch + transformers importable WITHOUT actually… (+9 more)

### Community 52 - "AI Extend API Route"
Cohesion: 0.22
Nodes (17): createSoftExtendFallbackBuffer(), createTransparentCompositeBuffer(), fetchSourceImageBuffer(), getCompositePlacement(), getExtension(), getImageKitClient(), getReadableResponseText(), maxDuration (+9 more)

### Community 53 - "Env Logging And Error Boundaries"
Cohesion: 0.16
Nodes (12): collect(), isValidated(), markValidated(), OPTIONAL_HINTS, REQUIRED_CLIENT, REQUIRED_SERVER, VALIDATED_KEY, validateEnv() (+4 more)

### Community 54 - "Text Tool And Sidebar"
Cohesion: 0.15
Nodes (17): TextControls, ALL_FONTS, clamp(), COLOR_SWATCHES, FONT_CATEGORIES, FONT_SIZES, getCanvasCenter(), getFontSize() (+9 more)

### Community 55 - "Brand Logo System"
Cohesion: 0.18
Nodes (17): create-next-app Default Asset Set, Next.js Wordmark, Vercel Triangle Logomark, Parametric Bezier Node Placement, Dark Radial Badge Field, Subtle Dot Grid Pattern, Rounded-Rect Glow Clip, Cyan-Violet Brand Palette (+9 more)

### Community 56 - "Path Raster And Mask Harness"
Cohesion: 0.24
Nodes (15): drawResult(), log(), main(), meanAbsDiff(), patchDiff(), tile(), pathLayer(), cubicAt() (+7 more)

### Community 57 - "Landing Hero And Chrome"
Cohesion: 0.18
Nodes (9): Header(), HeroSection(), TOOL_CHIPS, LandingChrome(), NeoButton, SIZES, VARIANTS, ScrambleText() (+1 more)

### Community 58 - "Redis And Server Cache"
Cohesion: 0.17
Nodes (10): hasNativeRedis, hasUpstash, inMemoryClient, nativeRedisClient, upstashClient, cacheDelete(), cacheGet(), cacheIncr() (+2 more)

### Community 59 - "Mask Lab Matting Mockup"
Cohesion: 0.16
Nodes (14): boxFilter(), buildMatte(), buildTrimap(), gaussBlur(), globalRefine(), guidedFilter(), MAT_PRESET matting model presets (guided / vitmatte / zim), morph() separable erode/dilate (+6 more)

### Community 60 - "Auto-Crop Strategies"
Cohesion: 0.17
Nodes (16): _clip_box_to_image(), _compose_anchor(), _compute_aspect_crop(), _compute_content_fill_crop(), _compute_depth_crop(), _compute_subject_crop(), _expand_box(), _fit_aspect() (+8 more)

### Community 61 - "Segmentation API Route"
Cohesion: 0.21
Nodes (15): BACKGROUND_LABELS, buildMaskFromAlpha(), buildSubjectMask(), callLocalMaskService(), callSegmentation(), decodeMaskBuffer(), fileToBuffer(), HF_ENDPOINTS (+7 more)

### Community 62 - "Root Layout And Providers"
Cohesion: 0.16
Nodes (10): DatabaseClientProvider(), clerkAppearance, clerkLocalization, jetbrainsMono, metadata, viewport, NATIVE_SCROLL_ROUTES, shouldUseNativeScroll() (+2 more)

### Community 63 - "Package Manifest"
Cohesion: 0.15
Nodes (14): ignoreScripts, sharp, unrs-resolver, license, name, packageManager, private, trustedDependencies (+6 more)

### Community 64 - "Dev Dependencies"
Cohesion: 0.13
Nodes (15): devDependencies, babel-plugin-react-compiler, eslint, eslint-config-next, playwright, prisma, tailwindcss, @tailwindcss/postcss (+7 more)

### Community 65 - "Mask Render Harness"
Cohesion: 0.26
Nodes (14): applyChain(), buildFabric(), depthRampImageData(), fillOn(), grayCanvas(), isGray(), isTinted(), leftHalfImageData() (+6 more)

### Community 66 - "Depth Verification Script"
Cohesion: 0.36
Nodes (13): analyse(), failures, log(), main(), MASK_SERVICE_URL, mkForm(), postImage(), probeService() (+5 more)

### Community 67 - "Masking Service Inference"
Cohesion: 0.15
Nodes (15): _best_mask_from_output(), _box_norm_from_points(), _depth_predict(), _image_hash(), _instances_from_sam3_output(), Image, Stable 64-bit hash of pixel data for the depth cache key., Depth Anything V2 → uint8 HxW (white=near). Cached by image hash. (+7 more)

### Community 68 - "Canvas Snapshot API"
Cohesion: 0.31
Nodes (13): ensureOwnership(), ensureOwnershipCached(), GET(), metaKey(), ownerKey(), POST(), stateKey(), cacheKey() (+5 more)

### Community 69 - "Auth Pages And Shortcut Guides"
Cohesion: 0.17
Nodes (8): AUTH_SECTIONS, DASHBOARD_SECTIONS, EDITOR_SECTIONS, MARKETING_SECTIONS, ShortcutsGuide(), VARIANT_SECTIONS, isTypingTarget(), SiteShortcuts()

### Community 70 - "Crop Tool"
Cohesion: 0.24
Nodes (14): CropContent, AUTO_CROP_MODES, canvasToPngBlob(), canvasToScreen(), copyDefinedProps(), CROP_PRESETS, CropContent(), CropOverlay() (+6 more)

### Community 71 - "Editor Sidebar And Color Extraction"
Cohesion: 0.26
Nodes (14): EditorSidebar(), adaptiveTextColor(), adjustColorBrightness(), compositeOver(), contrastRatio(), extractDominantColors(), getContrastingColor(), hexToRgb() (+6 more)

### Community 72 - "Crop Agent Commands"
Cohesion: 0.29
Nodes (14): canvasToPngBlob(), copyDefinedProps(), createCropCommands(), extractCropToCanvas(), fetchAutoCrop(), getImageCanvasBounds(), getSourceEl(), hasUnsupportedTransform() (+6 more)

### Community 73 - "Megashader Compiler"
Cohesion: 0.30
Nodes (13): buildBooleanChain(), buildEvalDispatcher(), buildFragmentTemplate(), buildLayerAdjustFunction(), buildLayerFunction(), buildVertexShader(), getKindBuilder(), compiledCache (+5 more)

### Community 74 - "Matting Research Citations"
Cohesion: 0.16
Nodes (14): decontaminate(), hustvl/Matte-Anything, Production mapping modal (mockup stage -> real model), pymatting/pymatting, shared_matting_webgl (real-time GLSL alpha matting), hustvl/ViTMatte, webgpu-sam2 / transformers.js SAM (in-browser SAM), naver-ai/ZIM (zero-shot matting, ICCV'25) (+6 more)

### Community 75 - "Masking Service Startup"
Cohesion: 0.19
Nodes (14): detect_providers(), detect_torch_device(), _ensure_depth(), _ensure_sam3(), lifespan(), _load_depth(), FastAPI, Pre-load SAM 3 + Depth so the first real request is fast. (+6 more)

### Community 76 - "Image Feature Extraction"
Cohesion: 0.29
Nodes (13): atLeast(), atMost(), clamp(), classifyCurrentStyle(), extractImageFeatures(), getSourceElement(), getStyleFit(), inRange() (+5 more)

### Community 77 - "Architecture Docs"
Cohesion: 0.19
Nodes (13): Agent Command Registry, AI Caching & Deterministic Planning, Canvas State Write-Behind Caching, Collage Engine (pure geometry), Neon/Postgres + Prisma Backend, Phosmith Architecture Overview (for agents), Undo/Redo Object Identity Rule, Prisma Migrations over db:push (+5 more)

### Community 78 - "ImageKit Docs Ingest"
Cohesion: 0.19
Nodes (11): absoluteDocsUrl(), chunks, decodeHtml(), discoverLinks(), LIMIT, OUTPUT, pages, queue (+3 more)

### Community 79 - "Services Main"
Cohesion: 0.18
Nodes (13): crop_auto(), inpaint(), _parse_aspect(), JSONResponse, Response, UploadFile, Stream-read an UploadFile into memory, aborting if it exceeds the upload limit…, Inpaint masked regions using LaMa. Accepts: - image: the source image… (+5 more)

### Community 80 - "Ai Route"
Cohesion: 0.27
Nodes (12): callHuggingFaceInpaint(), callLamaInpaint(), clamp(), compositePatch(), extractImageBuffer(), fileToBuffer(), getMaskBounds(), HF_ENDPOINTS (+4 more)

### Community 81 - "Ai Route"
Cohesion: 0.28
Nodes (11): callSam2Service(), fileToBuffer(), maxDuration, parseBox(), parseClicks(), POST(), prepareImage(), readImageMeta() (+3 more)

### Community 82 - "Draw"
Cohesion: 0.22
Nodes (10): DrawControls, BRUSH_TYPES, COLOR_SWATCHES, commitDrawChange(), DrawControls(), isPathObject(), clamp(), ProRulerSlider() (+2 more)

### Community 83 - "Adjust"
Cohesion: 0.27
Nodes (13): AdjustControls(), applyAdjustmentFilters(), buildProxyCanvas(), filterMatchesManagedKey(), getAdjustmentSourceImage(), getAdjustmentTargets(), getImageSrc(), getSelectedImage() (+5 more)

### Community 84 - "Adjust"
Cohesion: 0.24
Nodes (13): buildCurvesFilter(), buildHistogramPaths(), clamp(), clientToCurvePoint(), cloneIdentityPoints(), CurveEditorPanel(), CurveGraph(), findNearestPointIndex() (+5 more)

### Community 85 - "Image Fingerprint"
Cohesion: 0.21
Nodes (10): collectLayersForTargeting(), getSourceUrl(), isVisibleImageOnCanvas(), renderFabricObjectElement(), computeImageFingerprint(), computeLayerThumbnail(), computePerceptualHash(), fnv1a() (+2 more)

### Community 86 - "Verify Client Ai"
Cohesion: 0.18
Nodes (9): build, HARNESS_DIR, log(), MIME, PROFILE_DIR, ROOT, server, skip() (+1 more)

### Community 87 - "Editor Sidebar"
Cohesion: 0.18
Nodes (11): AdjustControls, AIEdits, AIExtender, BackgroundControls, CollageControls, ImageKitAgent, lazyTool(), PanelLoading() (+3 more)

### Community 88 - "Imagekit Agent"
Cohesion: 0.30
Nodes (11): buildExtensionPlanResult(), buildLocalVisualPlan(), callOllamaVisionPlanner(), clamp(), cleanPrompt(), dedupeTransforms(), DIRECTION_PATTERNS, EXTEND_TRIGGERS (+3 more)

### Community 89 - "Agent Overview"
Cohesion: 0.20
Nodes (11): Per-Capability AI Routing Policy, Brush Latency: contextTop compositing, In-Browser AI Engines (transformers.js), Local FastAPI AI Selection Service, Megashader Masking Engine, RMBG-1.4 Manual Recipe (client matting), RMBG-1.4 (client-side background removal), _canvas-shim.mjs pure-JS canvas (+3 more)

### Community 90 - "Services Main"
Cohesion: 0.18
Nodes (11): _ensure_triton_stub(), _load_sam3(), _patch_sam3_fused_mlp_for_cpu(), SAM 3's builder reliably handles CUDA and CPU. Avoid MPS model/tensor…, Two upstream sam3/torch issues only reproduce on CPU on Apple Silicon; patch…, SAM 3's kernels (edt / nms / connected-components) do a bare ``import triton``…, sam3 hardcodes ``device="cuda"`` / ``.cuda()`` in several spots that run on the…, Load SAM 3 into app.state (blocking). Caller holds _SAM3_LOCK. (+3 more)

### Community 91 - "Ai Route"
Cohesion: 0.35
Nodes (10): callGeminiForStretchPlan(), GEMINI_ENDPOINT(), generateFallbackPlan(), getCachedPlan(), getCacheKey(), _planCache, POST(), robustParseJSON() (+2 more)

### Community 92 - "Imagekit Ai"
Cohesion: 0.35
Nodes (10): AIEdits(), getSourceUrl(), presetIncludesUpscale(), PRESETS, ensureCurrentImageKitEndpoint(), getCanvasActiveImage(), hasImageKitAiTransform(), isCurrentImageKitEndpoint() (+2 more)

### Community 93 - "Jsconfig"
Cohesion: 0.20
Nodes (9): compilerOptions, lib, paths, target, @hooks/*, DOM, DOM.Iterable, ES2020 (+1 more)

### Community 94 - "Bundle"
Cohesion: 0.38
Nodes (9): drawResult(), flattenPath(), main(), pointInPolygon(), rasterisePath(), rasterisePathData(), smoothToBezier(), tile() (+1 more)

### Community 95 - "Imagekit Docs"
Cohesion: 0.33
Nodes (6): imageKitDocsSeed, getImageKitDocs(), normalize(), retrieveImageKitDocs(), tokenize(), unique()

### Community 96 - "Requirements"
Cohesion: 0.24
Nodes (10): Local AI Services Setup & Verification, Masking service Python dependency set, numpy<2 pin chain for sam3, SAM 3.1 gated install (not on PyPI), sam3's undeclared runtime deps (einops, pycocotools, opencv), CPU triton stub (_ensure_triton_stub), Model size/quality trade-off notes, Optional deps degrade endpoints to 501 (+2 more)

### Community 97 - "Verify Auto Crop"
Cohesion: 0.36
Nodes (9): contains(), die(), inBounds(), log(), main(), MASK_SERVICE_URL, post(), reachable() (+1 more)

### Community 98 - "Verify Mask Render"
Cohesion: 0.22
Nodes (8): build, HARNESS_DIR, log(), MIME, PROFILE_DIR, ROOT, server, skip()

### Community 99 - "Verify Semantic"
Cohesion: 0.40
Nodes (9): analyseMask(), assertScore(), callSam2(), fail(), log(), main(), MASK_SERVICE_URL, probeService() (+1 more)

### Community 100 - "Preload Models"
Cohesion: 0.20
Nodes (3): Dev pre-download: fetch the masking models into the local cache so the first…, Pre-download masking model weights into /app/model_cache at Docker build time.…, Pre-download all model weights into /app/model_cache at Docker build time.…

### Community 101 - "Ai Route"
Cohesion: 0.33
Nodes (9): ALLOWED_IMAGE_SIZES, fetchWithTimeout(), generateImageWithHuggingFace(), getHuggingFaceEndpoint(), getImageKitEndpoint(), maxDuration, POST(), uploadBufferToImageKit() (+1 more)

### Community 102 - "Ai Route"
Cohesion: 0.31
Nodes (8): callDepthService(), fileToBuffer(), maxDuration, POST(), readImageMeta(), runtime, LIMITERS, rateLimitResponse()

### Community 103 - "Header"
Cohesion: 0.22
Nodes (5): NEO_NAV_STYLE, PHOSMITH_SPARK, PhosmithWordmark, duration, easeOut

### Community 104 - "Canvas Sync"
Cohesion: 0.38
Nodes (8): clearLocalState(), createCanvasSync(), getOnlineStatus(), loadLocalState(), openDB(), saveLocalState(), subscribeOnlineStatus(), withStore()

### Community 105 - "Package"
Cohesion: 0.22
Nodes (9): class-variance-authority, lucide, dependencies, class-variance-authority, lucide, react-dropzone, tw-animate-css, react-dropzone (+1 more)

### Community 106 - "Manifest"
Cohesion: 0.22
Nodes (8): background_color, description, display, icons, name, short_name, start_url, theme_color

### Community 107 - "Verify Depth"
Cohesion: 0.42
Nodes (8): analyseDepth(), callDepth(), fail(), log(), main(), MASK_SERVICE_URL, probeService(), synthesizeTestImage()

### Community 108 - "Verify Inpaint"
Cohesion: 0.50
Nodes (8): analyze(), check(), fail(), log(), main(), MASK_SERVICE_URL, skip(), synthesize()

### Community 109 - "Ai Route"
Cohesion: 0.36
Nodes (8): ALLOWED_MODES, fileToBuffer(), maxDuration, POST(), prepareImage(), runtime, scaleBox(), scaleCrop()

### Community 110 - "Imagekit Agent"
Cohesion: 0.25
Nodes (9): AgentChangeList, AgentEffectControls(), buildEffectivePlan(), createValueMap(), formatAdjustmentValue(), getChangeItems(), getEnabledChangeDetails(), readableTransform() (+1 more)

### Community 111 - "Liquid Cursor Effect"
Cohesion: 0.44
Nodes (8): CL(), LiquidCursorEffect(), mkFBO(), mkProg(), mkShader(), R(), randomPointAwayFrom(), SA()

### Community 112 - "Mockups Index"
Cohesion: 0.25
Nodes (8): Neo-Brutalist 'Void Dark' Theming, Megashader Mask Harness (standalone WebGL2 page), 'Ink Depths' palette + 4-area app shell layout, Photoshop Select & Mask (UX reference), Mask Lab — Select & Mask pipeline mockup (browser), Photoshop-parity View Modes, Phosmith Mask Lab (Python CLI/Gradio tool), Mask Lab deps reuse the segment service venv

### Community 113 - "Readme"
Cohesion: 0.32
Nodes (8): clerk-nextjs create-next-app Boilerplate README, Adjust Tool Parameter Set (15+ sliders), AGPL-3.0 Licensing Decision, Mask Tool Taxonomy (AI / Draw / Range / Destructive), Megashader WebGL2 Compositing Engine, Phosmith — AI Image Studio (README), YOLO26n-seg (multi-instance detection), Scratch image-preview page (test.html)

### Community 114 - "Mockups Index"
Cohesion: 0.25
Nodes (7): autoSelect(), fillHoles(), Stage 1 — Coarse mask (rembg / GrabCut / saliency), BiRefNet (subject segmentation), BiRefNet via rembg / ONNX Runtime, POST /segment (saliency subject matte), rembg onnxruntime backend choice (cpu vs gpu)

### Community 115 - "Readme"
Cohesion: 0.29
Nodes (8): AI Auto-Crop (4 strategies), Production Deployment: Vercel + Hugging Face Space, Depth Anything V2 (monocular depth), Depth Anything V2 Small (monocular depth), POST /depth (normalized depth map), GET /health probe, SEGMENT_EAGER_MODELS lazy loading default, Phosmith Mask Service (FastAPI, HF Space)

### Community 116 - "Verify Segment"
Cohesion: 0.43
Nodes (7): analyseMask(), fail(), log(), main(), MASK_SERVICE_URL, probeService(), synthesizeTestImage()

### Community 117 - "Extend Route"
Cohesion: 0.39
Nodes (7): getExtension(), getImageKitClient(), isImageKitGenfillUrl(), maxDuration, POST(), runtime, uploadBufferToImageKit()

### Community 118 - "Ai Route"
Cohesion: 0.39
Nodes (7): callShapeMaskService(), maxDuration, parseDimension(), parsePoints(), POST(), runtime, enforceRateLimit()

### Community 119 - "Ai Route"
Cohesion: 0.25
Nodes (5): MASK_SERVICE_URL, MASKING_SERVICE_URL, maxDuration, runtime, SERVICES

### Community 120 - "Imagekit Route"
Cohesion: 0.39
Nodes (7): getHeaderSnapshot(), json(), maxDuration, POST(), readBodySnippet(), runtime, sleep()

### Community 121 - "Usedynamicaccent"
Cohesion: 0.43
Nodes (7): buildPalette(), DEFAULT_PALETTE, fac, hslToHex(), hslToRgb(), rgbToHsl(), useDynamicAccent()

### Community 122 - "Readme"
Cohesion: 0.29
Nodes (7): AI Object Remover (click -> SAM -> LaMa), CLIPSeg (open-vocabulary text grounding), LaMa (object removal inpainting), Natural-Language Masking, SAM 2 (point/box segmentation), POST /sam2/click (positive/negative clicks), SAM 2 Hiera-Small (click-to-select)

### Community 123 - "Services Main"
Cohesion: 0.33
Nodes (7): _depth_predict(), _image_hash(), Image, Stable hash of a PIL image's pixel data for cache keys (depth maps). Collisions…, Run Depth Anything V2 on `img`, caching the depth map by image hash. Returns a…, SAM 3.1 box-prompted selection of the single object inside a rectangle.…, _sam3_box_mask()

### Community 124 - "Ai Route"
Cohesion: 0.43
Nodes (6): fileToBuffer(), maxDuration, POST(), prepareImage(), runtime, upscaleMask()

### Community 125 - "Ai Route"
Cohesion: 0.43
Nodes (6): fileToBuffer(), maxDuration, POST(), prepareImage(), runtime, upscaleMask()

### Community 126 - "Imagekit Route"
Cohesion: 0.48
Nodes (6): getFormString(), getImageKit(), isUploadableFile(), maxDuration, POST(), sanitizeFileName()

### Community 127 - "Adjust"
Cohesion: 0.33
Nodes (7): addBlend(), buildChannelMatrix(), buildConvolution(), buildFabricFilters(), buildGammaValues(), grayscaleMatrix(), markFilter()

### Community 128 - "Canvas Presence"
Cohesion: 0.67
Nodes (6): computeIsNewcomer(), createPresenceChannel(), describeDevice(), getClientId(), hasWindow(), randomId()

### Community 129 - "Project Pixel Effect"
Cohesion: 0.48
Nodes (5): buildParticles(), captureElement(), createProjectPixelDissolver(), easeOutCubic(), loadImage()

### Community 130 - "Strip Metadata"
Cohesion: 0.48
Nodes (6): ESSENTIAL_PNG_CHUNKS, isValidStrippedImage(), stripImageMetadata(), stripJpeg(), stripPng(), stripWebp()

### Community 131 - "Tsconfig"
Cohesion: 0.33
Nodes (5): scripts/mask-verify/_stub-megashader.mjs, compilerOptions, baseUrl, paths, @/lib/megashader

### Community 132 - "Setup Ort"
Cohesion: 0.33
Nodes (5): CANDIDATES, out, WHY: bundlers (Next/Turbopack included) break onnxruntime's runtime fetch of, ROOT, src

### Community 133 - "Verify Instances"
Cohesion: 0.53
Nodes (5): log(), main(), MASK_SERVICE_URL, maskStats(), synthesizeTwoSubjectImage()

### Community 134 - "Services Main"
Cohesion: 0.33
Nodes (6): JSONResponse, SAM 3-first concept instance detection: one greyscale mask PER instance (label,…, rembg saliency matte (single-channel 'L'), self-healing to a CPU session. If…, _rembg_matte(), _saliency_instance(), segment_instances()

### Community 136 - "Layout"
Cohesion: 0.40
Nodes (3): geistMono, geistSans, metadata

### Community 138 - "Imagekit Agent"
Cohesion: 0.40
Nodes (5): chatLegacyKey(), inferThreadTitle(), makeEmptyThread(), migrateLegacyV1(), newThreadId()

### Community 139 - "Professional Image Filters"
Cohesion: 0.60
Nodes (4): applyProfessionalFilters(), buildProfessionalFilters(), CONFIGS, isAgentFilter()

### Community 141 - "Services Main"
Cohesion: 0.50
Nodes (4): limit_upload_size(), middleware, Request, Reject oversize POSTs by Content-Length before the body is read.

### Community 142 - "Services Main"
Cohesion: 0.50
Nodes (4): _bbox_of(), Reduce concept instance dicts to the three things /crop/auto's subject strategy…, Tight [x, y, w, h] bounding box of a boolean mask (mask is non-empty)., _subjects_from_instances()

### Community 143 - "Services Main"
Cohesion: 0.50
Nodes (4): limit_upload_size(), middleware, Request, Reject oversize POSTs before the body is read (defends against memory/disk…

### Community 145 - "Adjust"
Cohesion: 0.50
Nodes (4): applyVignetteLayer(), ensureAdjustmentObjectId(), isVignetteLayer(), removeVignetteLayers()

### Community 147 - "Vercel"
Cohesion: 0.50
Nodes (3): buildCommand, framework, installCommand

### Community 149 - "File"
Cohesion: 0.67
Nodes (3): File Document Icon, Globe Icon, Browser Window Icon

## Ambiguous Edges - Review These
- `Phosmith — AI Image Studio (README)` → `clerk-nextjs create-next-app Boilerplate README`  [AMBIGUOUS]
  clerk-nextjs/README.md · relation: conceptually_related_to
- `Phosmith — AI Image Studio (README)` → `Scratch image-preview page (test.html)`  [AMBIGUOUS]
  test.html · relation: conceptually_related_to
- `Floating Tool Strip` → `Nine Tools Marketing Count vs Editor Tool Count`  [AMBIGUOUS]
  docs/screenshots/features.png · relation: conceptually_related_to
- `Object Selection Handles` → `AI Extend Capability Card`  [AMBIGUOUS]
  docs/screenshots/features.png · relation: conceptually_related_to
- `Capability Chip Row (AI Extend, Upscale, Chat Edits, Multi-Image)` → `Mask Harness Test Fixture Image`  [AMBIGUOUS]
  mockups/mask-harness/test.png · relation: conceptually_related_to

## Knowledge Gaps
- **487 isolated node(s):** `eslintConfig`, `paths`, `nextConfig`, `name`, `version` (+482 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **46 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **What is the exact relationship between `Phosmith — AI Image Studio (README)` and `clerk-nextjs create-next-app Boilerplate README`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **What is the exact relationship between `Phosmith — AI Image Studio (README)` and `Scratch image-preview page (test.html)`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **What is the exact relationship between `Floating Tool Strip` and `Nine Tools Marketing Count vs Editor Tool Count`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **What is the exact relationship between `Object Selection Handles` and `AI Extend Capability Card`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **What is the exact relationship between `Capability Chip Row (AI Extend, Upscale, Chat Edits, Multi-Image)` and `Mask Harness Test Fixture Image`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **Why does `useCanvas()` connect `Canvas Context And Shortcuts` to `Pixel Stretch Engine`, `Collage Planner And Layouts`, `Canvas Image Management`, `AI Extend Pipeline`, `Mask And Erase Tool Panels`, `Crop Tool`, `Editor Topbar And Export`, `Agent Chat Panel`, `Canvas Editor Core`, `AI Background Tool`, `Draw`, `Adjust`, `Adjust Tool Panel`, `Database Query Hooks`, `Text Tool And Sidebar`, `Mask Service Client`, `Imagekit Ai`?**
  _High betweenness centrality (0.056) - this node is a cross-community bridge._
- **Why does `enforceRateLimit()` connect `Ai Route` to `Collage Planner And Layouts`, `Canvas Sync API Routes`, `Canvas Snapshot API`, `Ai Route`, `NL Mask Planning`, `Ai Route`, `Gemini Edit Judge Route`, `Ai Route`, `Ai Route`, `Segmentation API Route`, `AI Extend API Route`, `Gemini Edit Planner Route`, `Ai Route`, `Ai Route`, `Ai Route`, `Imagekit Route`?**
  _High betweenness centrality (0.022) - this node is a cross-community bridge._