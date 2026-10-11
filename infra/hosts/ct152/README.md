# CT152 (ai-lab) host files

| File | Installed at | What |
|---|---|---|
| `ailab-deploy-when-idle` | `/usr/local/sbin/` | Deploy helper: `ailab-deploy-when-idle "<what>" <verify-url> <expected substring> [max-hours]` waits (5-min checks) until AI-Lab has no running tasks, then `ailab-restart --build`, checks the URL, and reports over fleet. Generalised 2026-10-11 (was Wiro-only). |
| `ailab-addon-social.service` | `/etc/systemd/system/` | Instagram + X scraper addon backend (`addons/social`, 127.0.0.1:8097). |
