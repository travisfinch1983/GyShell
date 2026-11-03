"""claude1 2026-11-03: RMBG-2.0 (BiRefNet) cutout -> RGBA png, for cluttered real photos where the bundled
rembg/u2net keeps background ghosts. Usage: ailab-rmbg.py <in.jpg> <out.png> [max_side=1536]"""
import os, sys
os.environ.setdefault("CUDA_DEVICE_ORDER", "PCI_BUS_ID")
import torch
from PIL import Image, ImageOps
from torchvision import transforms
from transformers import AutoModelForImageSegmentation
src, dst = sys.argv[1], sys.argv[2]; side = int(sys.argv[3]) if len(sys.argv) > 3 else 1536
m = AutoModelForImageSegmentation.from_pretrained("/imagegen/3d-models/RMBG-2.0", trust_remote_code=True).cuda().eval().half()
tf = transforms.Compose([transforms.Resize((1024, 1024)), transforms.ToTensor(),
                         transforms.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225])])
im = ImageOps.exif_transpose(Image.open(src)).convert("RGB"); im.thumbnail((side, side))
with torch.no_grad():
    p = m(tf(im)[None].cuda().half())[-1].sigmoid()[0, 0].float().cpu()
im.putalpha(transforms.ToPILImage()(p).resize(im.size)); im.save(dst); print("wrote", dst)
