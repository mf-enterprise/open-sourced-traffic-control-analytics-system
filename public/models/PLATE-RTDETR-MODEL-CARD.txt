---
license: apache-2.0
library_name: transformers
pipeline_tag: object-detection
tags:
  - object-detection
  - license-plate
  - rt-detr
  - rtdetr_v2
  - onnx
  - privacy
  - on-device
base_model: PekingU/rtdetr_v2_r18vd
---

# License-plate detector — RT-DETRv2 (R18), ONNX

On-device **ONNX** object detector that finds **license plates** in photos. A
fine-tune of [`PekingU/rtdetr_v2_r18vd`](https://huggingface.co/PekingU/rtdetr_v2_r18vd)
(Apache-2.0) on the Open Images "Vehicle registration plate" class, exported to a
fixed `1×3×640×640` ONNX graph that runs fully offline with ONNX Runtime.

Built for **KeepItLocal Privacy**, a local-first redaction app, to suggest plate
regions for blur/redaction — nothing leaves the device.

## Intended use & scope

- **Use it for:** locating license-plate bounding boxes for privacy redaction.
- **Suggestion, not a guarantee:** treat each detection as a box a human
  confirms before redacting — like all detectors it can miss or over-fire.
- **Low, well-ranked scores (important):** this single-class fine-tune produces
  *compressed* confidence scores (the top box is typically ~0.10–0.15) but ranks
  them well — the highest-scoring box lands on the real plate **~92%** of the
  time (mean IoU 0.74 on held-out data). **Threshold low (~0.05)** and take the
  top detection(s). This is an RT-DETR single-class trait, not a defect.

## Files

| File | Purpose |
|---|---|
| `plate_rtdetr.onnx` | the detector (fixed 1×3×640×640, ~79 MB) |
| `config.json` | RT-DETRv2 model config (1 class: `license_plate`) |
| `preprocessor_config.json` | the image-processor settings |

## I/O

- **Input** `pixel_values`: `float32[1,3,640,640]`, **RGB**, scaled `×1/255`, **no**
  mean/std normalization.
- **Outputs** `logits`: `[1,300,1]` (raw, apply sigmoid) and `pred_boxes`:
  `[1,300,4]` as `cx,cy,w,h` **normalized** to `[0,1]`.

## Usage (Python, ONNX Runtime)

```bash
pip install onnxruntime pillow numpy
```

```python
import numpy as np, onnxruntime as ort
from PIL import Image

sess = ort.InferenceSession("plate_rtdetr.onnx", providers=["CPUExecutionProvider"])
img = Image.open("car.jpg").convert("RGB")
W, H = img.size
x = (np.asarray(img.resize((640, 640)), np.float32) / 255.0).transpose(2, 0, 1)[None]

logits, boxes = sess.run(None, {"pixel_values": x})     # [1,300,1], [1,300,4]
scores = 1.0 / (1.0 + np.exp(-logits[0, :, 0]))         # sigmoid
keep = scores > 0.05
for (cx, cy, w, h), s in zip(boxes[0][keep], scores[keep]):
    x0, y0 = (cx - w / 2) * W, (cy - h / 2) * H
    x1, y1 = (cx + w / 2) * W, (cy + h / 2) * H
    print(f"plate @ ({x0:.0f},{y0:.0f},{x1:.0f},{y1:.0f})  score={s:.2f}")
```

(RT-DETR is NMS-free; a light NMS on overlapping boxes is optional.)

## Training

Fine-tuned from `PekingU/rtdetr_v2_r18vd` on ~3,000 Open Images plate images
(the box-regression head kept its COCO pretraining; the classification head was
re-initialized for the single `license_plate` class). Trained with the Hugging
Face `transformers` Trainer; early-stopped where held-out loss bottomed (~epoch
8 of a 40-epoch run — later epochs overfit).

## License & attribution

**Apache-2.0**, inherited from the base model.

- Base model: **RT-DETRv2** (`PekingU/rtdetr_v2_r18vd`) — Apache-2.0
- Training data: **Open Images V7**, "Vehicle registration plate" class —
  images CC-BY-2.0 (Flickr), annotations CC-BY-4.0 (Google)
