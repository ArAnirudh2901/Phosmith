#!/usr/bin/env python3
"""
Phosmith Mask Lab — real masking pipeline (Python).

Implements the Executive Summary pipeline with REAL, already-installed models:

    image + (prompt) -> COARSE MASK   (rembg / GrabCut / saliency)
                     -> TRIMAP        (OpenCV erode/dilate — Matte-Anything style)
                     -> FINE MATTE    (PyMatting closed-form / KNN — the doc's matting)
                     -> REFINE        (hole-fill + despeckle + global refinements)
                     -> DECONTAMINATE (PyMatting ML foreground estimation)
                     -> CUT-OUT       (RGBA)

Two interfaces, same pipeline:
    CLI :  python mask_lab.py photo.jpg --out out/            # works now, zero extra installs
    UI  :  python mask_lab.py --ui                            # basic Gradio app (pip install gradio)

Drop-in upgrade path (see README): swap COARSE->SAM 3.1, FINE MATTE->ZIM/ViTMatte.
Run with the segment service venv so the heavy deps resolve:
    ../../services/segment/.venv/bin/python mask_lab.py photo.jpg --out out/
"""

import os
import sys
import time
import argparse
import numpy as np
import cv2

# ─────────────────────────── small helpers ───────────────────────────

def _disk(r: int):
    r = max(1, int(r))
    return cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r + 1, 2 * r + 1))

def _t():
    return time.perf_counter()

def log(stage, dt=None, extra=""):
    msg = f"  • {stage:<22}"
    if dt is not None:
        msg += f"{dt*1000:7.0f} ms"
    if extra:
        msg += f"   {extra}"
    print(msg, flush=True)

def load_image(path, max_side=900):
    """Load RGB uint8, downscaled so the longest edge <= max_side (matting speed)."""
    img = cv2.imread(path, cv2.IMREAD_COLOR)
    if img is None:
        raise FileNotFoundError(f"could not read image: {path}")
    img = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
    h, w = img.shape[:2]
    s = min(1.0, max_side / max(h, w))
    if s < 1.0:
        img = cv2.resize(img, (round(w * s), round(h * s)), interpolation=cv2.INTER_AREA)
    return img

# ─────────────────────── stage 1 · coarse mask (SAM stand-ins) ───────────────────────

def coarse_rembg(rgb):
    """Real subject segmentation with rembg (the model the FastAPI service already uses)."""
    from rembg import remove, new_session
    model = os.environ.get("REMBG_MODEL", "u2net")
    sess = new_session(model)
    from PIL import Image
    out = remove(Image.fromarray(rgb), session=sess, only_mask=True, post_process_mask=True)
    return np.asarray(out.convert("L"), dtype=np.uint8)

def coarse_grabcut(rgb, box=None, iters=5):
    """No-download coarse mask via GrabCut. box = (x, y, w, h) in pixels, else centre 88%."""
    h, w = rgb.shape[:2]
    mask = np.zeros((h, w), np.uint8)
    if box is None:
        m = int(0.06 * min(h, w))
        box = (m, m, w - 2 * m, h - 2 * m)
    bgd = np.zeros((1, 65), np.float64)
    fgd = np.zeros((1, 65), np.float64)
    cv2.grabCut(cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR), mask, tuple(box), bgd, fgd, iters, cv2.GC_INIT_WITH_RECT)
    out = np.where((mask == cv2.GC_FGD) | (mask == cv2.GC_PR_FGD), 255, 0).astype(np.uint8)
    return out

def coarse_saliency(rgb):
    """Pure-numpy saliency: border-colour distance + centre prior, largest blob, holes filled."""
    from scipy import ndimage
    h, w = rgb.shape[:2]
    t = max(3, int(0.045 * min(h, w)))
    border = np.concatenate([
        rgb[:t].reshape(-1, 3), rgb[-t:].reshape(-1, 3),
        rgb[:, :t].reshape(-1, 3), rgb[:, -t:].reshape(-1, 3)])
    bcol = border.mean(0)
    d = np.linalg.norm(rgb.astype(np.float32) - bcol, axis=2) / 441.0
    yy, xx = np.mgrid[0:h, 0:w]
    cx, cy, sx, sy = w / 2, h * 0.46, w * 0.44, h * 0.48
    center = np.exp(-(((xx - cx) / sx) ** 2 + ((yy - cy) / sy) ** 2) / 2)
    score = d * 0.78 + center * 0.34
    m = (score > score.mean() * 1.05).astype(np.uint8)
    lbl, n = ndimage.label(m)
    if n:
        big = 1 + np.argmax(ndimage.sum(np.ones_like(lbl), lbl, range(1, n + 1)))
        m = (lbl == big).astype(np.uint8)
    m = ndimage.binary_fill_holes(m).astype(np.uint8) * 255
    return m

