# CT160 prometheus (10.0.0.79)

`/opt/inference-sd/inference-sd.py` (timer `inference-sd.timer`, every minute) writes the
`inference` job's file-SD (`/etc/prometheus/targets/inference.json`). It finds services by
listing each host's listening ports over a forced-command SSH key (`command="ss -Hltn"` in the
target's `/root/.ssh/authorized_keys`, key comment `inference-sd@ct160`).

**A new inference host needs both:** an entry in `HOSTS`, and that key line in its
`authorized_keys`. Hosts: CT177 px-gpu (V100s), CT176 px-epyc (4090 + 5060 Ti),
CT198 px-nas ai-nas (RTX 5060, reranker primary; added 2026-10-29: it was unscraped for its
first day because it was never added here).
