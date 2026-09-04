import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MemoryStore } from '../src/store.ts'
import {
  AUDIT_MAX_ENTRIES, appendAudit, auditManualDelete, collectAutoExtracted, parseReviewPlan,
  parseReviewVerdict, readAudit, restoreFromAudit, runRuleSweep, sweepStale,
} from '../src/maintenance.ts'

const roots: string[] = []

afterEach(async () => {
  roots.splice(0).forEach(() => {})
})

async function makeStore(): Promise<{ store: MemoryStore; workspace: string; userRoot: string }> {
  const workspace = await mkdtemp(join(tmpdir(), 'hippo-maint-ws-'))
  const userRoot = await mkdtemp(join(tmpdir(), 'hippo-maint-user-'))
  roots.push(workspace, userRoot)
  const store = new MemoryStore(200, userRoot)
  await store.ensure(workspace)
  return { store, workspace, userRoot }
}

describe('maintenance sweep', () => {
  it('removes stale auto-extracted records never recalled', async () => {
    const { store, workspace } = await makeStore()
    // Auto-extracted, old, never recalled → removed.
    await store.create('project', { text: 'stale fact' }, { kind: 'session', sessionId: 's1', turn: 1 }, workspace)
    // Auto-extracted, old, but recalled once → kept.
    const recalled = await store.create('project', { text: 'recalled fact' }, { kind: 'session', sessionId: 's1', turn: 2 }, workspace)
    await store.touch(recalled, workspace)
    // Auto-extracted but fresh → kept.
    await store.create('project', { text: 'fresh fact' }, { kind: 'session', sessionId: 's1', turn: 3 }, workspace)
    // Explicit, old, never recalled → kept (user-intent protection).
    await store.create('project', { text: 'explicit fact' }, { kind: 'explicit' }, workspace)

    const now = Date.now() + 40 * 24 * 60 * 60 * 1000 // 40 days later
    const removed = await sweepStale(store, 'project', workspace, now)

    // stale + fresh are both >30 days old at the sweep time and never
    // recalled; recalled has accessCount>0 and explicit is user-intent.
    expect(removed.map(record => record.text).sort()).toEqual(['fresh fact', 'stale fact'])
    expect(await store.list('project', workspace)).toHaveLength(2)
  })

  it('runRuleSweep covers user + project layers and writes an audit entry', async () => {
    const { store, workspace, userRoot } = await makeStore()
    await store.create('user', { text: 'stale user fact' }, { kind: 'session', sessionId: 's1', turn: 1 })
    await store.create('project', { text: 'stale project fact' }, { kind: 'session', sessionId: 's1', turn: 2 }, workspace)

    const now = Date.now() + 40 * 24 * 60 * 60 * 1000
    const removedCount = await runRuleSweep(store, [{ path: workspace }], userRoot, now)
    expect(removedCount).toBe(2)

    const audit = await readAudit(userRoot)
    expect(audit).toHaveLength(1)
    expect(audit[0]?.layer).toBe('rules')
    expect(audit[0]?.removed).toHaveLength(2)
    expect(audit[0]?.removed.map(item => item.scope).sort()).toEqual(['project', 'user'])
  })

  it('writes no audit entry when nothing was removed', async () => {
    const { store, workspace, userRoot } = await makeStore()
    await store.create('project', { text: 'fresh fact' }, { kind: 'session', sessionId: 's1', turn: 1 }, workspace)
    const removedCount = await runRuleSweep(store, [{ path: workspace }], userRoot)
    expect(removedCount).toBe(0)
    expect(await readAudit(userRoot)).toHaveLength(0)
  })
})

describe('audit log trimming', () => {
  it('keeps only the newest AUDIT_MAX_ENTRIES entries', async () => {
    const userRoot = await mkdtemp(join(tmpdir(), 'hippo-audit-trim-'))
    roots.push(userRoot)
    for (let index = 0; index < AUDIT_MAX_ENTRIES + 10; index += 1) {
      await appendAudit({
        time: index,
        layer: 'manual',
        reason: `test ${index}`,
        removed: [{ id: `id-${index}`, scope: 'project', text: `fact ${index}` }],
      }, userRoot)
    }
    const audit = await readAudit(userRoot)
    expect(audit).toHaveLength(AUDIT_MAX_ENTRIES)
    // readAudit returns newest first, so the highest time leads.
    expect(audit[0]?.time).toBe(AUDIT_MAX_ENTRIES + 9)
    expect(audit[AUDIT_MAX_ENTRIES - 1]?.time).toBe(10)
  })
})

