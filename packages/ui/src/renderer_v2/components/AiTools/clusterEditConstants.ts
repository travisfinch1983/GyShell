// Option lists + RAM-bandwidth calc + sub-section field schemas — ported from ProxLab inventory UI.
export const HOST_TYPE_OPTIONS = ['Enterprise Server', 'Server Blade', 'Custom Rack Server', 'High End Workstation', 'Consumer PC', 'Mini-PC', 'SBC']
export const RAM_TYPE_OPTIONS = ['DDR', 'DDR2', 'DDR3', 'DDR4', 'DDR5', 'LPDDR3', 'LPDDR4', 'LPDDR4X', 'LPDDR5', 'LPDDR5X']
export const GPU_GEN_OPTIONS = ['Arc', 'Battlemage', 'Kepler', 'Maxwell', 'Pascal', 'Volta', 'Turing', 'Ampere', 'Ada Lovelace', 'Hopper', 'Blackwell', 'RDNA', 'RDNA2', 'RDNA3', 'CDNA', 'CDNA2', 'Other']
export const GPU_PCIE_SIZE_OPTIONS = ['Integrated', 'x1', 'x4', 'x8', 'x16']
export const GPU_PCIE_GEN_OPTIONS = ['Integrated', '1.0', '2.0', '3.0', '4.0', '5.0', '6.0']
export const GPU_INTERLINK_OPTIONS = ['None', 'NVLink', 'xGMI']
export const GPU_INTERLINK_GEN: Record<string, string[]> = {
  NVLink: ['1.0', '2.0', '3.0', '4.0', '5.0'],
  xGMI: ['1.0', '2.0', '3.0'],
  None: [],
}
export const ZPOOL_TYPE_OPTIONS = ['Stripe', 'Mirror', 'RAIDZ1', 'RAIDZ2', 'RAIDZ3', 'Single', 'Special']

/** MT/s * 8 bytes * channels * cpus / 1000 = GB/s (ported verbatim). */
export function calcRamBandwidth(ramType: string, speedStr: string, channelsStr: string, cpuCount: number): string {
  const speed = parseFloat((speedStr || '').replace(/[^0-9.]/g, ''))
  const channels = parseInt(channelsStr) || 1
  const cpus = Math.max(1, Math.min(4, parseInt(String(cpuCount)) || 1))
  if (!speed) return ''
  const bw = (speed * 8 * channels * cpus) / 1000
  return `${bw.toFixed(1)} GB/s`
}

export type Field = { k: string; label: string; type?: 'text' | 'number' | 'select' | 'check' | 'textarea'; opts?: string[]; ph?: string }
export const SECTION_FIELDS: Record<string, { label: string; fields: Field[] }> = {
  cpus: { label: 'CPUs', fields: [
    { k: 'model', label: 'Model', ph: 'EPYC 7B12' }, { k: 'cores', label: 'Cores', type: 'number' }, { k: 'threads', label: 'Threads', type: 'number' },
    { k: 'baseClock', label: 'Base', ph: '2.25GHz' }, { k: 'boostClock', label: 'Boost', ph: '3.3GHz' }, { k: 'tdp', label: 'TDP', ph: '240W' },
  ] },
  gpus: { label: 'GPUs', fields: [
    { k: 'brand', label: 'Brand', ph: 'NVIDIA' }, { k: 'name', label: 'Name', ph: 'RTX 5060 Ti' }, { k: 'model', label: 'Model', ph: 'GB206' },
    { k: 'gen', label: 'Gen', type: 'select', opts: GPU_GEN_OPTIONS }, { k: 'vram', label: 'VRAM(GB)', type: 'number' },
    { k: 'pcieSize', label: 'PCIe Lanes', type: 'select', opts: GPU_PCIE_SIZE_OPTIONS }, { k: 'pcieGen', label: 'PCIe Gen', type: 'select', opts: GPU_PCIE_GEN_OPTIONS },
    { k: 'interlink', label: 'Interlink', type: 'select', opts: GPU_INTERLINK_OPTIONS }, { k: 'interlinkGen', label: 'Interlink Gen' },
  ] },
  zpools: { label: 'Zpools', fields: [
    { k: 'name', label: 'Name', ph: 'zpool-alpha' }, { k: 'type', label: 'Type', type: 'select', opts: ZPOOL_TYPE_OPTIONS }, { k: 'diskCount', label: 'Disks', ph: '4' },
    { k: 'useCase', label: 'Use Case', ph: 'VM storage' }, { k: 'rawDiskSpace', label: 'Raw(TB)', ph: '15.36' }, { k: 'useableDiskSpace', label: 'Usable(TB)', ph: '7.68' },
    { k: 'description', label: 'Description', type: 'textarea' },
  ] },
  nics: { label: 'NICs', fields: [
    { k: 'model', label: 'Model', ph: 'Intel I350-T4' }, { k: 'speed', label: 'Speed', ph: '1GbE' }, { k: 'mac1', label: 'MAC', ph: 'AA:BB:CC:DD:EE:FF' }, { k: 'bridge1', label: 'Bridge', ph: 'vmbr0' },
  ] },
  pcieCards: { label: 'Misc PCIe Cards', fields: [
    { k: 'name', label: 'Name', ph: 'HBA Card' }, { k: 'type', label: 'Type', ph: 'SAS HBA' }, { k: 'purpose', label: 'Purpose', ph: 'Disk passthrough' }, { k: 'description', label: 'Description' },
  ] },
  psus: { label: 'Power Supplies', fields: [
    { k: 'brand', label: 'Brand', ph: 'Seasonic' }, { k: 'model', label: 'Model', ph: 'Prime TX-1600' }, { k: 'wattage', label: 'Wattage(W)', ph: '1600' },
    { k: 'currentVoltage', label: 'Voltage(V)', ph: '120' }, { k: 'hotSwappable', label: 'Hot Swap', type: 'check' },
  ] },
}
export const SECTION_ORDER = ['cpus', 'gpus', 'zpools', 'nics', 'pcieCards', 'psus']
