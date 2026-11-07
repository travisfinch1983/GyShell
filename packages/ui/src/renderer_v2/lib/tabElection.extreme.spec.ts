/**
 * tabElection spec: every tab runs pickWinner over the same candidate set, so the
 * function being deterministic and total IS the single-open guarantee. Checks the
 * priority order (focus > visible > hidden, then recency, then tabId), agreement
 * across permutations, and the no-focused-tab case (most recent activity wins —
 * a drop is never dropped).
 * Run: tsx packages/ui/src/renderer_v2/lib/tabElection.extreme.spec.ts
 */
import { pickWinner } from './tabElection'

const assert = (cond: boolean, msg: string): void => {
  if (!cond) throw new Error(msg)
}

const c = (tabId: string, score: number, lastActive: number) => ({ key: 'k', tabId, score, lastActive })

// 1. Focus beats visible beats hidden, whatever the recency says.
assert(pickWinner([c('a', 2, 0), c('b', 1, 9999)])!.tabId === 'a', 'focused beats visible')
assert(pickWinner([c('a', 1, 0), c('b', 0, 9999)])!.tabId === 'a', 'visible beats hidden')

// 2. No tab focused: the most recently ACTIVE one wins — the drop still opens somewhere.
assert(pickWinner([c('a', 0, 100), c('b', 0, 300), c('x', 0, 200)])!.tabId === 'b', 'recency wins when nothing is focused')

// 3. Full tie: deterministic tabId tie-break.
assert(pickWinner([c('a', 1, 50), c('b', 1, 50)])!.tabId === 'b', 'tabId breaks exact ties')

// 4. Permutation agreement: every ordering of the same set yields the same winner —
// this is what lets each tab decide alone without a coordinator.
const set = [c('t1', 1, 10), c('t2', 2, 5), c('t3', 2, 5), c('t4', 0, 99)]
const perms: typeof set[] = []
const permute = (arr: typeof set, head: typeof set = []): void => {
  if (arr.length === 0) { perms.push(head); return }
  arr.forEach((x, i) => permute([...arr.slice(0, i), ...arr.slice(i + 1)], [...head, x]))
}
permute(set)
const winners = new Set(perms.map((p) => pickWinner(p)!.tabId))
assert(winners.size === 1 && winners.has('t3'), `all ${perms.length} permutations agree (got ${[...winners].join(',')})`)

// 5. Edge cases: empty set is null (caller fail-opens), single candidate wins.
assert(pickWinner([]) === null, 'empty set is null')
assert(pickWinner([c('only', 0, 0)])!.tabId === 'only', 'single candidate wins its own election')

console.log('tabElection.extreme.spec: all assertions passed')
