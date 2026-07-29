"""Immich API client. Only the endpoints the companion needs."""
import httpx
import logging
from pathlib import Path
from typing import Optional
from config import IMMICH_URL, load_immich_key

log = logging.getLogger(__name__)


class Immich:
    def __init__(self, base_url: str = IMMICH_URL, api_key: str | None = None):
        self.base = base_url.rstrip("/")
        self.key = api_key or load_immich_key()
        # Long timeout for asset download/upload; the worker handles its own
        # request scheduling and only one thing happens at a time per worker.
        self.client = httpx.AsyncClient(
            base_url=self.base,
            headers={"x-api-key": self.key, "Accept": "application/json"},
            timeout=httpx.Timeout(60.0, connect=10.0),
            follow_redirects=True,
        )

    async def close(self):
        await self.client.aclose()

    # ---- Discovery ----

    async def server_version(self) -> dict:
        r = await self.client.get("/api/server/version")
        r.raise_for_status()
        return r.json()

    async def me(self) -> dict:
        r = await self.client.get("/api/users/me")
        r.raise_for_status()
        return r.json()

    async def list_tags(self) -> list[dict]:
        r = await self.client.get("/api/tags")
        r.raise_for_status()
        return r.json()

    async def expand_tag(self, tag_id: str, all_tags: list[dict] | None = None) -> list[str]:
        """Return [tag_id] + all descendant tag IDs (recursive via parentId).
        Immich tags are hierarchical; selecting a parent should include its
        children's assets too. Pass `all_tags` to skip the API call if the
        caller already has the tag list cached.
        """
        tags = all_tags if all_tags is not None else await self.list_tags()
        children_by_parent: dict[str, list[str]] = {}
        for t in tags:
            parent = t.get("parentId")
            if parent:
                children_by_parent.setdefault(parent, []).append(t["id"])
        out = [tag_id]
        stack = [tag_id]
        while stack:
            cur = stack.pop()
            for child in children_by_parent.get(cur, []):
                if child not in out:
                    out.append(child)
                    stack.append(child)
        return out

    async def list_all_matching_assets(
        self,
        *,
        tag_ids: list[str] | None = None,
        album_ids: list[str] | None = None,
        page_size: int = 1000,
        concurrency: int = 16,
        with_exif: bool = True,
        with_stacked: bool = False,
    ) -> list[dict]:
        """Paginate all matching assets and return full asset dicts (deduped).

        Immich's search_metadata is AND-semantics across tagIds[]. For OR
        across multiple tags (e.g. parent + descendants), we issue one
        per-tag search and union client-side. Albums + a single-tag filter
        still use the simple path.
        """
        import asyncio

        async def _paginate_one(*, tag_ids=None, album_ids=None) -> list[dict]:
            out: list[dict] = []
            page = 1
            while True:
                res = await self.search_metadata(
                    tag_ids=tag_ids, album_ids=album_ids,
                    page=page, size=page_size, with_exif=with_exif,
                    with_stacked=with_stacked,
                )
                items = res.get("items") or []
                out.extend(items)
                np = res.get("nextPage")
                if not np:
                    break
                try:
                    page = int(np)
                except (TypeError, ValueError):
                    break
            return out

        # Simple cases: album-only, or single-tag
        if album_ids and not tag_ids:
            return await _paginate_one(album_ids=album_ids)
        if tag_ids and len(tag_ids) == 1 and not album_ids:
            return await _paginate_one(tag_ids=tag_ids)

        # Multi-tag union: per-tag in parallel (bounded by `concurrency`)
        if tag_ids:
            sem = asyncio.Semaphore(concurrency)
            async def _one(t):
                async with sem:
                    return await _paginate_one(tag_ids=[t])
            results = await asyncio.gather(*[_one(t) for t in tag_ids],
                                             return_exceptions=True)
            seen = set()
            out: list[dict] = []
            for r in results:
                if isinstance(r, list):
                    for it in r:
                        aid = it.get("id")
                        if aid and aid not in seen:
                            seen.add(aid)
                            out.append(it)
            return out
        return []

    async def list_albums(self) -> list[dict]:
        r = await self.client.get("/api/albums")
        r.raise_for_status()
        return r.json()

    # ---- Search / asset listing ----

    async def search_metadata(
        self,
        *,
        tag_ids: list[str] | None = None,
        album_ids: list[str] | None = None,
        page: int = 1,
        size: int = 100,
        with_exif: bool = False,
        with_stacked: bool = False,
    ) -> dict:
        """POST /api/search/metadata. Returns the assets sub-object directly."""
        body: dict = {"page": page, "size": size, "withExif": with_exif, "withStacked": with_stacked}
        if tag_ids:
            body["tagIds"] = tag_ids
        if album_ids:
            body["albumIds"] = album_ids
        r = await self.client.post("/api/search/metadata", json=body)
        r.raise_for_status()
        data = r.json()
        return data.get("assets", {"items": [], "count": 0, "total": 0, "nextPage": None})

    async def album_info(self, album_id: str) -> dict:
        r = await self.client.get(f"/api/albums/{album_id}")
        r.raise_for_status()
        return r.json()

    async def asset_info(self, asset_id: str) -> dict:
        r = await self.client.get(f"/api/assets/{asset_id}")
        r.raise_for_status()
        return r.json()

    # ---- Download / upload ----

    async def download_original(self, asset_id: str, dest: Path) -> int:
        """Stream the original to `dest`. Returns bytes written."""
        dest.parent.mkdir(parents=True, exist_ok=True)
        n = 0
        async with self.client.stream("GET", f"/api/assets/{asset_id}/original") as r:
            r.raise_for_status()
            with open(dest, "wb") as f:
                async for chunk in r.aiter_bytes(chunk_size=1024 * 1024):
                    f.write(chunk)
                    n += len(chunk)
        return n

    async def upload_asset(
        self,
        src: Path,
        *,
        device_id: str = "upscale-companion",
        device_asset_id: str | None = None,
        file_created_at: str | None = None,
        file_modified_at: str | None = None,
    ) -> dict:
        """POST /api/assets. Returns {id, status} (status: created|replaced|duplicate)."""
        import hashlib, datetime
        sha1 = hashlib.sha1()
        with open(src, "rb") as f:
            for chunk in iter(lambda: f.read(1024 * 1024), b""):
                sha1.update(chunk)
        checksum = sha1.hexdigest()
        if file_created_at is None:
            file_created_at = datetime.datetime.utcfromtimestamp(src.stat().st_mtime).isoformat() + "Z"
        if file_modified_at is None:
            file_modified_at = file_created_at
        if device_asset_id is None:
            device_asset_id = f"{device_id}:{src.name}"
        with open(src, "rb") as f:
            files = {"assetData": (src.name, f, "application/octet-stream")}
            data = {
                "deviceAssetId": device_asset_id,
                "deviceId": device_id,
                "fileCreatedAt": file_created_at,
                "fileModifiedAt": file_modified_at,
            }
            r = await self.client.post(
                "/api/assets",
                files=files,
                data=data,
                headers={"x-immich-checksum": checksum},
            )
            r.raise_for_status()
            return r.json()

    # ---- Asset metadata copy / stacks / tagging ----

    async def copy_asset_metadata(
        self,
        source_id: str,
        target_id: str,
        *,
        albums: bool = True,
        favorite: bool = True,
        rating: bool = True,
        sidecar: bool = True,
        sharedLinks: bool = True,
        stack: bool = False,
    ) -> dict:
        """PUT /api/assets/copy: migrate metadata from source to target."""
        body = {
            "sourceId": source_id,
            "targetId": target_id,
            "albums": albums,
            "favorite": favorite,
            "rating": rating,
            "sidecar": sidecar,
            "sharedLinks": sharedLinks,
            "stack": stack,
        }
        r = await self.client.put("/api/assets/copy", json=body)
        r.raise_for_status()
        return r.json() if r.text else {}

    async def create_stack(self, asset_ids: list[str], primary_asset_id: str) -> dict:
        """POST /api/stacks. Returns the new stack object.

        Note: Immich v2.7.5 ignores `primaryAssetId` on POST -- it sets the
        primary to assetIds[0]. After this call, the caller should also
        update_stack(stack_id, primary_asset_id) to enforce the chosen primary.
        """
        body = {"assetIds": asset_ids, "primaryAssetId": primary_asset_id}
        r = await self.client.post("/api/stacks", json=body)
        r.raise_for_status()
        return r.json()

    async def update_stack(self, stack_id: str, primary_asset_id: str) -> dict:
        """PUT /api/stacks/{id} -- set the stack's primary asset."""
        r = await self.client.put(
            f"/api/stacks/{stack_id}",
            json={"primaryAssetId": primary_asset_id},
        )
        r.raise_for_status()
        return r.json() if r.text else {}

    async def tag_assets(self, tag_id: str, asset_ids: list[str]) -> dict:
        r = await self.client.put(
            f"/api/tags/{tag_id}/assets", json={"ids": asset_ids}
        )
        r.raise_for_status()
        return r.json() if r.text else {}

    async def untag_assets(self, tag_id: str, asset_ids: list[str]) -> dict:
        """Remove a tag from a list of assets."""
        r = await self.client.request(
            "DELETE", f"/api/tags/{tag_id}/assets", json={"ids": asset_ids}
        )
        r.raise_for_status()
        return r.json() if r.text else {}

    async def upsert_tag(self, name: str) -> dict:
        """Find a tag by name (case-sensitive) or create it. Returns the tag dict."""
        tags = await self.list_tags()
        for t in tags:
            if t.get("name") == name and not t.get("parentId"):
                return t
        r = await self.client.post("/api/tags", json={"name": name})
        r.raise_for_status()
        return r.json()

    # ---- Operational ----

    async def job_queue_depth(self) -> dict:
        """Returns waiting/active counts for each job type. Used for backpressure."""
        try:
            r = await self.client.get("/api/jobs")
            r.raise_for_status()
            data = r.json()
            # Shape: {jobName: {queueStatus: {...}, jobCounts: {active, completed, failed, delayed, waiting, paused}}}
            out = {}
            for name, info in data.items():
                counts = info.get("jobCounts", {})
                out[name] = {"waiting": counts.get("waiting", 0), "active": counts.get("active", 0)}
            return out
        except Exception as e:
            log.warning(f"job_queue_depth failed: {e}")
            return {}
