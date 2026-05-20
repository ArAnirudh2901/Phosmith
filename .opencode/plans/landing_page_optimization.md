# Pixxel Landing Page Code Optimization Plan

## Objective
Optimize the landing page codebase for **performance, maintainability, and reusability** without altering the **visuals, animations, or behavioral quality**.

---

## Current State Analysis

### Key Components & Hooks Identified (Animation-Critical)

1. **`liquid-cursor-effect.jsx`** (501 lines)
   - WebGL-based water ripple & displacement effect.
   - Heavy GPU usage due to continuous `requestAnimationFrame` + `gl.readPixels` + SVG filter updates.
   - **Current behavior:** Responds to both mouse AND has an auto-wander animation.
   - **Goal:** Keep auto-wander animation, remove mouse/touch interaction entirely to save GPU cycles.

2. **`floating-shapes.jsx`** & **`parallax-effect.jsx`**
   - Floating blobs with parallax scrolling.
   - `parallax-effect.jsx` uses a simple scroll listener.
   - `floating-shapes.jsx` is animation-heavy but purely decorative.

3. **`hero.jsx`**, **`Features.jsx`**, **`pricing.jsx`**, **`header.jsx`**
   - Extensive use of `framer-motion` (`motion.` components).
   - `gsap` is imported but primarily handled by `framer-motion` in these landing page files? (Need to verify usage of `/hooks/useGsap`).

4. **`tilt-card.jsx`** & **`glass-panel.jsx`**
   - `tilt-card.jsx` uses `use3DTilt`.
   - `glass-panel.jsx` uses `useDTilt`.
   - **`use3DTilt.js` and `useDTilt.js` are 95% identical** in logic and structure. They only differ in class selectors for the glare effect.

5. **`smooth-scroll-provider.jsx`**
   - Wraps the app in Lenis smooth scroll.

### Dependencies & Concerns
- **Multiple Animation Libraries:** Framer Motion, GSAP, and AnimeJS are all listed in `package.json`. Having 3 full animation libraries is a significant JavaScript bundle concern.
- **CSS Bundle Size:** `globals.css` is a massive file (1000+ lines) with mix of utilities, animations, and component styles. It mixes utility classes and BEM-style classes, leading to potential duplication and specificity issues.
- **Component Rendering:** The `layout.js` renders `LiquidCursorEffect` without any lazy loading or `Suspense`.

---

## Proposed Optimizations (Step-by-Step)

### Phase 1: Code Deduplication & Refactoring (Zero Animation Impact)

#### 1. Merge Duplicate Hooks (`use3DTilt.js` and `useDTilt.js`)
- **Problem:** Identical logic, different class names. This is technical debt and increases bundle size.
- **Action:** Create a generic `useTilt` hook that accepts a `glareClassName` option. Update `tilt-card.jsx` and `glass-panel.jsx` to use it.
- **Benefit:** Reduces code, easier maintenance.

