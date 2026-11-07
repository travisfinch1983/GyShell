/**
 * ImageInbox spec: the path allowlist is the security boundary — posts by path must be
 * confined to the allowed roots even through symlinks; uploads validate extension and
 * size; seen/remove/clear mutate pip + disk honestly; persistence survives a reload; a
 * corrupt index degrades to empty instead of crashing.
 * Run: tsx packages/backend/src/services/Notifications/imageInbox.extreme.spec.ts
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ImageInbox, ImageInboxError, MAX_UPLOAD_BYTES } from './ImageInbox'

const assert = (cond: boolean, msg: string): void => {
  if (!cond) throw new Error(msg)
}

function expectErr(fn: () => unknown, status: number, msg: string): void {
  try {
    fn()
  } catch (e) {
    assert(e instanceof ImageInboxError, `${msg}: threw non-ImageInboxError ${e}`)
    assert((e as ImageInboxError).status === status, `${msg}: status ${(e as ImageInboxError).status} != ${status}`)
    return
  }
  throw new Error(`${msg}: did not throw`)
}

// A minimal real PNG header + padding — enough that the file is a plausible non-empty image.
const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(64, 7)])

async function main(): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), 'imginbox-spec-'))
  const root = mkdtempSync(join(tmpdir(), 'imginbox-root-'))      // stands in for /imagegen
  const outside = mkdtempSync(join(tmpdir(), 'imginbox-outside-'))
  const events: Array<{ ch: string; data: any }> = []
  const bc = (ch: string, data: unknown) => events.push({ ch, data })

  writeFileSync(join(root, 'good.png'), PNG)
  writeFileSync(join(root, 'empty.png'), Buffer.alloc(0))
  writeFileSync(join(root, 'notes.txt'), 'not an image')
  writeFileSync(join(outside, 'secret.png'), PNG)
  mkdirSync(join(root, 'sub'))
  // The attack the realpath check exists for: a symlink INSIDE the root that points outside.
  symlinkSync(join(outside, 'secret.png'), join(root, 'sub', 'sneaky.png'))

  const inbox = new ImageInbox(dataDir, bc, [root])

  // 1. Happy path by file path: copied in, unseen, both events.
  const a = inbox.post({ path: join(root, 'good.png'), title: 'render', from: 'spec' })
  assert(a.mime === 'image/png' && a.bytes === PNG.length, 'posted item carries mime+size')
  assert(a.seen === false && inbox.unseen() === 1, 'new image is unseen')
  assert(inbox.storedFile(a.id) !== null, 'stored copy exists')
  assert(events.some((e) => e.ch === 'imginbox:posted'), 'posted broadcast fired')
  assert(events.some((e) => e.ch === 'imginbox:changed'), 'changed broadcast fired')

  // 2. The stored file is OUR copy, not a reference: deleting the source changes nothing.
  writeFileSync(join(root, 'good.png'), Buffer.alloc(0)) // clobber source
  assert(inbox.storedFile(a.id) !== null, 'copy survives source clobber')

  // 3. Path confinement: outside root, traversal spelling, and symlink escape all refused.
  expectErr(() => inbox.post({ path: join(outside, 'secret.png') }), 403, 'outside root')
  expectErr(() => inbox.post({ path: join(root, '..', 'whatever.png') }), 404, 'traversal (nonexistent)')
  expectErr(() => inbox.post({ path: join(root, 'sub', 'sneaky.png') }), 403, 'symlink escape')

  // 4. File validation: missing, wrong type, empty.
  expectErr(() => inbox.post({ path: join(root, 'nope.png') }), 404, 'missing file')
  expectErr(() => inbox.post({ path: join(root, 'notes.txt') }), 400, 'non-image extension')
  expectErr(() => inbox.post({ path: join(root, 'empty.png') }), 400, 'empty file')

  // 5. Upload path: happy, bad ext, oversized, both/neither sources.
  const b = inbox.post({ dataBase64: PNG.toString('base64'), filename: 'up.webp', caption: 'c' })
  assert(b.mime === 'image/webp', 'upload mime from filename ext')
  expectErr(() => inbox.post({ dataBase64: PNG.toString('base64'), filename: 'up.svg' }), 400, 'svg refused')
  expectErr(() => inbox.post({ dataBase64: Buffer.alloc(MAX_UPLOAD_BYTES + 1).toString('base64'), filename: 'big.png' }), 400, 'oversized upload')
  expectErr(() => inbox.post({ path: join(root, 'good.png'), dataBase64: 'aGk=', filename: 'x.png' }), 400, 'both sources')
  expectErr(() => inbox.post({}), 400, 'neither source')

  // 6. Seen: pip clears, is idempotent, and only flips unseen items.
  assert(inbox.unseen() === 2, 'two unseen before markAllSeen')
  assert(inbox.markAllSeen() === 2 && inbox.unseen() === 0, 'markAllSeen clears the pip')
  assert(inbox.markAllSeen() === 0, 'markAllSeen is idempotent')

  // 7. Remove deletes the stored file; clear empties everything.
  const bFile = inbox.storedFile(b.id)!.file
  assert(inbox.remove(b.id) && !existsSync(bFile), 'remove deletes the stored copy')
  assert(!inbox.remove(b.id), 'double remove reports false')
  inbox.post({ dataBase64: PNG.toString('base64'), filename: 'extra.png' })
  assert(inbox.clear() === 2 && inbox.list().length === 0, 'clear empties the list')
  const left = readdirSync(join(dataDir, 'notifications', 'image-inbox')).filter((f) => f !== 'index.json' && !f.endsWith('.tmp'))
  assert(left.length === 0, `clear leaves no image files behind (found ${left.join(', ')})`)

  // 8. Persistence: a second instance over the same dataDir sees what the first saved.
  const c = inbox.post({ dataBase64: PNG.toString('base64'), filename: 'keep.png', title: 'kept' })
  const reloaded = new ImageInbox(dataDir, bc, [root])
  assert(reloaded.list().length === 1 && reloaded.list()[0].id === c.id, 'index reloads')
  assert(reloaded.storedFile(c.id) !== null, 'stored file reachable after reload')
  assert(reloaded.unseen() === 1, 'unseen survives reload')

  // 9. A corrupt index degrades to empty — never a crash.
  writeFileSync(join(dataDir, 'notifications', 'image-inbox', 'index.json'), '{nope')
  const corrupt = new ImageInbox(dataDir, bc, [root])
  assert(corrupt.list().length === 0, 'corrupt index starts empty')

  // 10. An unresolvable allowed root is skipped with a warning, not fatal; and with no
  // usable roots every path post is refused (fail-closed).
  const noRoots = new ImageInbox(mkdtempSync(join(tmpdir(), 'imginbox-spec2-')), bc, ['/does-not-exist-xyz'])
  expectErr(() => noRoots.post({ path: join(root, 'good.png') }), 403, 'no roots = fail closed')

  console.log('imageInbox.extreme.spec: all assertions passed')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