def coarse_mask(rgb, method="auto", box=None):
    if method in ("auto", "rembg"):
        try:
            return coarse_rembg(rgb)
        except Exception as e:
            if method == "rembg":
                raise
            print(f"  ! rembg unavailable ({e}); falling back to GrabCut", flush=True)
            return coarse_grabcut(rgb, box)
    if method == "grabcut":
        return coarse_grabcut(rgb, box)
    if method == "saliency":
        return coarse_saliency(rgb)
    raise ValueError(f"unknown coarse method: {method}")

# ─────────────────────── stage 2 · trimap (Matte-Anything style) ───────────────────────

def make_trimap(mask, erode_px=10, dilate_px=12):
    """erode->sure-FG (1.0), dilate->sure-BG outside (0.0), band between = unknown (0.5)."""
    m = (mask > 127).astype(np.uint8) * 255
    fg = cv2.erode(m, _disk(erode_px))
    near = cv2.dilate(m, _disk(dilate_px))
    tri = np.full(m.shape, 0.5, np.float32)
    tri[near == 0] = 0.0
    tri[fg == 255] = 1.0
    return tri

# ─────────────────────── stage 3 · fine matte ───────────────────────

def _guided_filter(I, p, r=8, eps=1e-4):
    I = I.astype(np.float32); p = p.astype(np.float32)
    k = (r, r)
    mI = cv2.boxFilter(I, -1, k); mp = cv2.boxFilter(p, -1, k)
    mIp = cv2.boxFilter(I * p, -1, k); mII = cv2.boxFilter(I * I, -1, k)
    a = (mIp - mI * mp) / (mII - mI * mI + eps)
    b = mp - a * mI
    return cv2.boxFilter(a, -1, k) * I + cv2.boxFilter(b, -1, k)

def fine_matte(rgb, tri, method="pymatting_cf"):
    """
    pymatting_cf  -> closed-form matting (Levin et al.)  [the document's solver]
    pymatting_knn -> KNN matting (faster)
    guided        -> edge-aware guided-filter matte (no extra deps, fast fallback)
    """
    if method.startswith("pymatting"):
        try:
            from pymatting import estimate_alpha_cf, estimate_alpha_knn
            img = rgb.astype(np.float64) / 255.0
            fn = estimate_alpha_knn if "knn" in method else estimate_alpha_cf
            alpha = fn(img, tri.astype(np.float64))
            return np.clip(alpha, 0, 1).astype(np.float32)
        except Exception as e:
            print(f"  ! pymatting unavailable ({e}); using guided-filter matte", flush=True)
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY).astype(np.float32) / 255.0
    q = _guided_filter(gray, tri, r=8, eps=1e-4)
    a = np.where(tri == 1.0, 1.0, np.where(tri == 0.0, 0.0, np.clip(q, 0, 1)))
    return a.astype(np.float32)

# ─────────────────────── stage 4 · refine + global refinements ───────────────────────

def pymatting_cleanup(alpha):
    """Fill pinholes / remove specks in the solid core (PyMatting `cutout` spirit)."""
    from scipy import ndimage
    solid = alpha > 0.6
    filled = ndimage.binary_fill_holes(solid)
    pin = filled & ~solid
    a = alpha.copy()
    a[pin] = np.maximum(a[pin], 0.92)
    # despeckle: drop tiny disconnected fg blobs
    lbl, n = ndimage.label(filled)
    if n > 1:
        sizes = ndimage.sum(np.ones_like(lbl), lbl, range(1, n + 1))
        keep = 1 + int(np.argmax(sizes))
        small = (lbl != keep) & (lbl != 0)
        a[small] = np.minimum(a[small], 0.0)
    return a.astype(np.float32)

def global_refine(alpha, smooth=0, feather=0.0, contrast=0, shift=0):
    a = alpha.copy()
    if shift != 0:
        k = _disk(abs(int(shift)))
        a = cv2.erode(a, k) if shift < 0 else cv2.dilate(a, k)
    if smooth > 0:
        a = cv2.GaussianBlur(a, (0, 0), smooth * 0.5)
        a = np.clip((a - 0.5) * 1.4 + 0.5, 0, 1)
    if contrast > 0:
        g = 1 + contrast / 100.0 * 8
        a = np.clip((a - 0.5) * g + 0.5, 0, 1)
    if feather > 0:
        a = cv2.GaussianBlur(a, (0, 0), float(feather))
    return a.astype(np.float32)

