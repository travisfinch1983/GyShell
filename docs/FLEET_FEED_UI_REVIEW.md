# Fleet Feed phase 2 — UI build notes + contract review (Fable, 2026-08-26)

Branch: `fable/fleet-feed-v2`, commit `7faa8ef`. Files: `components/Fleet/FleetPanel.tsx`,
`stores/FleetStore.ts` (reworked), `stores/fleetFeedApi.ts` (new wire adapter),
`Fleet.module.scss`. Web typecheck: **0 errors in Fleet files** (31 pre-existing
elsewhere on this branch). Not yet run against a live backend — the routes don't
exist yet; shape-drift fixes expected when your FleetFeedService lands.

## What the UI does

Bulletin-board layout: left column = thread list (DMs + category posts in one list,
kind filter, category chips from `/categories`, scope `all|mine|public`), right pane =
selected thread. Visibility badge (lock/globe) on EVERY thread row and thread header —
rule 2 satisfied by never leaving it implicit. Flip control renders only when the viewer
is a participant; the flip button explains that the change is recorded as a system
message. Images/attachments are chips (filename · size); bytes are fetched only on an
explicit click (rule 3), flowcharts get JSON pretty-print and/or image render depending
on what the bytes are (see review item 9). Public search in the header, labeled as
public-only. In-page compose overlays for New Post / New DM (standard #2, no native
dialogs). Client-side unread dots via localStorage `updated_at` watermarks (until a real
read-mark story exists, item 4). Polling: feed 15s, open thread 6s (item 2). Slash
commands `/dm` still work via `fleetStore.send()`; `/broadcast` now surfaces whatever
authz rejection fleetd returns (broadcast is built-but-disabled by design).

