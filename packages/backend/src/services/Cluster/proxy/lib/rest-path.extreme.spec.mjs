/**
 * joinRestParam must produce a path http.request accepts, without changing paths that already worked.
 * Run: node packages/backend/src/services/Cluster/proxy/lib/rest-path.extreme.spec.mjs
 */
import http from 'node:http'
import { joinRestParam } from './rest-path.js'

let n = 0
const ok = (c, m) => {
  if (!c) { console.error('FAILED:', m); process.exit(1) }
  n++; console.log('  ok —', m)
}
// http.request validates the path synchronously; never let it actually connect.
const accepted = (path) => {
  try { const r = http.request({ host: '127.0.0.1', port: 9, path }); r.on('error', () => {}); r.destroy(); return true }
  catch { return false }
}

// The production case: Express hands us DECODED segments of /v1/models/(OR)%20deepseek/deepseek-v4-flash-vision-exp
const spaced = ['models', '(OR) deepseek', 'deepseek-v4-flash-vision-exp']
ok(!accepted('/v1/' + spaced.join('/')), 'control: the old raw join is rejected by http.request')
const p = '/v1/' + joinRestParam(spaced)
ok(p === '/v1/models/(OR)%20deepseek/deepseek-v4-flash-vision-exp', `spaced, parenthesised id encodes to ${p}`)
ok(accepted(p), 'encoded spaced id is accepted by http.request')

// Unchanged: paths that worked before must be byte-identical.
for (const segs of [['chat', 'completions'], ['collections', 'unified_memory', 'points:search'], ['view'], ['a@b', "x!$&'()*+,;=y"]]) {
  ok(joinRestParam(segs) === segs.join('/'), `unchanged: ${segs.join('/')}`)
}
ok(joinRestParam('single') === 'single', 'string param passes through')
ok(joinRestParam(undefined) === undefined, 'undefined stays undefined (callers test truthiness)')

// A decoded "/" or "?" or "#" inside one segment must not invent a path level, query or fragment.
ok(joinRestParam(['a/b', 'c?d#e']) === 'a%2Fb/c%3Fd%23e', 'in-segment / ? # stay encoded')
ok(joinRestParam(['100%']) === '100%25', 'literal % re-encodes (no double-decode)')
ok(joinRestParam(['日本']) === '%E6%97%A5%E6%9C%AC' && accepted('/' + joinRestParam(['日本'])), 'non-ASCII encodes and is accepted')

console.log(`rest-path: ${n} checks passed`)
