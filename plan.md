# Fix Radial Menu Hover Math Mismatch

## Issue Description
The radial menu's sub-options are experiencing severe visual and interaction bugs:
1. Moving the mouse towards the sub-chips causes the entire menu to collapse or switch to a different tool unexpectedly (e.g., from Extend to AI BG).
2. Hovering over empty space near the chips highlights incorrect sub-options.
3. The visual location of the chips does not match the invisible mathematical hover hitboxes.

## Root Cause
1. **Mathematical Shift:** The `angle` used in the `pointermove` event has a `sliceAngle / 2` offset added to it (so that wedges can be centered on their index). However, this shifted angle is directly compared against `wedgeMidAngle` to check if the cursor is within the sub-chip fan. This causes the entire invisible hover fan to be shifted by `sliceAngle / 2` (20 or 22.5 degrees) relative to where the physical chips are drawn.
2. **Double Hover State Management:** The sub-chips have both React DOM `onMouseEnter` events and a global `pointermove` mathematical calculation setting the `hoveredSubIndex`. The clashing mismatched coordinates result in random chips highlighting as the mouse moves.

## Proposed Changes

### `src/app/(main)/editor/[projectId]/_components/RadialToolMenu.jsx`
1. Fix the `diff` calculation for the sub-ring zone by computing an unshifted `normalizedAngle` (raw `atan2` + 90) and using that to compare against `wedgeMidAngle`.
2. Remove the mathematical `setHoveredSubIndex(subIdx)` completely from `handlePointerMove`.
3. Rely entirely on the DOM `onMouseEnter` and `onMouseLeave` props on the sub-chip buttons to handle the hover state for the sub-options.
4. If the cursor is within the sub-ring radius and within the unshifted fan angle, simply `return` to keep the parent wedge highlighted.

This will perfectly align the physical layout of the chips with the hover hitboxes, eliminating all erratic behavior.