Transport: JSON rides the cluster bridge (`gyshell.cluster.request` →
`cluster:request` → backend), never a direct fleetd/10.0.0.x fetch (standard #1). The
ONE relative fetch is `GET /api/fleet/attachment/:id` because the bridge RPC is
JSON-only and bytes need streaming + object URLs.

## Contract review — ordered by how much I need an answer

1. **The "CORRECTED" premise is itself wrong.** The existing Fleet tab does NOT consume
   the `fleetHttp.ts` REST routes — it talks `gyshell.fleet` WS RPCs (`fleet:send`,
   `fleet:replay`, `fleet:status`, `fleet:setGuardConfig`, plus the `fleet:record` push;
   see `WebSocketGatewayAdapter.ts:754-768` and old `FleetStore.ts`). `fleetHttp.ts`'s
   own doc comment says it exists "for EXTERNAL agents". Conclusion unchanged — REST at
   `/api/fleet/*` is still the right surface and I've built on it — but two actions fall
   out for you: (a) add the `/api/fleet` prefix to BOTH ClusterService lists so
   `cluster:request` passes it (your own 2026-07-14 rule), and (b) make sure
   `/api/fleet/attachment/:id` streams raw bytes through the web host outside the JSON
   bridge.

2. **No live-update story.** The old tab live-tailed `fleet:record`; the new contract is
   pure request/response, so I poll. Acceptable v1, but decide it explicitly: an SSE
   endpoint (or reusing the gateway WS broadcast for a "feed changed" ping) later, or at
   minimum a delta form of `/feed` (`?since=`) so polling stays cheap. Silent downgrade
   from push to poll is the kind of thing Travis notices as "the feed feels dead".

3. **Pagination.** `before` timestamp cursor: (a) millisecond ties skip/dup rows — make
   the cursor OPAQUE (encode `updated_at + thread_id`) and return `next_cursor` +
   `has_more`; (b) feed order is `updated_at DESC` and threads BUMP while you page, so
   deep paging will still miss/dup — fine, but document it as accepted; (c) the real
   gap: **`GET /thread/:id` has no message pagination at all.** Our own DM threads grow
   unbounded; the dual-UI audit's best port was exactly webui's tail-window
   (`msg_limit≈30` + `msg_before` paging). Add `limit` + `before_seq`, default to the
   latest N, and I'll wire scrollback loading.

4. **Unread — yes, the tab needs it.** Shipped interim: localStorage watermarks
   (per-browser, and wrong in the "I posted last from another device" case). Wanted from
   the backend, in priority order: (a) `POST /api/fleet/thread/:id/read {viewer,
   up_to_seq}`; (b) feed rows carry `unread_count` (or `last_read_seq`) for the `viewer=`
   param; (c) cheap `GET /api/fleet/unread?viewer=` total for a future sidebar badge.
   My watermark code stays as offline fallback.

5. **Viewer identity is undefined.** `POST /send` requires `sender`; nothing says what
   id the human/UI is. I used `'user'` (bus-era `USER_AGENT_ID`) — exported as
   `FLEET_VIEWER` in `fleetFeedApi.ts`, one-line change when you decide. fleetd should
   reserve a canonical id for Travis in the directory, else participant checks (item 6)
   can never include him.

6. **Participant-only visibility flip vs the operator.** Travis is not a participant of
   agent↔agent threads, so per contract he cannot flip them — my UI duly hides the
   button. Is that intended? If the operator gets an override, the contract needs to say
   so (and how the system message attributes the flip).

7. **Reply addressing is ambiguous.** For an in-thread reply I send
   `to = participants − viewer` plus `thread_id`. For a reply to an open post
   (`participants: []`) that means `to: []` — does fleetd accept an empty `to` when
   `thread_id` is present? Spec which of `to`/`thread_id` wins and whether `to` is
   ignored on in-thread sends.

8. **Attachment upload ordering race.** `POST /attachment` takes `message_id`, i.e.
   attach AFTER send — but recipients wake ON send and may fetch the thread before the
   attachment lands. Either stage uploads (`POST /attachment` first → `attachment_id`,
   referenced in `/send`) or let `/send` carry attachments. UI has no upload flow yet;
   I'll build it once the ordering is settled.

9. **Flowchart dual representation is unreachable.** Rule 4 wants BOTH structured JSON
   and a render, but an `AttachmentRef` is one id + one media_type. Either two refs
   linked by `render_of: <attachment_id>`, or one ref with
   `GET /attachment/:id?format=json|render`. My UI currently shows whatever the bytes
   are; with the contract answer I'll show both affordances on one chip.

10. **Receipts are missing from `/thread/:id`.** The four states
    (queued→delivered→woke→acked) are phase 1's crown jewel and the old tab showed
    per-recipient delivery chips — as written, the rework LOSES observability Travis
    already has. I render an optional `receipts[]` per message defensively; please add
    it to the message shape (per-recipient for multi-recipient sends).

11. **The kill switch and autonomy budget disappear with ConversationBus.** The old
    header had the F1 kill switch (`autonomousRoutingEnabled`) + budget meter. The new
    contract has no equivalent, and retiring ConversationBus removes the enforcement
    point too. Where does wake-inference governance live in fleetd? Even a stub
    `GET/POST /api/fleet/guard` keeps the Travis-facing control alive; dropping a safety
    control silently is exactly the failure class this project exists to kill.

12. **Underspecified shapes** (I parse defensively; zod them so the defensive code can
    die): `/categories` rows, `/search` results (I guessed `{thread_id, message?,
    snippet?}`), `Message.kind` enumeration (I special-case `'system'`), `/agents`
    directory/presence fields (`online` vs `status` vs heartbeat age — contract says
    presence is computed live, but not what the field is called).

## Suggested integration order

Land routes behind your FleetFeedService on a branch → I run the web build against it,
fix shape drift, add scrollback + uploads per answers to 3/8 → then contracts.ts swap
(delete my local types in `fleetFeedApi.ts`) → joint end-to-end with a real
image + flowchart attachment before Travis sees it.
