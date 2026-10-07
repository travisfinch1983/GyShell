/**
 * GPU PIN — pin a service to its cards by IDENTITY, never by position.
 *
 * Scripts used to say CUDA_VISIBLE_DEVICES=1 (an index under PCI_BUS_ID order). An index means
 * "whatever card is 2nd in this container right now": when ai-epyc came up with 5060 Ti #1
 * (02:00.0) unbound (2026-10-04), every service pinned to index 1 silently ran on 22:00.0 instead.
 *
 * Each pinned card is carried as `<pci>=<uuid>` and resolved AT LAUNCH, inside the container, from
 * /proc/driver/nvidia/gpus/<pci>/information (GPU UUID + Device Minor; /dev/nvidia<minor> must exist):
 *   - UUID known  -> the attached card WITH THAT UUID, wherever it now sits. A card moved to another
 *                    slot is followed (logged); if that card is not attached the start is REFUSED,
 *                    even when some other card now occupies the old address (two cards swapping
 *                    slots must not silently trade services).
 *   - no UUID     -> the PCI address (non-NVIDIA cards, or a UUID the monitor never saw).
 * Same identity order the passthrough hook uses (friendly name -> UUID -> PCI); before 2026-10-07 the
 * hook followed a moved card by UUID but this pin matched PCI only, so the card was attached and every
 * service pinned to it refused to start.
 *
 * Emits NUMERIC indices, not GPU-<uuid>: vLLM int()-parses CUDA_VISIBLE_DEVICES and crashed on a UUID
 * (2026-10-04). The index is the card's rank among the cards ACTUALLY ATTACHED, in PCI order (= CUDA's
 * order under CUDA_DEVICE_ORDER=PCI_BUS_ID). A missing card exits 78 (RestartPreventExitStatus=78).
 * Never calls nvidia-smi: on a stalled card it can take the driver's RM lock and deadlock the host.
 */
export const GPU_PIN_EXIT = 78;
const PCI_RE = /^[0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-9a-f]$/;
const UUID_RE = /^GPU-[0-9a-f-]{36}$/i;

export const GPU_PIN_HEADER = '# ── AI-Lab GPU pin: cards by UUID (else PCI) -> index among ATTACHED cards at launch; refuse if absent ──';
export const GPU_PIN_HEADER_RE = /^# ── AI-Lab GPU pin:.*$/m;
export const GPU_PIN_END_RE = /^echo "AI-LAB GPU PIN: .*$/m;

