"""Export SlimSAM's prompt encoder + mask decoder to ONNX with BOX prompts.

The browser's SlimSAM (`Xenova/slimsam-77-uniform`) decoder declares no
`input_boxes`, and transformers.js drops inputs a session does not declare, so
every box the editor sent was silently ignored. This export takes boxes the way
Meta's own SAM ONNX export does: a box is two extra points labelled 2 (top-left
corner) and 3 (bottom-right corner). Inputs and outputs keep transformers.js's
names, so `SamModel` drives it unchanged.

One difference from HF's traced graph: a prompt with no box is NOT padded
inside the graph. The caller appends the "not a point" pad (0, 0, label -1),
exactly what HF's encoder does internally when no box is given; a prompt with a
box has no pad, as in HF.

Usage (onnx, onnxruntime, onnxscript importable):
    python scripts/slimsam-onnx/export_decoder.py <out_dir>
writes <out_dir>/onnx/prompt_encoder_mask_decoder{,_quantized}.onnx and checks
both against PyTorch SamModel on points-only and box prompts.
"""

from __future__ import annotations

import os
import sys

import numpy as np
import torch
from transformers import SamModel

MODEL_ID = "nielsr/slimsam-77-uniform"


class PromptDecoder(torch.nn.Module):
    def __init__(self, sam: SamModel):
        super().__init__()
        self.pe = sam.prompt_encoder
        self.md = sam.mask_decoder

    def forward(self, input_points, input_labels, image_embeddings, image_positional_embeddings):
        pe = self.pe
        # HF _embed_points / _embed_boxes, with box corners as labels 2 and 3.
        size = (pe.input_image_size, pe.input_image_size)
        emb = pe.shared_embedding(input_points + 0.5, size)
        lab = input_labels[..., None]
        emb = torch.where(lab == -1, pe.not_a_point_embed.weight, emb)
        emb = torch.where(lab != -10, emb, torch.zeros_like(emb))
        for k in range(4):
            emb = torch.where(lab == k, emb + pe.point_embed[k].weight[None, None, :, :], emb)
        dense = pe.no_mask_embed.weight.reshape(1, -1, 1, 1).expand(
            image_embeddings.shape[0], -1, pe.image_embedding_size[0], pe.image_embedding_size[1])
        masks, iou = self.md(
            image_embeddings=image_embeddings,
            image_positional_embeddings=image_positional_embeddings,
            sparse_prompt_embeddings=emb,
            dense_prompt_embeddings=dense,
            multimask_output=True,
        )
        return iou, masks


def main(out_dir: str) -> None:
    import onnxruntime as ort
    from onnxruntime.quantization import QuantType, quantize_dynamic

    os.makedirs(os.path.join(out_dir, "onnx"), exist_ok=True)
    fp32 = os.path.join(out_dir, "onnx", "prompt_encoder_mask_decoder.onnx")
    q8 = os.path.join(out_dir, "onnx", "prompt_encoder_mask_decoder_quantized.onnx")

    sam = SamModel.from_pretrained(MODEL_ID).eval()
    dec = PromptDecoder(sam).eval()
    torch.manual_seed(0)
    emb = torch.randn(1, 256, 64, 64)
    pos = sam.get_image_wide_positional_embeddings().detach()
    pts = torch.tensor([[[[400.0, 300.0], [0.0, 0.0]]]])
    lab = torch.tensor([[[1, -1]]], dtype=torch.int64)
    torch.onnx.export(
        dec, (pts, lab, emb, pos), fp32,
        input_names=["input_points", "input_labels", "image_embeddings", "image_positional_embeddings"],
        output_names=["iou_scores", "pred_masks"],
        dynamic_axes={
            "input_points": {0: "batch_size", 1: "point_batch_size", 2: "nb_points_per_image"},
            "input_labels": {0: "batch_size", 1: "point_batch_size", 2: "nb_points_per_image"},
            "image_embeddings": {0: "batch_size"},
            "image_positional_embeddings": {0: "batch_size"},
            "iou_scores": {0: "batch_size", 1: "point_batch_size"},
            "pred_masks": {0: "batch_size", 1: "point_batch_size"},
        },
        opset_version=17,
        dynamo=False,
    )
    quantize_dynamic(fp32, q8, weight_type=QuantType.QUInt8)

    # Check against PyTorch SamModel on a real-looking embedding.
    from PIL import Image, ImageDraw
    from transformers import SamProcessor

    proc = SamProcessor.from_pretrained(MODEL_ID)
    img = Image.new("RGB", (1024, 768), (122, 130, 140))
    d = ImageDraw.Draw(img)
    d.ellipse((150, 250, 450, 550), fill=(225, 30, 30))
    d.rectangle((600, 150, 900, 450), fill=(30, 60, 220))
    with torch.inference_mode():
        emb = sam.get_image_embeddings(proc(images=img, return_tensors="pt")["pixel_values"])
        pos = sam.get_image_wide_positional_embeddings()
    # Coordinates already in the 1024 frame (the image's long side is 1024).
    cases = {
        "click (points only)": dict(points=[[300, 400]], labels=[1], box=None),
        "two points": dict(points=[[300, 400], [750, 300]], labels=[1, 0], box=None),
        "box + point": dict(points=[[300, 400]], labels=[1], box=[100, 200, 950, 600]),
        "box + 3 points": dict(points=[[300, 400], [750, 300], [200, 300]], labels=[1, 1, 1], box=[100, 120, 950, 600]),
    }
    worst = 0.0
    for path in (fp32, q8):
        sess = ort.InferenceSession(path, providers=["CPUExecutionProvider"])
        for name, c in cases.items():
            p = torch.tensor([[c["points"]]], dtype=torch.float)
            l = torch.tensor([[c["labels"]]], dtype=torch.int64)
            with torch.inference_mode():
                ref = sam(image_embeddings=emb, input_points=p, input_labels=l,
                          input_boxes=None if c["box"] is None else torch.tensor([[c["box"]]], dtype=torch.float),
                          multimask_output=True)
            if c["box"] is None:
                xp = torch.cat([p, torch.zeros(1, 1, 1, 2)], dim=2)
                xl = torch.cat([l, -torch.ones(1, 1, 1, dtype=torch.int64)], dim=2)
            else:
                b = c["box"]
                xp = torch.cat([p, torch.tensor([[[[b[0], b[1]], [b[2], b[3]]]]], dtype=torch.float)], dim=2)
                xl = torch.cat([l, torch.tensor([[[2, 3]]], dtype=torch.int64)], dim=2)
            iou, masks = sess.run(None, {
                "input_points": xp.numpy(), "input_labels": xl.numpy(),
                "image_embeddings": emb.numpy(), "image_positional_embeddings": pos.numpy(),
            })
            ref_m = ref.pred_masks.numpy() > 0
            agree = float((ref_m == (masks > 0)).mean())
            d_iou = float(np.abs(ref.iou_scores.numpy() - iou).max())
            tag = "fp32" if path == fp32 else "q8"
            print(f"{tag:5} {name:22} mask agreement {agree:.5f}  iou diff {d_iou:.4f}")
            if path == fp32:
                worst = max(worst, 1 - agree)
    if worst > 1e-4:
        sys.exit(f"fp32 export disagrees with PyTorch ({worst:.5f} of mask pixels)")
    print("ok", fp32, os.path.getsize(fp32), q8, os.path.getsize(q8))


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "slimsam-boxes")