# ─────────────────────── stage 5 · decontaminate + composite ───────────────────────

def foreground_colors(rgb, alpha):
    """Real colour unmixing: PyMatting ML foreground estimation (kills the background fringe)."""
    try:
        from pymatting import estimate_foreground_ml
        fg = estimate_foreground_ml(rgb.astype(np.float64) / 255.0, alpha.astype(np.float64))
        return (np.clip(fg, 0, 1) * 255).astype(np.uint8)
    except Exception as e:
        print(f"  ! foreground estimation unavailable ({e}); using source colours", flush=True)
        return rgb

def cutout_rgba(fg_rgb, alpha):
    return np.dstack([fg_rgb, (np.clip(alpha, 0, 1) * 255).astype(np.uint8)])

# ─────────────────────── orchestrator ───────────────────────

def run_pipeline(rgb, coarse="auto", matte="pymatting_cf", erode=10, dilate=12,
                 smooth=0, feather=0.0, contrast=0, shift=0, decontaminate=True,
                 cleanup=True, box=None, verbose=True):
    out = {}
    if verbose:
        print(f"\n  pipeline  coarse={coarse}  matte={matte}  trimap=±{erode}/{dilate}px", flush=True)

    t = _t(); m = coarse_mask(rgb, coarse, box);              out["coarse"] = m
    if verbose: log("1 coarse mask", _t() - t, f"{100*(m>127).mean():.0f}% fg")

    t = _t(); tri = make_trimap(m, erode, dilate);            out["trimap"] = tri
    if verbose: log("2 trimap", _t() - t, f"{100*(tri==0.5).mean():.0f}% unknown")

    t = _t(); a = fine_matte(rgb, tri, matte);                out["matte"] = a
    if verbose: log("3 fine matte", _t() - t)

    t = _t()
    if cleanup: a = pymatting_cleanup(a)
    a = global_refine(a, smooth, feather, contrast, shift);   out["alpha"] = a
    if verbose: log("4 refine", _t() - t)

    t = _t()
    fg = foreground_colors(rgb, a) if decontaminate else rgb; out["fg"] = fg
    out["cutout"] = cutout_rgba(fg, a)
    if verbose: log("5 decontaminate+composite", _t() - t, f"{100*(a>0.5).mean():.0f}% kept")
    return out

# ─────────────────────── CLI ───────────────────────

def _save(out_dir, name, arr):
    os.makedirs(out_dir, exist_ok=True)
    p = os.path.join(out_dir, name)
    if arr.ndim == 2:
        cv2.imwrite(p, (arr * 255).astype(np.uint8) if arr.dtype != np.uint8 else arr)
    elif arr.shape[2] == 4:
        cv2.imwrite(p, cv2.cvtColor(arr, cv2.COLOR_RGBA2BGRA))
    else:
        cv2.imwrite(p, cv2.cvtColor(arr, cv2.COLOR_RGB2BGR))
    return p

def cli(argv):
    ap = argparse.ArgumentParser(description="Phosmith Mask Lab — real masking pipeline")
    ap.add_argument("image", nargs="?", help="input image")
    ap.add_argument("--out", default="out", help="output directory")
    ap.add_argument("--coarse", default="auto", choices=["auto", "rembg", "grabcut", "saliency"])
    ap.add_argument("--matte", default="pymatting_cf", choices=["pymatting_cf", "pymatting_knn", "guided"])
    ap.add_argument("--erode", type=int, default=10)
    ap.add_argument("--dilate", type=int, default=12)
    ap.add_argument("--smooth", type=int, default=0)
    ap.add_argument("--feather", type=float, default=0.0)
    ap.add_argument("--contrast", type=int, default=0)
    ap.add_argument("--shift", type=int, default=0)
    ap.add_argument("--no-decon", action="store_true", help="skip colour decontamination")
    ap.add_argument("--max-side", type=int, default=900)
    ap.add_argument("--ui", action="store_true", help="launch the basic Gradio interface")
    args = ap.parse_args(argv)

    if args.ui:
        return launch_ui()
    if not args.image:
        ap.error("provide an image, or use --ui")

    rgb = load_image(args.image, args.max_side)
    res = run_pipeline(rgb, coarse=args.coarse, matte=args.matte, erode=args.erode,
                       dilate=args.dilate, smooth=args.smooth, feather=args.feather,
                       contrast=args.contrast, shift=args.shift, decontaminate=not args.no_decon)
    # save stages
    tri_vis = (res["trimap"] * 255).astype(np.uint8)
    on_white = (res["fg"].astype(np.float32) * res["alpha"][..., None] +
                255 * (1 - res["alpha"][..., None])).astype(np.uint8)
    _save(args.out, "1_coarse.png", res["coarse"])
    _save(args.out, "2_trimap.png", tri_vis)
    _save(args.out, "3_matte.png", res["alpha"])
    _save(args.out, "4_cutout.png", res["cutout"])
    _save(args.out, "5_on_white.png", on_white)
    print(f"\n  ✔ saved 5 stages to {os.path.abspath(args.out)}/\n", flush=True)
    return 0

