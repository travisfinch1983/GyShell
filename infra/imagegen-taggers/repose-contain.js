// Re-render cover-cropped pose imports from their source images, using contain.
// The source was never recorded, but an imported pose's prompt IS the caption of the
// image it came from — so the caption files are a reverse index back to the sources.
const fs = require('fs');
const path = require('path');
const sharp = require('/opt/ai-lab/node_modules/sharp');

const BASE = '/ai-assets/imagegen';
const LIB = path.join(BASE, 'pose_library');
const POSES = path.join(LIB, 'poses.json');
const IMAGES = path.join(LIB, 'pose_images');
const APPLY = process.argv.includes('--apply');

function walk(dir, out = []) {
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!e.name.startsWith('.') && e.name !== 'pose_library') walk(p, out); }
    else if (e.name.endsWith('.caption') || e.name.endsWith('.txt')) out.push(p);
  }
  return out;
}

(async () => {
  const poses = JSON.parse(fs.readFileSync(POSES, 'utf8'));
  const targets = poses.filter((p) => (p.index > 120) && !p.source);
  console.log(`   poses: ${poses.length}, imported-and-unrepaired: ${targets.length}`);
  if (!targets.length) return;

  console.log('   indexing caption files…');
  const caps = walk(path.join(BASE, 'training_images'));
  const byText = new Map();
  for (const c of caps) {
    let t = '';
    try { t = fs.readFileSync(c, 'utf8').trim(); } catch { continue; }
    if (!t) continue;
    if (!byText.has(t)) byText.set(t, []);
    byText.get(t).push(c);
  }
  console.log(`   ${caps.length} caption files, ${byText.size} distinct texts`);

  let fixed = 0, ambiguous = 0, missing = 0;
  for (const pose of targets) {
    const hits = byText.get(pose.prompt.trim()) || [];
    if (hits.length !== 1) {
      if (hits.length === 0) missing += 1; else ambiguous += 1;
      console.log(`     ${hits.length === 0 ? 'NO MATCH ' : 'AMBIGUOUS'} ${pose.id}  ${pose.prompt.slice(0, 52)}`);
      continue;
    }
    const capFile = hits[0];
    const stem = capFile.replace(/\.(caption|txt)$/, '');
    const img = ['.png', '.jpg', '.jpeg', '.webp'].map((e) => stem + e).find((f) => fs.existsSync(f));
    if (!img) { missing += 1; console.log(`     NO IMAGE  ${pose.id} (caption ${path.basename(capFile)})`); continue; }
    if (APPLY) {
      const out = await sharp(fs.readFileSync(img)).rotate()
        .resize(224, 284, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .webp({ quality: 82 }).toBuffer();
      fs.writeFileSync(path.join(IMAGES, pose.image), out);
      pose.source = path.relative(BASE, img);
    }
    fixed += 1;
  }
  console.log(`   ${APPLY ? 'RE-RENDERED' : 'would re-render'}: ${fixed}   ambiguous: ${ambiguous}   no source found: ${missing}`);
  if (APPLY && fixed) {
    fs.copyFileSync(POSES, POSES + '.bak');
    fs.writeFileSync(POSES + '.tmp', JSON.stringify(poses, null, 2));
    fs.renameSync(POSES + '.tmp', POSES);
    console.log('   poses.json updated with source paths (backup at poses.json.bak)');
  }
})();
