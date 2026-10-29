# CivitAI to AI-Lab (browser extension)

Chrome MV3 extension, load unpacked. Successor of ProxLab's `civitai-downloader` (v1.x).

## What it does
- **Download** button on CivitAI model pages: a small dialog with the name pre-filled from
  AI-Lab's filename template (`POST /api/civitai/check-conflicts` → `templateName`). Only a name
  you change is sent as `fileNameOverride`; an untouched box downloads under the template name.
- **Review** button (or the toolbar icon): opens a side panel that frames AI-Lab's own Review
  screen, `<webUrl>/?embed=civitai-review`, and keeps it on the model in the active tab.
  Version and file selection, the Folder/Filename boxes and the live name preview are AI-Lab's,
  so template changes apply immediately. "Queue for later" adds the model to AI-Lab's review queue.

## Settings (Options page)
| Key | Default | Used for |
|---|---|---|
| `apiUrl` | `http://10.0.0.219:17890` | `/api/civitai/*` (download, queue, template name) |
| `webUrl` | `http://10.0.0.219:17889` | the side panel's embedded Review screen |

v1's `proxlabUrl` is read as `apiUrl` until an `apiUrl` is saved.

## AI-Lab side
- `packages/ui/src/renderer_v2/index.tsx`: `?embed=civitai-review` renders only
  `components/ModelDownloads/CivitaiReviewEmbed.tsx` (no AppStore, nothing else boots).
- The postMessage protocol is documented at the top of `CivitaiReviewEmbed.tsx`.

## Install / update
chrome://extensions → Developer mode → Load unpacked → this folder. After pulling changes,
press the reload arrow on the extension's card.
