# CT152 (ai-lab) host files

| File | Installed at | What |
|---|---|---|
| `ailab-deploy-when-idle` | `/usr/local/sbin/` | One-shot deploy helper: waits (5-min checks, 10 h max) until AI-Lab has no running tasks, then `ailab-restart --build`, verifies, and reports over fleet. Used 2026-10-10 to deploy Wiro behind the nightly RAG run without killing it. |
