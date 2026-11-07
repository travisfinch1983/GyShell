#!/usr/bin/env python
"""Does torch.cuda.empty_cache() on one thread fault a step running on ANOTHER card?

Mirrors ComfyUI weight streaming: a weight is allocated and copied on a side stream, read on the
compute stream, and its Python reference is dropped while the compute stream may still be reading.
Card B's thread does only unload-style empty_cache(). Run as its own process: a fault kills only it.

usage: xgpu_flush_repro.py <seconds> <flush: 1|0>   (allocator mode comes from PYTORCH_CUDA_ALLOC_CONF)
"""
import os, sys, threading, time
import torch

secs, flush = float(sys.argv[1]), sys.argv[2] == "1"
A, B = torch.device("cuda:0"), torch.device("cuda:1")
print("alloc conf:", os.environ.get("PYTORCH_CUDA_ALLOC_CONF"), "| flush thread:", flush, "| torch", torch.__version__, flush=True)
stop = threading.Event()
err = []
steps = [0]
flushes = [0]
stage = [""]
N = 4096
host = torch.randn(N, N, dtype=torch.float16).pin_memory()
for d in (A, B):                     # contexts up before any thread races them
    torch.empty(1 << 20, device=d, dtype=torch.uint8).zero_()
    torch.cuda.synchronize(d)


def compute():
    try:
        torch.cuda.set_device(A)
        side = torch.cuda.Stream(device=A)
        main = torch.cuda.current_stream(A)
        x = torch.randn(N, N, device=A, dtype=torch.float16)
        while not stop.is_set():
            ws = []
            for _ in range(6):
                with torch.cuda.stream(side):
                    side.wait_stream(main)
                    ws.append(host.to(A, non_blocking=True))
                main.wait_stream(side)
                for _ in range(6):
                    y = x @ ws[-1]
                # comfy-style: reference dropped with kernels still queued on the compute stream
                ws.pop()
                del y
            steps[0] += 1
            if steps[0] % 8 == 0:
                torch.cuda.synchronize(A)
        torch.cuda.synchronize(A)
    except Exception as e:  # noqa: BLE001
        err.append(("compute", repr(e)[:160]))
        stop.set()


def flusher():
    try:
        torch.cuda.set_device(B)
        while not stop.is_set():
            stage[0] = "alloc"
            t = torch.empty(64 << 20, device=B, dtype=torch.uint8)
            del t
            stage[0] = "empty_cache"
            torch.cuda.empty_cache()
            flushes[0] += 1
            time.sleep(0.002)
    except Exception as e:  # noqa: BLE001
        import traceback; traceback.print_exc()
        err.append(("flusher", stage[0], repr(e)[:160]))
        stop.set()


ts = [threading.Thread(target=compute)]
if flush:
    ts.append(threading.Thread(target=flusher))
t0 = time.time()
for t in ts:
    t.start()
while time.time() - t0 < secs and not stop.is_set():
    time.sleep(0.1)
stop.set()
for t in ts:
    t.join(20)
print(f"RESULT {'FAULT' if err else 'clean'} after {time.time() - t0:.1f}s steps={steps[0]} flushes={flushes[0]} {err}", flush=True)
os._exit(0)