describe('parseReviewVerdict', () => {
  it('parses a JSON array of ids from model output', () => {
    const ids = parseReviewVerdict('Here are the duplicates:\n["a1","b2"]')
    expect(ids).toEqual(['a1', 'b2'])
  })

  it('returns an empty array for an empty verdict', () => {
    expect(parseReviewVerdict('[]')).toEqual([])
    expect(parseReviewVerdict('nothing to delete')).toEqual([])
  })

  it('ignores malformed output', () => {
    expect(parseReviewVerdict('not json at all')).toEqual([])
  })
})

describe('parseReviewPlan', () => {
  it('parses delete ids and merge groups from the review plan JSON', () => {
    const plan = parseReviewPlan('Here is my plan:\n```json\n{"delete":["d1","d2"],"merge":[{"ids":["m1","m2"],"text":"Merged fact","tags":["a","b"]}]}\n```')
    expect(plan.delete).toEqual(['d1', 'd2'])
    expect(plan.merge).toHaveLength(1)
    expect(plan.merge[0]?.ids).toEqual(['m1', 'm2'])
    expect(plan.merge[0]?.text).toBe('Merged fact')
    expect(plan.merge[0]?.tags).toEqual(['a', 'b'])
  })

  it('drops merge groups with too few ids or empty text', () => {
    const plan = parseReviewPlan('{"delete":[],"merge":[{"ids":["only-one"],"text":"x"},{"ids":["a","b"],"text":""}]}')
    expect(plan.delete).toEqual([])
    expect(plan.merge).toEqual([])
  })

  it('returns an empty plan for malformed output', () => {
    expect(parseReviewPlan('not json at all')).toEqual({ delete: [], merge: [] })
  })
})

describe('audit restore', () => {
  it('restores a project record into its original workspace with its id', async () => {
    const { store, workspace, userRoot } = await makeStore()
    const record = await store.create('project', { text: 'precious fact', tags: ['a'] }, { kind: 'session', sessionId: 's1', turn: 1 }, workspace)
    await store.delete(record.id, workspace)
    await auditManualDelete(record, workspace, userRoot)
    // Deleted; record gone.
    expect(await store.get(record.id, workspace)).toBeUndefined()

    const audit = await readAudit(userRoot)
    const item = audit.flatMap(entry => entry.removed).find(removed => removed.id === record.id)
    expect(item).toBeDefined()
    expect(item?.workspace).toBe(workspace)

    const restoredId = await restoreFromAudit(item!, store)
    expect(restoredId).toBe(record.id)
    const restored = await store.get(record.id, workspace)
    expect(restored?.text).toBe('precious fact')
    expect(restored?.tags).toEqual(['a'])
  })

  it('refuses to restore when the record already exists', async () => {
    const { store, workspace } = await makeStore()
    const record = await store.create('project', { text: 'existing fact' }, { kind: 'session', sessionId: 's1', turn: 1 }, workspace)
    const item = { id: record.id, scope: record.scope as 'project', workspace, text: 'existing fact' }
    expect(await restoreFromAudit(item, store)).toBeUndefined()
  })
})

describe('LLM review window', () => {
  it('collectAutoExtracted skips records reviewed within the 4h window', async () => {
    const { store, workspace } = await makeStore()
    // Fresh auto record (never reviewed) → collected.
    await store.create('project', { text: 'never reviewed' }, { kind: 'session', sessionId: 's1', turn: 1 }, workspace)
    // Auto record reviewed 1h ago → skipped (inside window).
    const recent = await store.create('project', { text: 'reviewed 1h ago' }, { kind: 'session', sessionId: 's1', turn: 2 }, workspace)
    await store.touchReviewed(recent.id, workspace, Date.now() - 60 * 60 * 1000)
    // Auto record reviewed 5h ago → collected (outside window).
    const old = await store.create('project', { text: 'reviewed 5h ago' }, { kind: 'session', sessionId: 's1', turn: 3 }, workspace)
    await store.touchReviewed(old.id, workspace, Date.now() - 5 * 60 * 60 * 1000)
    // Explicit record → never collected.
    await store.create('project', { text: 'explicit' }, { kind: 'explicit' }, workspace)

    const candidates = await collectAutoExtracted(store, [{ path: workspace }])
    const texts = candidates.map(candidate => candidate.record.text).sort()
    expect(texts).toEqual(['never reviewed', 'reviewed 5h ago'])
  })

  it('touchReviewed stamps a record and persists across reads', async () => {
    const { store, workspace } = await makeStore()
    const record = await store.create('project', { text: 'stamp me' }, { kind: 'session', sessionId: 's1', turn: 1 }, workspace)
    const at = Date.now() - 1234
    expect(await store.touchReviewed(record.id, workspace, at)).toBe(true)
    const reloaded = await store.get(record.id, workspace)
    expect(reloaded?.lastReviewedAt).toBe(at)
    // Missing id is a no-op, not an error.
    expect(await store.touchReviewed('no-such-id', workspace, at)).toBe(false)
  })
})