#### 2. Refactor `LiquidCursorEffect` Behavior
- **Problem:** High GPU usage from `readPixels` and `mousemove` when user isn't even interacting.
- **Action:**
  - Disable all `mousemove`, `mousedown`, `touchmove`, `touchstart` event listeners.
  - Keep the `Auto-wander` logic (`seedA`, `advA`, etc.).
  - Remove `gl.readPixels` and the SVG displacement map logic entirely (since it's driven by mouse interaction).
  - Keep the WebGL render loop for the visual "auto-wander" effect.
- **Benefit:** Drastically reduces GPU load. Simplifies logic.

#### 3. Lazy Load Non-Critical Components
- **Problem:** `LiquidCursorEffect` and `FloatingShapes` are initialized on every page load, even if the user scrolls past them.
- **Action:**
  - Wrap `FloatingShapes` in a `React.lazy()` and a `Suspense` boundary.
  - Apply `import('liquid-cursor-effect')` only when the user is on the landing page (or ensure it only runs where intended, currently it runs via `layout.js`).

### Phase 2: CSS & Bundle Optimization (Zero Animation Impact)

#### 4. Modularize CSS
- **Problem:** `globals.css` is a monolithic file. It contains Tailwind `@theme`, base styles, animations, layout styles, and utility classes.
- **Action:**
  - Extract animations (`@keyframes`) into a separate `animations.css` file.
  - Extract utility classes (e.g., `.pill-control`, `.glass-interactive`) into a `utilities.css` file.
  - Keep `globals.css` strictly for Tailwind imports and root variables.
- **Benefit:** Improved maintainability, slightly better caching for the main CSS chunk.

#### 5. Audit Animation Library Usage
- **Problem:** `package.json` includes `animejs`, `gsap`, and `framer-motion`.
- **Action:**
  - Check `useGsap.js`. If `useGsapReveal` and `useGsapStagger` are only used in a few places, and `framer-motion` `motion.` is the primary approach (e.g., in `Features.jsx`, `pricing.jsx`), migrate the few GSAP usages to `framer-motion` (or vice versa).
  - **Decision:** Since `framer-motion` is already heavily used for the exact same purposes (reveal, stagger), **migrate GSAP logic to `framer-motion`**. This allows removing `gsap` and its massive bundle size entirely.
  - Remove `animejs` if it has zero imports.
- **Benefit:** Significant reduction in JavaScript bundle size (GSAP alone is ~50KB+).

### Phase 3: Component-Level Refinements (Zero Animation Impact)

#### 6. Optimize SVG in Header
- **Problem:** `header.jsx` has a massive inline SVG string for the logo (ink drop). React re-parses this on every parent render.
- **Action:** Move the SVG into its own component file (e.g., `components/ink-logo.tsx`) and ensure it's wrapped in `React.memo`.
- **Benefit:** Reduces Reconciliation cost for the Header.

#### 7. `floating-shapes.jsx` Refactoring
- **Problem:** Inline styles and classnames are generated via string interpolation, and the component uses a heavy `motion.div` for each shape.
- **Action:**
  - Move the `shapes` array OUTSIDE the component to prevent re-creation on every render.
  - Use CSS classes for animations where possible instead of inline Framer Motion animations if they are purely decorative (e.g., the continuous `float` keyframes) to reduce JS overhead.
- **Benefit:** Prevents unnecessary object/closure creation on re-renders.

---

## File-by-File Execution Strategy

### `src/app/layout.js`
- Wrap `LiquidCursorEffect` in `React.lazy` and `Suspense`.

### `src/components/liquid-cursor-effect.jsx`
- **Keep:** WebGL context, `SIM_FRAG`, `RENDER_FRAG`, auto-wander logic.
- **Remove:** `onMM`, `onMD`, `onML`, `onME`, `onTM`, `onTS`, all event listeners, `dispCanvasRef`, `readPixels`, SVG creation, `feDisplacementMap`.
- **Result:** A lighter, WebGL-only background effect.

### `src/hooks/use3DTilt.js` & `src/hooks/useDTilt.js`
- **Replace with:** `src/hooks/useTilt.js` (accepts `glareClassName`).
- **Update:** `tilt-card.jsx` and `glass-panel.jsx`.

### `src/components/Features.jsx`, `src/hooks/useGsap.js`
- **Remove:** `gsap` and `ScrollTrigger` from `useGsap.js`.
- **Update:** Replace `useGsapReveal` and `useGsapStagger` with equivalent `framer-motion` `useInView` and `motion.div` stagger logic.
- **Update:** `Features.jsx` to use `framer-motion` for feature cards.

### `src/components/floating-shapes.jsx`
- Move `shapes` array to module level.
- Replace `motion.div` continuous animations (if they're just floating, not parallax) with CSS `@keyframes float` where possible, or wrap `motion.div` in `memo`.

---

## Verification Checklist

- [ ] `npm run build` passes without errors.
- [ ] Landing page scrolls smoothly (Lenis).
- [ ] Floating blobs animate on scroll and hover.
- [ ] Feature cards stagger-in correctly.
- [ ] Liquid cursor auto-wanders smoothly.
- [ ] No mouse interaction on the liquid cursor.
- [ ] Tilt effect on cards still working (mouse move should still tilt).
- [ ] `next build` output shows reduced JS size.

---

## Performance Targets
- **JS Bundle Reduction:** Target 50-100KB+ reduction by removing `gsap` and `animejs` (if unused) and deduplicating `useTilt` logic.
- **GPU Usage:** 30-40% reduction by disabling `readPixels` and `mousemove` processing in the liquid effect.
