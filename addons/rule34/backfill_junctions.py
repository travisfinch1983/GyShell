"""One-time migration: backfill watched_tag_posts from existing posts + post_tags data."""
import asyncio
import aiosqlite
from db import DB_PATH, get_db

async def backfill():
    db = await get_db()
    try:
        # Get all watched tags
        cursor = await db.execute("SELECT id, tag_query FROM watched_tags")
        watched = await cursor.fetchall()
        print(f"Found {len(watched)} watched tags to backfill")

        for wt in watched:
            wt_id = wt["id"]
            query = wt["tag_query"]
            terms = [t.strip() for t in query.split() if t.strip()]

            if not terms:
                continue

            # Build query to find posts matching ALL terms via post_tags
            conditions = []
            params = []
            for term in terms:
                conditions.append(
                    "p.id IN (SELECT pt.post_id FROM post_tags pt JOIN tags t ON t.id = pt.tag_id WHERE t.name = ?)"
                )
                params.append(term)

            sql = f"SELECT p.id FROM posts p WHERE {' AND '.join(conditions)}"
            cursor = await db.execute(sql, params)
            rows = await cursor.fetchall()
            post_ids = [r["id"] for r in rows]

            if post_ids:
                await db.executemany(
                    "INSERT OR IGNORE INTO watched_tag_posts (watched_tag_id, post_id) VALUES (?, ?)",
                    [(wt_id, pid) for pid in post_ids],
                )
                print(f"  [{wt_id}] {query}: linked {len(post_ids)} posts")
            else:
                print(f"  [{wt_id}] {query}: no matching posts found")

        await db.commit()
        print("Backfill complete")
    finally:
        await db.close()

if __name__ == "__main__":
    asyncio.run(backfill())
