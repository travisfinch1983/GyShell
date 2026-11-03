#!/usr/bin/env python3
"""cf-ddns: keep Cloudflare A records pointed at the home WAN IP (OPNsense bnxt0 is DHCP).

Records: CF_DDNS_RECORDS (comma-separated FQDNs, all in zone CF_ZONE_ID). Only A records that
already exist are updated; their proxied flag, TTL and comment are preserved. Runs from
cf-ddns.timer every 5 min on CT152. Exits non-zero on any failure, so the unit shows as failed.
Config + token: /opt/ai-lab-secrets/cf-ddns/env (0600; token = vault cred-376a4be4).
claude1, 2026-11-03 (first record: dhb-collab.deeveeyant.com, CT190's SSH name).
"""
import json
import os
import sys
import urllib.request

TOKEN = os.environ["CF_API_TOKEN"]
ZONE = os.environ["CF_ZONE_ID"]
RECORDS = [r.strip() for r in os.environ.get("CF_DDNS_RECORDS", "").split(",") if r.strip()]
API = "https://api.cloudflare.com/client/v4"


def cf(method, path, body=None):
    req = urllib.request.Request(API + path, method=method,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=20) as r:
        d = json.load(r)
    if not d.get("success"):
        raise RuntimeError(f"cloudflare {method} {path}: {d.get('errors')}")
    return d["result"]


def wan_ip():
    # Two independent sources must agree; a captive/odd answer from one must not rewrite DNS.
    ips = []
    for url in ("https://1.1.1.1/cdn-cgi/trace", "https://cloudflare.com/cdn-cgi/trace"):
        with urllib.request.urlopen(url, timeout=10) as r:
            for line in r.read().decode().splitlines():
                if line.startswith("ip="):
                    ips.append(line[3:].strip())
    if len(ips) != 2 or ips[0] != ips[1] or ips[0].count(".") != 3:
        raise RuntimeError(f"WAN IP sources disagree or are not IPv4: {ips}")
    return ips[0]


def main():
    ip = wan_ip()
    failed = False
    for name in RECORDS:
        try:
            recs = cf("GET", f"/zones/{ZONE}/dns_records?type=A&name={name}")
            if not recs:
                print(f"[cf-ddns] {name}: no A record exists - not creating one", flush=True)
                failed = True
                continue
            for rec in recs:
                if rec["content"] == ip:
                    continue
                cf("PATCH", f"/zones/{ZONE}/dns_records/{rec['id']}", {"content": ip})
                print(f"[cf-ddns] {name}: {rec['content']} -> {ip}", flush=True)
        except Exception as e:  # noqa: BLE001 - report every record, then fail the run
            print(f"[cf-ddns] {name}: FAILED {type(e).__name__}: {e}", flush=True)
            failed = True
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
