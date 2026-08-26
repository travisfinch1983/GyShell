// Parse LIVE backend responses through the zod schemas. If these disagree, the contract is a lie.
import { z } from "/opt/ai-lab/node_modules/zod/index.js"
const B = "http://127.0.0.1:17890/api/fleet"
const get = async (p) => (await fetch(B + p)).json()

const vis = z.enum(["private","public"])
const att = z.object({attachment_id:z.string(),filename:z.string().nullable(),media_type:z.string(),
  kind:z.enum(["document","image","flowchart"]),byte_size:z.number(),sha256:z.string().nullable(),created_at:z.number()})
const rcpt = z.object({recipient:z.string(),state:z.enum(["queued","delivered","woke","acked","failed"]),
  attempts:z.number(),queued_at:z.number().nullable(),delivered_at:z.number().nullable(),
  woke_at:z.number().nullable(),acked_at:z.number().nullable(),
  failure_stage:z.string().nullable(),failure_detail:z.string().nullable()})
const msg = z.object({message_id:z.string(),thread_id:z.string(),seq:z.number(),parent_id:z.string().nullable(),
  sender:z.string(),body:z.string(),kind:z.string(),created_at:z.number(),
  attachments:z.array(att).default([]),receipts:z.array(rcpt).optional()})
const thr = z.object({thread_id:z.string(),subject:z.string().nullable(),kind:z.enum(["dm","post"]),
  category:z.string().nullable(),visibility:vis,participants:z.array(z.string()),message_count:z.number(),
  last_sender:z.string().nullable(),last_snippet:z.string().nullable(),created_at:z.number(),
  updated_at:z.number(),unread_count:z.number().optional()})
const dir = z.object({agent_id:z.string(),display_name:z.string(),kind:z.enum(["claude_code","hermes","user"]),
  endpoint:z.string().nullable(),enabled:z.boolean(),can_broadcast:z.boolean(),can_focused:z.boolean(),
  status:z.string().nullable(),presence_at:z.number().nullable(),turn_count:z.number().nullable()})
const cat = z.object({name:z.string(),description:z.string().nullable(),created_by:z.string().nullable(),
  created_at:z.number(),thread_count:z.number()})
const guard = z.object({enabled:z.boolean(),reason:z.string().nullable(),
  updated_by:z.string().nullable(),updated_at:z.number().nullable()})

let bad = 0
const t = (name, schema, data) => {
  const r = schema.safeParse(data)
  if (r.success) console.log("  OK   " + name)
  else { bad++; console.log("  FAIL " + name); console.log("       " + JSON.stringify(r.error.issues.slice(0,3))) }
}
const feed = await get("/threads?viewer=user&scope=all&limit=5&unread=1")
t("feed envelope", z.object({threads:z.array(thr),has_more:z.boolean(),next_cursor:z.string().nullable()}), feed)
if (feed.threads?.length) {
  const tr = await get("/thread/" + feed.threads[0].thread_id)
  t("thread read", z.object({thread:thr,messages:z.array(msg),has_more:z.boolean(),before_seq:z.number().nullable()}), tr)
}
t("directory", z.object({agents:z.array(dir)}), await get("/directory"))
t("categories", z.object({categories:z.array(cat)}), await get("/categories"))
t("search", z.object({results:z.array(z.object({message_id:z.string(),thread_id:z.string(),seq:z.number(),
  subject:z.string().nullable(),category:z.string().nullable(),sender:z.string(),body:z.string(),created_at:z.number()}))}),
  await get("/search?q=optane"))
t("unread", z.object({unread:z.array(z.object({thread_id:z.string(),subject:z.string().nullable(),unread_count:z.number()}))}),
  await get("/unread?viewer=user"))
t("delivery-guard", guard, await get("/delivery-guard"))
console.log(bad ? `\n  ${bad} SCHEMA MISMATCH(ES)` : "\n  every live response matches its schema")
process.exit(bad?1:0)

// Run against a LIVE backend:  node packages/backend/src/services/Fleet/validate-contract.mjs
// Typecheck proves the TS compiles; only this proves the shapes in feed-contracts.ts match what
// fleetd actually returns. It caught /thread returning participants as a JSON *string* while
// /feed returned an array, and SQLite 0/1 handed out where booleans were declared.
