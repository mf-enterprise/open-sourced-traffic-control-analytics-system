# Speed, counts, and evidence

## What the camera measures

Detection finds vehicles in each image. Tracking associates those detections across frames. Counting records a vehicle once when its track crosses a configured line. The classes are car, bus, truck, motorcycle, and bicycle; labels can be wrong, particularly at night or under occlusion.

Speed requires distance and time. A four-point road calibration maps image coordinates to a measured ground rectangle. Original decoder timestamps provide elapsed time. Without an independent distance scale, the app leaves speed blank. A video alone does not establish the road's physical dimensions.

The speed calculation uses a short window of observed ground-plane positions and robust velocity aggregation. A case export includes the calibration, positions, timestamps, algorithm version, and calculation trace. Recompute an exported case with:

```sh
node scripts/verify-case-speed.mjs case.json
```

Reproducing the calculation establishes internal consistency. It does not validate the surveyed dimensions, vehicle contact points, lens distortion, camera timing, or real-world speed accuracy.

## Missing video and camera movement

The background decoder samples up to 10 frames per source second at a maximum of 1280 × 720. Inference keeps the latest pending frame when processing falls behind. The interface reports analysis rate, sampled-frame drops, source gaps, and frame age.

Large timestamp gaps or rollbacks retire existing tracks. Camera-view checks can suspend counting or speed measurement after movement. Configure new geometry after switching cameras. Third-party live feeds may be delayed, move, or stop without warning.

## Plate reading

Automatic plate suggestions require two matching reads from distinct frames. Small, blurred, distant, obscured, and non-Latin registrations may remain unreadable. Suggestions are unverified text; they are not an owner lookup or a confirmed vehicle identity.

## Case storage

An above-limit observation can create a local draft when calibrated measurement is available. The app records the image hash, measurement trace, settings, and review history. Captures committed to the SQLite outbox can be recovered after restart. Uncommitted frames cannot be recovered.

Saved session revisions can contain overlapping totals. Do not add revision snapshots together. A restart preserves committed history but requires a new camera session and fresh geometry.

Exported ticket drafts are for review. This project has no certified speed accuracy, legal penalty issuance, payment collection, or government procurement approval.
