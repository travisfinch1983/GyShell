"""Bring already-generated /opt/proxlab/services/*.sh in line with the ai.js generator (claude1 2026-10-31): the disk-first mc()
(RAM cache -> local disk tier -> NAS, /models and /tts), rvc's mangled `/tts$(mc '/models/...')` token, and the TTS server's
cache/store args. argv: disk tier container path, then script names. Backups: <script>.bak-diskfirst-<ts> in /root/claude1-scratch."""
import re, shutil, subprocess, sys, time
disk = sys.argv[1]
OLD = re.compile(r'mc\(\)\{ p="\$1"; case "\$p" in\n  /model-cache/\*\) c="\$p"; n="/models/\$\{p#/model-cache/\}";;\n'
                 r'  /models/\*\) n="\$p"; c="/model-cache/\$\{p#/models/\}";;\n  \*\) printf "%s" "\$p"; return ;; esac\n'
                 r'  if \[ -e "\$c" \]; then printf "%s" "\$c"; else printf "%s" "\$n"; fi; \}\n')
NEW = ('mc(){ p="$1"; case "$p" in\n'
       '  /model-cache/tts/*) r="tts/${p#/model-cache/tts/}"; n="/tts/${p#/model-cache/tts/}";;\n'
       '  /model-cache/*) r="${p#/model-cache/}"; n="/models/$r";;\n'
       '  /models/*) r="${p#/models/}"; n="$p";;\n'
       '  /tts/*) r="tts/${p#/tts/}"; n="$p";;\n'
       '  *) printf "%s" "$p"; return ;; esac\n'
       f'  for x in "/model-cache/$r" "{disk}/$r"; do [ -e "$x" ] && {{ printf "%s" "$x"; return; }}; done\n'
       '  printf "%s" "$n"; }\n')
ts = time.strftime("%Y%m%d%H%M%S", time.gmtime())
for name in sys.argv[2:]:
    p = f"/opt/proxlab/services/{name}.sh"
    s = open(p).read()
    o = s
    if OLD.search(s):
        s = OLD.sub(lambda m: NEW, s, count=1)
    s = s.replace("--models-dir /tts$(mc '/models/rvc/checkpoints')", "--models-dir $(mc '/tts/models/rvc/checkpoints')")
    if "proxlab-tts/server.py" in s and "--model-store" not in s:
        if "mc(){" not in s:
            s = s.replace("#!/bin/bash\n", "#!/bin/bash\n" + NEW, 1)
        s = re.sub(r"(  --voices /tts/voices/chatterbox)\n", r"\1 \\\n  --model-cache /model-cache/tts/models/chatterbox \\\n  --model-store $(mc '/tts/models/chatterbox')\n", s, count=1)
    if s == o:
        print(name, "unchanged"); continue
    shutil.copy2(p, f"/root/claude1-scratch/{name}.sh.bak-diskfirst-{ts}")
    open(p + ".new", "w").write(s)
    r = subprocess.run(["bash", "-n", p + ".new"], capture_output=True, text=True)
    if r.returncode:
        print(name, "SYNTAX ERROR", r.stderr); continue
    shutil.copymode(p, p + ".new")
    import os
    os.replace(p + ".new", p)
    print(name, "updated")