/** @param {string[]} pciIds  @param {Record<string,string>} [uuidByPci]  PCI -> GPU-uuid (any case) */
export function gpuPinPreamble(pciIds, uuidByPci = {}) {
  const list = pciIds.map((p) => String(p).toLowerCase()).filter((p) => PCI_RE.test(p));
  if (!list.length || list.length !== pciIds.length) return null;
  const norm = {};
  for (const [k, v] of Object.entries(uuidByPci || {})) if (v && UUID_RE.test(String(v))) norm[String(k).toLowerCase()] = String(v);
  const pins = list.map((p) => (norm[p] ? `${p}=${norm[p]}` : p));
  return [
    GPU_PIN_HEADER,
    `AILAB_GPU_PINS="${pins.join(' ')}"`,
    'export CUDA_DEVICE_ORDER=PCI_BUS_ID',
    '_attached=""',
    'for _d in /proc/driver/nvidia/gpus/*; do',
    '  _m=$(sed -n "s/^Device Minor:[[:space:]]*//p" "$_d/information" 2>/dev/null)',
    '  [ -n "$_m" ] && [ -e "/dev/nvidia$_m" ] && _attached="$_attached $(basename "$_d" | tr A-F a-f)"',
    'done',
    '_attached=$(printf "%s\\n" $_attached | sort)',
    'AILAB_CVD=""',
    'for _pin in $AILAB_GPU_PINS; do',
    '  _pci=${_pin%%=*}; _uuid=""; [ "$_pin" != "$_pci" ] && _uuid=${_pin#*=}',
    '  _use=""',
    '  if [ -n "$_uuid" ]; then',
    '    for _p in $_attached; do',
    '      _u=$(sed -n "s/^GPU UUID:[[:space:]]*//p" "/proc/driver/nvidia/gpus/$_p/information" 2>/dev/null)',
    '      [ "$(echo "$_u" | tr A-F a-f)" = "$(echo "$_uuid" | tr A-F a-f)" ] && { _use=$_p; break; }',
    '    done',
    `    [ -z "$_use" ] && { echo "AI-LAB GPU PIN: GPU $_uuid (pinned at $_pci) is NOT attached to this container (attached: $(echo $_attached)) -- refusing to start rather than run on a different card"; exit ${GPU_PIN_EXIT}; }`,
    '    [ "$_use" != "$_pci" ] && echo "AI-LAB GPU PIN: $_uuid moved $_pci -> $_use; following the card"',
    '  else',
    '    printf "%s\\n" $_attached | grep -qx "$_pci" && _use=$_pci',
    `    [ -z "$_use" ] && { echo "AI-LAB GPU PIN: GPU $_pci is NOT attached to this container (attached: $(echo $_attached)) -- refusing to start rather than run on a different card"; exit ${GPU_PIN_EXIT}; }`,
    '  fi',
    '  _idx=$(printf "%s\\n" $_attached | grep -nx "$_use" | cut -d: -f1)',
    '  AILAB_CVD="${AILAB_CVD:+$AILAB_CVD,}$((_idx - 1))"',
    'done',
    'export CUDA_VISIBLE_DEVICES="$AILAB_CVD"',
    'echo "AI-LAB GPU PIN: $AILAB_GPU_PINS -> CUDA_VISIBLE_DEVICES=$CUDA_VISIBLE_DEVICES (PCI order among attached)"',
    '',
  ].join('\n');
}

/** Rewrite index-based CUDA_VISIBLE_DEVICES (export or inline) to the pinned value. */
export function applyGpuPin(command, pciIds, uuidByPci = {}) {
  const m = command.match(/CUDA_VISIBLE_DEVICES=([0-9][0-9,]*)/);
  if (!m) return { command, preamble: '' };                  // no GPU pin requested (CPU service)
  const idxCount = m[1].split(',').filter(Boolean).length;
  const pre = Array.isArray(pciIds) && pciIds.length === idxCount ? gpuPinPreamble(pciIds, uuidByPci) : null;
  if (!pre) {
    console.warn(`[gpu-pin] not pinning: CUDA_VISIBLE_DEVICES=${m[1]} vs gpuPciIds=${JSON.stringify(pciIds)} (count/format mismatch) — leaving the index form`);
    return { command, preamble: '' };
  }
  return { command: command.replace(/CUDA_VISIBLE_DEVICES=([0-9][0-9,]*)/g, 'CUDA_VISIBLE_DEVICES="$AILAB_CVD"'), preamble: pre };
}

/** Replace an existing pin block in a generated service script (migration). Returns null if none. */
export function replacePinBlock(script, newPreamble) {
  const h = script.match(GPU_PIN_HEADER_RE);
  if (!h) return null;
  const start = h.index;
  const rest = script.slice(start);
  const e = rest.match(GPU_PIN_END_RE);
  if (!e) return null;
  let end = start + e.index + e[0].length;
  if (script[end] === '\n') end++;
  if (script[end] === '\n') end++;   // the preamble's trailing blank line
  return script.slice(0, start) + newPreamble + script.slice(end);
}

/** Extract the pinned PCI list from an existing block (old AILAB_GPU_PCIS or new AILAB_GPU_PINS). */
export function pinnedPcisFromScript(script) {
  const m = script.match(/^AILAB_GPU_(?:PCIS|PINS)="([^"]*)"/m);
  if (!m) return null;
  return m[1].split(/\s+/).filter(Boolean).map((t) => t.split('=')[0]);
}