# ─────────────────────── basic Gradio UI ───────────────────────

def launch_ui():
    try:
        import gradio as gr
    except ImportError:
        print("\nThe UI needs Gradio. Install it into the service venv:\n"
              "    ../../services/segment/.venv/bin/pip install gradio\n"
              "…then re-run:  python mask_lab.py --ui\n"
              "(The CLI works without Gradio:  python mask_lab.py photo.jpg --out out/)\n")
        return 1

    def process(image, coarse, matte, erode, dilate, smooth, feather, contrast, shift, decon, maxside):
        if image is None:
            return None, None, "Upload an image first."
        h, w = image.shape[:2]
        s = min(1.0, maxside / max(h, w))
        if s < 1.0:
            image = cv2.resize(image, (round(w * s), round(h * s)), interpolation=cv2.INTER_AREA)
        res = run_pipeline(image, coarse=coarse, matte=matte, erode=int(erode), dilate=int(dilate),
                           smooth=int(smooth), feather=float(feather), contrast=int(contrast),
                           shift=int(shift), decontaminate=decon, verbose=True)
        gallery = [
            (res["coarse"], "1 · coarse (SAM stand-in)"),
            ((res["trimap"] * 255).astype(np.uint8), "2 · trimap"),
            ((res["alpha"] * 255).astype(np.uint8), "3 · alpha matte"),
        ]
        info = (f"coarse={coarse} · matte={matte} · "
                f"{100*(res['alpha']>0.5).mean():.0f}% kept · {res['cutout'].shape[1]}×{res['cutout'].shape[0]}")
        return res["cutout"], gallery, info

    with gr.Blocks(title="Phosmith Mask Lab", theme=gr.themes.Base()) as demo:
        gr.Markdown("## Phosmith · Mask Lab\nReal pipeline: **coarse → trimap → PyMatting → refine → cut-out**")
        with gr.Row():
            with gr.Column(scale=1):
                image = gr.Image(type="numpy", label="Image", height=320)
                coarse = gr.Dropdown(["auto", "rembg", "grabcut", "saliency"], value="auto", label="Coarse mask (SAM stand-in)")
                matte = gr.Dropdown(["pymatting_cf", "pymatting_knn", "guided"], value="pymatting_cf", label="Matting model")
                with gr.Row():
                    erode = gr.Slider(1, 40, 10, step=1, label="Trimap erode")
                    dilate = gr.Slider(1, 40, 12, step=1, label="Trimap dilate")
                with gr.Row():
                    smooth = gr.Slider(0, 30, 0, step=1, label="Smooth")
                    feather = gr.Slider(0, 30, 0, step=0.5, label="Feather")
                with gr.Row():
                    contrast = gr.Slider(0, 100, 0, step=1, label="Contrast")
                    shift = gr.Slider(-30, 30, 0, step=1, label="Shift edge")
                decon = gr.Checkbox(True, label="Decontaminate colours (PyMatting FG)")
                maxside = gr.Slider(400, 1400, 900, step=50, label="Working resolution (max side)")
                run = gr.Button("Run masking", variant="primary")
            with gr.Column(scale=1):
                out = gr.Image(type="numpy", label="Cut-out (RGBA)", height=320)
                gallery = gr.Gallery(label="Pipeline stages", columns=3, height=160)
                info = gr.Markdown()
        run.click(process,
                  [image, coarse, matte, erode, dilate, smooth, feather, contrast, shift, decon, maxside],
                  [out, gallery, info])
    demo.launch(inbrowser=True)
    return 0

if __name__ == "__main__":
    sys.exit(cli(sys.argv[1:]))
