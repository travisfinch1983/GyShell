#!/usr/bin/env python3
"""
Audit every place a model ID is bound, and check each against what the proxy is ACTUALLY serving.

A stale model pointer fails SILENTLY: the call 404s, a circuit breaker opens, and the feature
(memory extraction, vision, compaction) quietly stops working with nothing surfacing it. The
Support Models UI only covers three roles; the rest live in Hermes YAML, container env vars and
configs INSIDE containers -- and an env var is invisible to any file grep, which is how a rename
once broke HippocampAI for ~40 minutes.

Run after ANY model rename, retire, or support-model swap:
    model-binding-audit.py            # audit
    model-binding-audit.py --json     # machine-readable
Exit code is 1 when at least one binding names a model the proxy is not serving.
"""
import json, os, re, subprocess, sys, urllib.request

PROXY = os.environ.get("AILAB_PROXY", "http://127.0.0.1:17890")
HERMES = os.environ.get("HERMES_HOME", "/root/.hermes")
SUPPORT_JSON = os.environ.get("AILAB_SUPPORT_MODELS",
                              "/opt/ai-lab/.gybackend-data/hermes-support-models.json")
MODEL_KEYS = ("model", "default_model", "vlm_model")

def served():
    """The authority: what the proxy will actually answer for right now."""
    with urllib.request.urlopen(PROXY + "/api/proxy/llm/v1/models", timeout=20) as r:
        ids = [m["id"] for m in json.load(r).get("data", [])]
    # a routed model is listed with a provider tag ("[OR] vendor/model"); index both forms so a
    # binding that names the bare id is not reported as dead
    bare = {re.sub(r"^\[[A-Z]{2}\]\s*", "", i): i for i in ids}
    return set(ids), bare

def sh(cmd):
    try:
        return subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=30).stdout
    except Exception:
        return ""

def walk_yaml(obj, path, out, source):
    """Collect every model-ish key anywhere in a config tree, at any depth."""
    if isinstance(obj, dict):
        for k, v in obj.items():
            p = f"{path}.{k}" if path else k
            if k in MODEL_KEYS and isinstance(v, str):
                out.append({"source": source, "path": p, "value": v})
            else:
                walk_yaml(v, p, out, source)
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            walk_yaml(v, f"{path}[{i}]", out, source)

def collect():
    b = []
    # 1. Support Models UI surface
    if os.path.exists(SUPPORT_JSON):
        try:
            for role, cfg in json.load(open(SUPPORT_JSON)).items():
                if isinstance(cfg, dict) and cfg.get("model"):
                    b.append({"source": "support-models.json (UI)", "path": role, "value": cfg["model"]})
        except Exception as e:
            b.append({"source": "support-models.json (UI)", "path": "<unreadable>", "value": f"ERROR {e}"})
    # 2. Hermes global + every profile
    try:
        import yaml
        for f, src in [(os.path.join(HERMES, "config.yaml"), "hermes/config.yaml")] + [
            (os.path.join(HERMES, "profiles", d, "config.yaml"), f"hermes/profiles/{d}")
            for d in sorted(os.listdir(os.path.join(HERMES, "profiles")))
            if os.path.isdir(os.path.join(HERMES, "profiles", d))
        ]:
            if not os.path.exists(f):
                continue
            try:
                walk_yaml(yaml.safe_load(open(f)) or {}, "", b, src)
            except Exception as e:
                b.append({"source": src, "path": "<unparseable>", "value": f"ERROR {e}"})
    except ImportError:
        b.append({"source": "hermes", "path": "<skipped>", "value": "ERROR pyyaml missing"})
    # 3. Container ENV — invisible to any file grep; this is the one that bit us before.
    #
    # Read PID 1's environ, not Config.Env. Config.Env is what the env_file supplied at create
    # time; hippocampai's entrypoint deliberately OVERRIDES it from the mounted support-models
    # file ("file wins, env is the fallback"), so Config.Env stays at whatever .env said forever.
    # Auditing it would report a permanent false failure for a container that is in fact using
    # the right model -- the precise kind of noise that makes an audit worth ignoring.
    for c in [x for x in sh("docker ps --format '{{.Names}}'").split() if x]:
        # The redirect must run INSIDE the container: `docker exec c tr ... < /proc/1/environ`
        # feeds the HOST's pid-1 environ to the container's tr.
        live = sh(f"""docker exec {c} sh -c 'tr "\\0" "\\n" < /proc/1/environ' 2>/dev/null""")
        src = f"docker env: {c}" if live.strip() else f"docker env: {c} (create-time)"
        for line in (live if live.strip() else
                     sh(f"docker inspect {c} --format '{{{{range .Config.Env}}}}{{{{println .}}}}{{{{end}}}}'")).splitlines():
            if "=" not in line:
                continue
            k, v = line.split("=", 1)
            if k.upper().endswith("_MODEL") and v.strip():
                b.append({"source": src, "path": k, "value": v.strip()})
    # 4. Configs INSIDE containers.
    #
    # Read the config the process was ACTUALLY given, not the one on disk at the mount path.
    # openviking mounts ov.conf READ-ONLY as a source and its entrypoint emits a substituted
    # runtime copy (vlm.model comes from the support-models file), then runs with --config on
    # that copy. Auditing the source reports the pre-substitution value forever -- it read as a
    # stale pointer immediately after a recreate that had in fact applied the new model.
    cmdline = sh("""docker exec ailab-openviking sh -c 'tr "\\0" " " < /proc/1/cmdline' 2>/dev/null""")
    m = re.search(r"--config\s+(\S+)", cmdline)
    conf_path = m.group(1) if m else "/root/.openviking/ov.conf"
    ov = sh(f"docker exec ailab-openviking cat {conf_path} 2>/dev/null")
    if ov.strip():
        label = f"in-container: openviking {os.path.basename(conf_path)}"
        try:
            walk_yaml(json.loads(ov), "", b, label)
        except Exception:
            for mm in re.finditer(r'"model"\s*:\s*"([^"]+)"', ov):
                b.append({"source": label, "path": "model", "value": mm.group(1)})
    return b

