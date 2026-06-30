#!/usr/bin/env python3
"""
Phosmith Mask Lab — LOCAL ADJUSTMENT masking (Lightroom / DaVinci style).

The reference reels show the real goal: not background removal, but
*mask-driven local edits* — stack masks (subject / radial / linear / sky),
each carrying its own tone & colour adjustments, applied ONLY inside the mask.

This is the functional twin of phosmith's megashader mask layers
(`src/lib/megashader/mask-types.js`), which already carry per-mask
exposure/contrast/highlights/shadows/whites/blacks/saturation/temp/tint.
Here we add the two the engine is missing — **texture** and **dehaze** —
and prove the whole stack with a before/after.

    python local_edit.py photo.jpg --recipe cat --out out/
    python local_edit.py photo.jpg --recipe landscape --out out/

Run with the segment venv (for the subject mask):
    ../../services/segment/.venv/bin/python local_edit.py photo.jpg --recipe cat
"""

import os, sys, argparse
import numpy as np
import cv2
from mask_lab import load_image, coarse_mask, make_trimap, fine_matte, _disk, _save

# ─────────────────────── mask generators ───────────────────────

def luma(rgb):  # rgb float 0..1
    return rgb[..., 0] * 0.299 + rgb[..., 1] * 0.587 + rgb[..., 2] * 0.114

def smoothstep(a, b, x):
    t = np.clip((x - a) / (b - a + 1e-9), 0, 1)
    return t * t * (3 - 2 * t)

def mask_subject(rgb_u8, method="auto", soft=True):
    """Soft subject mask (radial-ish): coarse seg + optional matte feathering."""
    m = coarse_mask(rgb_u8, method)
    if soft:
        tri = make_trimap(m, 6, 12)
        a = fine_matte(rgb_u8, tri, "guided")
        return np.clip(a, 0, 1).astype(np.float32)
    return (m > 127).astype(np.float32)

def mask_radial(shape, cx=None, cy=None, rx=None, ry=None, feather=0.6, invert=False):
    """Elliptical gradient mask — phosmith RadialMaskLayer twin."""
    h, w = shape[:2]
    cx = w * 0.5 if cx is None else cx
    cy = h * 0.5 if cy is None else cy
    rx = w * 0.42 if rx is None else rx
    ry = h * 0.42 if ry is None else ry
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    d = np.sqrt(((xx - cx) / rx) ** 2 + ((yy - cy) / ry) ** 2)   # 1.0 at ellipse edge
    inner = 1.0 - max(0.02, feather)
    m = 1.0 - smoothstep(inner, 1.0, d)
    return (1 - m) if invert else m

def mask_linear(shape, p1=None, p2=None, feather=0.5, invert=False):
    """Linear gradient mask — phosmith LinearMaskLayer twin."""
    h, w = shape[:2]
    p1 = np.array([w * 0.5, 0.0] if p1 is None else p1, np.float32)
    p2 = np.array([w * 0.5, float(h)] if p2 is None else p2, np.float32)
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    d = p2 - p1
    L2 = float(d @ d) + 1e-9
    t = ((xx - p1[0]) * d[0] + (yy - p1[1]) * d[1]) / L2      # 0 at p1, 1 at p2
    lo, hi = 0.5 - feather / 2, 0.5 + feather / 2
    m = smoothstep(lo, hi, t)
    return (1 - m) if invert else m

def mask_sky(rgb):
    """Cheap sky/bright-top mask: high luminance weighted toward the top."""
    h, w = rgb.shape[:2]
    L = luma(rgb)
    yy = np.linspace(1, 0, h)[:, None] * np.ones((1, w), np.float32)
    m = smoothstep(0.55, 0.85, L) * smoothstep(0.1, 0.7, yy)
    return cv2.GaussianBlur(m.astype(np.float32), (0, 0), 8)

# ─────────────────────── local adjustments (Lightroom-ish) ───────────────────────

