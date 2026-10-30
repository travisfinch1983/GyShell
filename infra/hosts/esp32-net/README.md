# esp32-net — trailer Proxmox host (AAEON UP Xtreme i11, i5-1145GRE)

- Proxmox VE 9.2, **10.50.0.5** static (vmbr0 on `eth1` = i219-LM; `eth2p5` = i225-IT, renamed from `eth2.5`
  which ifupdown2 parsed as VLAN 5). ZFS rpool. Role: dedicated ESP32 Wi-Fi AP (MediaTek MT7922 — firmware already in
  pve-firmware) + small services.
- **Intel AMT 15** (vPro), static **10.50.0.6** (host IP + 1, Travis's rule), KVM + SOL enabled, user opt-in NONE.
  Vault cred-0881b9af. Console: AI-Lab → Consoles → esp32-net.
- Kernel cmdline `/etc/kernel/cmdline`: `root=ZFS=rpool/ROOT/pve-1 boot=zfs video=HDMI-A-1:1024x768@60e`
  — forces the HDMI output on with no monitor; without it AMT KVM shows black and drops at ~29 s.
  Apply with `proxmox-boot-tool refresh` (diff against /proc/cmdline first).
- `/etc/sysctl.d/10-console-quiet.conf`: `kernel.printk = 3 4 1 3` — every AMT KVM session hot-plugs a virtual
  USB keyboard/mouse; this keeps that kernel chatter off the console.
- OPNsense (trailer) dnsmasq hosts: `esp32-net-static` → .5, `esp32-net-amt-static` → .6 (no MAC — AMT shares the
  i219 MAC, a MAC'd entry would hand AMT the host's IP).
