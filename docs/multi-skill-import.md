# Multi-Skill Folder Import — Spec

## Goal

When the user points the Skills tab at a folder that contains one or more
`SKILL.md` files (anywhere in the tree), import each one as a self-contained
skill — preserving its scripts, references, assets, hooks, and any other
sibling files.

This replaces the current "single SKILL.md upload" flow with a uniform
folder-walk that handles all the layouts seen in the public skill
marketplaces (Cat 1–6 in `/claude/agent-skills/`).

## Why

Skill repos don't share a single layout. Examples:

| Repo | Layout |
|---|---|
| Anthropic Base (Cat 4) | `skills/<name>/SKILL.md` |
| Context Engineering (Cat 1) | `skills/<name>/SKILL.md` + `skills/<name>/scripts/` + `skills/<name>/references/` |
| Software Engineering (Cat 2) | `skills/<name>/SKILL.md` |
| Hugging Face (Cat 3) | `skills/<name>/SKILL.md` |
| Claude Skills Extended (Cat 5) | `<category-folder>/<name>/SKILL.md` (no top-level `skills/`) |
| AI Research (Cat 6) | `<NN-category>/<name>/SKILL.md` |

The common shape is: **a skill is whatever folder contains a `SKILL.md`.**
Walking for that file is the only layout assumption that holds across all
of them.

## Detection rule

1. User picks a folder via `<input type="file" webkitdirectory>`.
2. Backend walks the tree (skipping `.git`, `node_modules`, `.claude-plugin`,
   `.cursor-plugin`, `.codex`, `.gemini`, `.github`, `__pycache__`).
3. Collects every path matching `SKILL.md` (case-insensitive, but emit a
   warning if not exactly `SKILL.md`).
4. For each match, the **directory containing it** is the skill root.
5. Parses YAML frontmatter from each `SKILL.md` to extract `name` and
   `description`.

## UI flow

### Single-skill case (1 SKILL.md found)

- Show the parsed name + description in a confirm dialog.
- "Import" copies the entire skill-root subtree to
  `~/.gybackend-data/skills/<safe-name>/`.

### Multi-skill case (>1 SKILL.md found)

- Show a checklist:
  ```
  Found 14 skills in this folder. Select which to import:
  [x] context-fundamentals — Understand what context is and the anatomy...
  [x] context-degradation — Recognize patterns of context failure...
  [ ] context-compression — Design and evaluate compression strategies...
  ...
  [Import N selected]
  ```
- Each row is `<dirname> — <description-from-frontmatter>` (truncated).
- Pre-checked by default; user can deselect ones they don't want.
- "Import N selected" copies each selected skill's subtree.

### Conflict handling

- If a skill name already exists: dialog with three options
  - **Skip** — leave the existing skill untouched
  - **Replace** — delete the existing folder + copy the new one
  - **Rename** — append `-2`, `-3`, etc. to the new skill's directory
- Apply per-skill, with a "remember choice for remaining" checkbox.

## Storage layout

```
~/.gybackend-data/
└── skills/
    └── <skill-name>/
        ├── SKILL.md              ← entry point
        ├── scripts/              ← preserved verbatim
        ├── references/
        ├── assets/
        ├── hooks/
        └── (anything else from source)
```

The skill name (folder name on disk) is derived from the `name` field in
frontmatter, sanitized (`/[^a-z0-9-]/g` → `-`, lowercased). Falls back to
the source dirname if frontmatter is missing.

## Skill registry

Each imported skill is registered in `tools.skills` with:

```ts
{
  name: string                  // folder name on disk
  description: string           // from frontmatter
  rootPath: string              // absolute path to skill folder
  entryPath: string             // absolute path to SKILL.md
  enabled: boolean
  source: 'imported' | 'created'
  importedFrom?: string         // original folder path (for re-import / debugging)
}
```

## Model-side resolution

When the model calls the `skill` tool with a skill name:

1. Look up the skill in the registry → get `rootPath` and `entryPath`.
2. Read `entryPath`, return its content (frontmatter stripped) as the tool
   result.
3. Inside the skill content, any relative path reference (`scripts/foo.py`,
   `references/api.md`) resolves relative to `rootPath`. The model invokes
   them via `exec_headless` (`python3 ${rootPath}/scripts/foo.py ...`) or
   `read_file` (`${rootPath}/references/api.md`).

This means **the SKILL.md author writes paths relative to the skill folder,
and they just work.** No path-rewriting on import.

## What to skip on import

- `.git`, `.github`, `.gitignore`, `LICENSE`, `CONTRIBUTING.md`, `CHANGELOG.md`
  (these are repo-level housekeeping, not skill content)
- `.claude-plugin/`, `.cursor-plugin/`, `.codex/`, `.gemini/`,
  `gemini-extension.json`, `.mcp.json` (publishing manifests, not runtime)
- Top-level `node_modules/`, `__pycache__/`, `dist/`, `build/`

These are sibling-or-ancestor of the SKILL.md folder and would only be
included if the source layout puts them inside the skill folder itself —
in practice they never are. The skip list is a safety net.

## Implementation notes

- Folder walk + frontmatter parse → Node.js, in
  `packages/backend/src/services/SkillsImport/` (new).
- `webkitdirectory` upload: browser sends a `FormData` with each File having
  `webkitRelativePath` that preserves the source path. The backend
  reconstructs the tree from those, then runs detection on the reconstructed
  tree.
- For paths, use a sandboxed temp dir during reconstruction; only commit to
  `~/.gybackend-data/skills/` after the user confirms the import.
- Add a "drop folder" zone on the Skills tab as an alternative to the
  button-and-picker.
- Future: GitHub URL import — paste a repo URL + optional subpath, system
  uses `git clone --depth=1` via `exec_headless` to fetch, then runs the
  same detection + UI flow against the cloned tree.

## Out of scope (this iteration)

- Skill versioning / updates from source
- Cross-skill dependencies (no skill repo seen so far has them)
- Encrypted or password-protected skills
- Auto-installing referenced Python packages — skill scripts are expected
  to be stdlib-only (Cat 5 explicitly guarantees this; Cat 6 may not, but
  let the model handle pip installs via `exec_headless` if needed)