def _apply_block(rgb, p):
    """Apply a full adjustment block to an RGB float image (0..1). No masking here."""
    out = rgb.copy()
    # exposure (EV stops)
    if p.get("exposure"):
        out *= 2.0 ** p["exposure"]
    # white balance
    if p.get("temperature"):
        k = p["temperature"] / 100.0 * 0.18
        out[..., 0] += k; out[..., 2] -= k
    if p.get("tint"):
        out[..., 1] -= p["tint"] / 100.0 * 0.18
    out = np.clip(out, 0, 1)
    L = luma(out)
    # tone regions
    if p.get("highlights"):
        wgt = smoothstep(0.5, 1.0, L)[..., None]
        out += p["highlights"] / 100.0 * 0.45 * wgt
    if p.get("shadows"):
        wgt = (1 - smoothstep(0.0, 0.55, L))[..., None]
        out += p["shadows"] / 100.0 * 0.45 * wgt
    if p.get("whites"):
        wgt = smoothstep(0.65, 1.0, L)[..., None]
        out += p["whites"] / 100.0 * 0.35 * wgt
    if p.get("blacks"):
        wgt = (1 - smoothstep(0.0, 0.35, L))[..., None]
        out += p["blacks"] / 100.0 * 0.35 * wgt
    out = np.clip(out, 0, 1)
    # contrast (pivot 0.5)
    if p.get("contrast"):
        out = np.clip((out - 0.5) * (1 + p["contrast"] / 100.0) + 0.5, 0, 1)
    # texture / clarity — local mid-frequency contrast (unsharp on luma)
    if p.get("texture"):
        Lf = luma(out)
        base = cv2.GaussianBlur(Lf, (0, 0), 3.0)
        detail = (Lf - base)[..., None]
        out = np.clip(out + p["texture"] / 100.0 * 1.6 * detail, 0, 1)
    # dehaze — contrast+saturation lift in low-contrast areas (neg = add haze)
    if p.get("dehaze"):
        d = p["dehaze"] / 100.0
        mean = cv2.GaussianBlur(out, (0, 0), 25)
        out = np.clip(out + d * 0.5 * (out - mean), 0, 1)       # local contrast
        g = luma(out)[..., None]
        out = np.clip(g + (out - g) * (1 + d * 0.4), 0, 1)      # saturation coupling
    # saturation / vibrance
    if p.get("saturation"):
        g = luma(out)[..., None]
        out = np.clip(g + (out - g) * (1 + p["saturation"] / 100.0), 0, 1)
    if p.get("vibrance"):
        g = luma(out)[..., None]
        sat = np.abs(out - g).max(axis=2, keepdims=True)        # current saturation
        amt = p["vibrance"] / 100.0 * (1 - sat)                 # protect saturated px
        out = np.clip(g + (out - g) * (1 + amt), 0, 1)
    return out

def apply_local(rgb, mask, params, strength=1.0):
    """Blend an adjustment block into rgb, weighted by a feathered mask."""
    adjusted = _apply_block(rgb, params)
    m = np.clip(mask * strength, 0, 1)[..., None]
    return rgb * (1 - m) + adjusted * m

# ─────────────────────── recipes (reproduce the reels) ───────────────────────

def recipe_cat(rgb_u8):
    """@KABWE_PHOTOGRAPHY Lightroom edit: radial-on-subject + linear background."""
    rgb = rgb_u8.astype(np.float32) / 255.0
    h, w = rgb.shape[:2]
    # find subject for the radial centre
    subj = coarse_mask(rgb_u8, "auto")
    ys, xs = np.where(subj > 127)
    if len(xs):
        cx, cy = xs.mean(), ys.mean(); rx, ry = (xs.ptp() or w) * 0.8, (ys.ptp() or h) * 0.8
    else:
        cx, cy, rx, ry = w / 2, h / 2, w * 0.4, h * 0.4
    m_subj = mask_radial(rgb.shape, cx, cy, rx, ry, feather=0.7)
    m_bg = mask_linear(rgb.shape, p1=[w, 0], p2=[0, h], feather=0.9)      # top-right→bottom-left
    masks = [("radial · subject", m_subj), ("linear · background", m_bg)]
    out = apply_local(rgb, m_subj, dict(exposure=-0.13, contrast=9, highlights=-58,
                                        shadows=52, whites=55, saturation=80))
    out = apply_local(out, m_bg, dict(exposure=-0.55, contrast=-80, highlights=-85,
                                      whites=-73, blacks=-15, texture=-26, dehaze=-43))
    return rgb, out, masks

