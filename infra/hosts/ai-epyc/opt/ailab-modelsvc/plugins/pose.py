"""Pose plugin: serves OpenPose, DWPose and SDPose (kind "pose", files under /imagegen/pose) from the image model service, so
they are placed per GPU, cached and queued like everything else instead of loading inside whichever ComfyUI ran the node.
  /imagegen/pose/openpose/  body_pose_model.pth (+ hand_pose_model.pth, facenet.pth beside it)
  /imagegen/pose/dwpose/    dw-ll_ucoco_384_bs5.torchscript.pt (+ yolox_l.torchscript.pt beside it)
  /imagegen/pose/sdpose/    sdpose_wholebody_fp16.safetensors
Only the main file of each family is listed; helpers load from their folder. DWPose uses the TorchScript files: they take a torch
device, so the card placement picks is the card it runs on (ONNX Runtime sessions don't follow it).

HTTP:   POST /v1/pose {model, images: [b64 png], resolution=512, body=true, hand=true, face=true, gpu?}
          -> {results: [{image: b64 png, keypoints: {...OpenPose frame...}}]}
Socket: pose_estimate {model, images: uint8 [B,H,W,3], resolution, body, hand, face, gpu?} -> {results: [{image: uint8 [H,W,3], keypoints}]}
"""
import base64
import gc
import importlib
import io
import json
import os
import sys

import numpy as np
from PIL import Image

ROOT = "/imagegen/pose"
AUX = "/opt/comfyui/custom_nodes/comfyui_controlnet_aux/src"
HELPERS = r"(^|[/\\])(yolox[^/\\]*|hand_pose_model[^/\\]*|facenet[^/\\]*)$"


def family(name):
    b = os.path.basename(name).lower()
    if "sdpose" in b:
        return "sdpose"
    if "dw-" in b or "dwpose" in b:
        return "dwpose"
    if "body_pose" in b or "openpose" in b:
        return "openpose"
    raise ValueError(f"don't know how to load pose model {name}")


def _aux():
    if AUX not in sys.path:
        sys.path.append(AUX)


def _need(path):
    if not os.path.exists(path):
        raise FileNotFoundError(f"pose helper file missing: {path}")
    return path


def _plain(x):
    return json.loads(json.dumps(x, default=float))


def register(api):
    torch = api.torch
    import folder_paths
    folder_paths.add_model_folder_path("pose", ROOT)

    def load(path, device):
        fam = family(path)
        if fam == "dwpose":
            _aux()
            from custom_controlnet_aux.dwpose import DwposeDetector
            from custom_controlnet_aux.dwpose.wholebody import Wholebody
            det = _need(f"{ROOT}/dwpose/yolox_l.torchscript.pt")
            return {"family": fam, "model": DwposeDetector(Wholebody(det, path, torchscript_device=device))}
        if fam == "openpose":
            _aux()
            from custom_controlnet_aux.open_pose import Body, Face, Hand, OpenposeDetector
            d = OpenposeDetector(Body(path), Hand(_need(f"{ROOT}/openpose/hand_pose_model.pth")), Face(_need(f"{ROOT}/openpose/facenet.pth")))
            return {"family": fam, "model": d.to(device)}
        import comfy.model_management as mm
        import comfy.sd
        out = comfy.sd.load_checkpoint_guess_config(path, output_vae=True, output_clip=False, model_options={"load_device": device})
        model, vae = out[0], out[2]
        if vae is None or not hasattr(model.model.diffusion_model, "heatmap_head"):
            raise ValueError(f"{path} is not an SDPose checkpoint (no VAE or no heatmap head)")
        vae.device = device
        vae.patcher.load_device = device
        mm.load_models_gpu([model, vae.patcher], force_full_load=True)
        return {"family": fam, "model": model, "vae": vae}

    def free(obj):
        if obj.get("family") == "sdpose":
            import comfy.model_management as mm
            mine = (obj["model"], obj["vae"].patcher)
            for lm in list(mm.current_loaded_models):
                if lm.model in mine:
                    lm.model_unload()
                    mm.current_loaded_models.remove(lm)
        obj.clear()
        gc.collect()
        torch.cuda.empty_cache()

    # SDPose runs a diffusion pass and needs the most room of the three; quota 0 = disk / Optane tier only, no RAM taken from other kinds
    api.add_kind("pose", ["pose"], load, unload=free, quota_gb=(0, 0), work_gb=2, exclude=HELPERS)

    def _sdpose(obj, im, body, hand, face):
        import comfy.sample  # noqa: F401  (nodes_sdpose uses it without importing it)
        n = importlib.import_module("comfy_extras.nodes_sdpose")
        t = torch.from_numpy(np.ascontiguousarray(im)).float().div_(255).unsqueeze(0)
        kp = n.SDPoseKeypointExtractor.execute(obj["model"], obj["vae"], t, 1)[0]
        drawn = n.SDPoseDrawKeypoints.execute(kp, body, hand, face, False, 4, 3, 0.3, True)[0]
        a = (drawn[0].clamp(0, 1) * 255).round().to(torch.uint8).cpu().numpy()
        return a, (kp[0] if isinstance(kp, list) and kp else kp)

    def estimate(name, images, resolution=512, body=True, hand=True, face=True, gpu=None, who="pose"):
        """images: list of uint8 HxWx3 RGB -> list of {image: uint8 HxWx3, keypoints: OpenPose frame dict}"""
        res = int(resolution)

        def go(obj, device):
            out = []
            for im in images:
                if obj["family"] == "sdpose":
                    a, kp = _sdpose(obj, im, body, hand, face)
                else:
                    a, kp = obj["model"](im, detect_resolution=res, include_body=body, include_hand=hand, include_face=face,
                                         image_and_json=True, output_type="np", upscale_method="INTER_CUBIC")
                out.append({"image": np.ascontiguousarray(a), "keypoints": _plain(kp)})
            return out
        return api.run("pose", name, go, gpu=gpu, who=who)

    def http_pose(body, query):
        imgs = [np.asarray(Image.open(io.BytesIO(base64.b64decode(b))).convert("RGB")) for b in body["images"]]
        rs = estimate(body["model"], imgs, body.get("resolution", 512), body.get("body", True), body.get("hand", True), body.get("face", True),
                      body.get("gpu"), who="http pose")
        for r in rs:
            b = io.BytesIO()
            Image.fromarray(r["image"]).save(b, "PNG")
            r["image"] = base64.b64encode(b.getvalue()).decode()
        return {"results": rs}

    api.add_route("POST", "/v1/pose", http_pose)

    def op_pose(sess, m):
        imgs = m["images"]
        imgs = [imgs[i].numpy() for i in range(imgs.shape[0])]
        rs = estimate(m["model"], imgs, m.get("resolution", 512), m.get("body", True), m.get("hand", True), m.get("face", True), m.get("gpu"),
                      who=f"{sess.who} pose")
        for r in rs:
            r["image"] = torch.from_numpy(r["image"])
        return {"results": rs}

    api.add_op("pose_estimate", op_pose)
