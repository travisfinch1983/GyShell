import { chunkBoundaryHashes, hasMultimodalContent, capMessagesAtFirstImage } from './boundaries.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };

// build a token stream
const toks = Array.from({ length: 1000 }, (_, i) => (i * 7 + 3) % 250000);

// 1) emits at each chunk multiple, ascending
const b = chunkBoundaryHashes(toks, 256, 'fpAAA');
ok(b.length === 3, `expect 3 boundaries @256 over 1000 toks, got ${b.length}`);
ok(b[0][0] === 256 && b[1][0] === 512 && b[2][0] === 768, `boundary positions ${b.map(x=>x[0])}`);

// 2) determinism
const b2 = chunkBoundaryHashes(toks, 256, 'fpAAA');
ok(b[2][1] === b2[2][1], 'deterministic hash');

// 3) salt discriminates (different fp → different pool)
const b3 = chunkBoundaryHashes(toks, 256, 'fpBBB');
ok(b[2][1] !== b3[2][1], 'salt discriminates');

// 4) PREFIX PROPERTY: a longer stream sharing the first 800 toks must produce the SAME
//    hashes at 256/512/768 as the shorter one. This is what makes content-addressing +
//    cross-instance sharing correct.
const longer = toks.slice(0, 800).concat(Array.from({ length: 500 }, (_, i) => (i * 13 + 1) % 250000));
const bl = chunkBoundaryHashes(longer, 256, 'fpAAA');
ok(bl[0][1] === b[0][1] && bl[1][1] === b[1][1] && bl[2][1] === b[2][1], 'prefix property holds @256/512/768');
ok(bl.length === 5, `longer stream 1300 toks → 5 boundaries, got ${bl.length}`);

// 5) empty / tiny
ok(chunkBoundaryHashes([], 256, 'x').length === 0, 'empty → none');
ok(chunkBoundaryHashes([1, 2, 3], 256, 'x').length === 0, 'sub-chunk → none');

// 6) hasMultimodalContent
ok(hasMultimodalContent([{ role: 'user', content: 'hi' }]) === false, 'text-only not multimodal');
ok(hasMultimodalContent([{ role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image_url', image_url: { url: 'x' } }] }]) === true, 'image_url detected');
ok(hasMultimodalContent([{ role: 'user', content: [{ type: 'input_image', image: 'x' }] }]) === true, 'input_image detected');

// 7) capMessagesAtFirstImage — whole text messages kept; mixed message keeps pre-image text
const msgs = [
  { role: 'system', content: 'You are helpful.' },
  { role: 'user', content: 'first turn' },
  { role: 'assistant', content: 'ok' },
  { role: 'user', content: [{ type: 'text', text: 'look at this: ' }, { type: 'image_url', image_url: { url: 'x' } }, { type: 'text', text: 'ignored' }] },
  { role: 'assistant', content: 'after image' },
];
const cap = capMessagesAtFirstImage(msgs);
ok(cap.capped === true, 'capped flag set');
ok(cap.messages.length === 4, `kept 3 whole + 1 partial = 4, got ${cap.messages.length}`);
ok(cap.messages[3].content === 'look at this: ', `partial text preserved, got ${JSON.stringify(cap.messages[3].content)}`);

// 8) no image → unchanged, not capped
const cap2 = capMessagesAtFirstImage([{ role: 'user', content: 'plain' }]);
ok(cap2.capped === false && cap2.messages.length === 1, 'no image → passthrough');

// 9) image as very first part of first message → that message dropped entirely
const cap3 = capMessagesAtFirstImage([{ role: 'system', content: 'sys' }, { role: 'user', content: [{ type: 'image_url', image_url: { url: 'x' } }] }]);
ok(cap3.capped === true && cap3.messages.length === 1 && cap3.messages[0].content === 'sys', 'leading-image message dropped, head kept');

console.log(`\nboundaries.js: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