def recipe_landscape(rgb_u8):
    """@KORTAFILMS idea: grade sky / subject / foreground separately."""
    rgb = rgb_u8.astype(np.float32) / 255.0
    h, w = rgb.shape[:2]
    m_sky = mask_sky(rgb)
    m_fg = mask_linear(rgb.shape, p1=[w / 2, h], p2=[w / 2, h * 0.45], feather=0.7)  # bottom up
    m_subj = mask_radial(rgb.shape, w / 2, h * 0.45, w * 0.3, h * 0.35, feather=0.6)
    masks = [("luminance · sky", m_sky), ("radial · subject", m_subj), ("linear · foreground", m_fg)]
    out = apply_local(rgb, m_sky, dict(temperature=-32, saturation=35, contrast=14, dehaze=18))
    out = apply_local(out, m_subj, dict(exposure=0.18, texture=42, contrast=18, whites=20))
    out = apply_local(out, m_fg, dict(temperature=26, saturation=42, shadows=28, exposure=0.1))
    return rgb, out, masks

RECIPES = {"cat": recipe_cat, "landscape": recipe_landscape}

# ─────────────────────── CLI ───────────────────────

def montage(before, after, masks, path):
    H = 360
    def tile(img, label, color=(83, 216, 255)):
        im = (np.clip(img, 0, 1) * 255).astype(np.uint8) if img.dtype != np.uint8 else img
        if im.ndim == 2: im = cv2.cvtColor(im, cv2.COLOR_GRAY2RGB)
        s = H / im.shape[0]; im = cv2.resize(im, (int(im.shape[1] * s), H))
        im = cv2.cvtColor(im, cv2.COLOR_RGB2BGR)
        cv2.rectangle(im, (0, 0), (im.shape[1] - 1, 26), (20, 20, 20), -1)
        cv2.putText(im, label, (8, 18), cv2.FONT_HERSHEY_SIMPLEX, 0.55, color, 1, cv2.LINE_AA)
        return im
    tiles = [tile(before, "BEFORE", (180, 180, 180))]
    for name, m in masks:
        tiles.append(tile(m, name, (120, 200, 120)))
    tiles.append(tile(after, "AFTER", (80, 230, 255)))
    sep = np.full((H, 3, 3), 40, np.uint8)
    row = []
    for t in tiles: row += [t, sep]
    cv2.imwrite(path, np.hstack(row[:-1]))

def main(argv):
    ap = argparse.ArgumentParser(description="Local-adjustment masking (Lightroom style)")
    ap.add_argument("image")
    ap.add_argument("--recipe", default="cat", choices=list(RECIPES))
    ap.add_argument("--out", default="out_local")
    ap.add_argument("--max-side", type=int, default=900)
    args = ap.parse_args(argv)

    rgb_u8 = load_image(args.image, args.max_side)
    print(f"\n  local-edit recipe '{args.recipe}'  ({rgb_u8.shape[1]}×{rgb_u8.shape[0]})", flush=True)
    before, after, masks = RECIPES[args.recipe](rgb_u8)
    os.makedirs(args.out, exist_ok=True)
    _save(args.out, "before.png", (before * 255).astype(np.uint8))
    _save(args.out, "after.png", (np.clip(after, 0, 1) * 255).astype(np.uint8))
    for i, (name, m) in enumerate(masks, 1):
        _save(args.out, f"mask{i}.png", (m * 255).astype(np.uint8))
        print(f"  • mask {i}: {name:<22} coverage {100*(m>0.5).mean():.0f}%", flush=True)
    montage(before, after, masks, os.path.join(args.out, "montage.png"))
    print(f"\n  ✔ before/after + masks saved to {os.path.abspath(args.out)}/  (see montage.png)\n", flush=True)
    return 0

if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
