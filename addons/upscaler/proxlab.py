"""ProxLab API client. Right now just GPU inventory; could expand later."""
import httpx
import logging
import db

log = logging.getLogger(__name__)


async def fetch_agent_gpus() -> list[dict]:
    """Hit proxlab /api/ai/agent-gpus and return a flat list shaped for the
    companion DB:
      [{ agent_name, cuda_index, agent_ip, container_name, friendly_name, vram_mb }, ...]

    On failure, returns an empty list and logs. Cached rows in DB are not
    cleared — the UI can keep showing them with a 'stale' indicator.
    """
    base = db.get_setting("proxlab_url", "")
    if not base:
        return []
    base = base.rstrip("/")
    url = f"{base}/api/ai/agent-gpus"
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(10.0, connect=5.0)) as c:
            r = await c.get(url)
            r.raise_for_status()
            data = r.json()
    except Exception as e:
        log.warning(f"proxlab fetch failed: {e}")
        return []
    out = []
    for a in data.get("agents", []):
        agent_name = a.get("host_node") or a.get("name")
        for g in a.get("gpus", []):
            out.append({
                "agent_name": agent_name,
                "cuda_index": int(g["cuda_index"]),
                "agent_ip": a.get("ip"),
                "container_name": a.get("name"),
                "friendly_name": g.get("name"),
                "vram_mb": int(g.get("vram_mb") or 0),
            })
    return out


async def refresh_inventory() -> int:
    """Fetch + upsert into DB. Returns count of GPUs cached."""
    snapshot = await fetch_agent_gpus()
    if snapshot:
        db.upsert_gpu_inventory(snapshot)
    return len(snapshot)