# Not every model key routes through the LLM proxy. TTS/STT/embedding/rerank bindings name models
# served by entirely different backends, and a provider's own default_model is resolved by THAT
# provider (deepseek-v4-pro is valid at DeepSeek and absent from our proxy). Checking those against
# the LLM proxy's /v1/models would report a wall of false failures, and an audit nobody trusts is
# worse than no audit. They are still LISTED, so an unknown hardcoded id surfaces -- just not
# judged against a list that was never going to contain it.
def routes_via_proxy(b):
    p, src, key = b["path"], b["source"], b["path"].rsplit(".", 1)[-1]
    if re.match(r"^(tts|stt)\.", p):
        return False
    # match the whole PATH, not just the leaf: openviking nests its embedder as
    # embedding.dense.model, whose leaf key is a bare "model".
    if re.search(r"(embed|rerank)", p, re.I) or re.search(r"(EMBED|RERANK)", key, re.I):
        return False
    m = re.match(r"^providers\.([^.]+)\.default_model$", p)
    if m and m.group(1) != "ailab":
        return False
    if p == "x_search.model":
        return False
    if p == "model.default":            # the agent's own top-level provider default
        return False
    return True

def main():
    try:
        exact, bare = served()
    except Exception as e:
        print(f"FATAL: could not read the served-model list from {PROXY}: {e}", file=sys.stderr)
        return 2

    rows, other, dead = [], [], 0
    for x in collect():
        v = x["value"]
        if not routes_via_proxy(x):
            other.append(x)
            continue
        if v.startswith("ERROR"):
            status = "ERROR"
        elif not v or v in ("auto", "''"):
            status = "AUTO"
        elif v in exact or v in bare:
            status = "OK"
        else:
            status = "DEAD"
            dead += 1
        rows.append({**x, "status": status})

    if "--json" in sys.argv:
        print(json.dumps({"served": sorted(exact), "bindings": rows,
                          "notChecked": other, "dead": dead}, indent=2))
        return 1 if dead else 0

    print(f"Serving {len(exact)} models via {PROXY}\n")
    bad = [r for r in rows if r["status"] in ("DEAD", "ERROR")]
    if bad:
        print("BINDINGS NAMING A MODEL THE PROXY IS NOT SERVING")
        w = max(len(r["source"]) for r in bad)
        for r in sorted(bad, key=lambda r: (r["value"], r["source"])):
            print(f"  {r['source']:<{w}}  {r['path']:<32}  {r['value']}")
        print()
    # OK/AUTO rows are collapsed by value: 20 profiles repeating one binding is one fact.
    okc = {}
    for r in rows:
        if r["status"] == "OK":
            okc.setdefault(r["value"], []).append(r["source"])
    if okc:
        print("RESOLVING CORRECTLY")
        for v, srcs in sorted(okc.items()):
            print(f"  {v}  ({len(srcs)} binding{'' if len(srcs)==1 else 's'})")
        print()
    autos = sum(1 for r in rows if r["status"] == "AUTO")
    if autos:
        print(f"{autos} binding(s) set to auto/inherit — resolved at call time, nothing to check.\n")
    if other:
        seen = {}
        for r in other:
            seen.setdefault(r["value"], set()).add(r["path"].rsplit(".", 1)[-1])
        print("NOT CHECKED (different backend: tts/stt/embed/rerank, or another provider's default)")
        for v, keys in sorted(seen.items()):
            print(f"  {v}  [{', '.join(sorted(keys))}]")
        print()
    if dead:
        print(f"{dead} binding(s) name a model the proxy is NOT serving — those features are")
        print("failing silently right now. Fix the binding or start the model.")
    else:
        print("All bindings resolve to a served model.")
    return 1 if dead else 0

if __name__ == "__main__":
    sys.exit(main())
