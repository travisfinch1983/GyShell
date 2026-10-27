# pCloud encrypted off-site mirror (px-nas)

Off-site copy of **selected** Nextcloud folders (Travis picks them; never the whole dataset), encrypted
client-side with rclone `crypt` before upload. pCloud only ever stores scrambled names and contents.

- Installed 2026-10-27: Debian `rclone` 1.60.1 on the px-nas host.
- Keys: vault `cred-42bf5066`. **Losing both passwords = the mirror can never be decrypted.** Travis keeps an offline copy.
- Recovery from scratch (verified 2026-10-27 using only the two passwords):
  `rclone config create recover crypt remote=pcloud:NextcloudMirror password=<pw> password2=<salt> --obscure`
- pClouds own Crypto Folder is not used. It only works through pClouds apps.
- Not built yet: folder selection UI (in the Nextcloud consolidation app), nightly job from a ZFS snapshot, `--backup-dir` versioning.
