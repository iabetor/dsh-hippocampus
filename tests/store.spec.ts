import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MemoryStore, keywordScore } from '../src/store.ts'
import type { MemoryRecord } from '../src/types.ts'

const roots: string[] = []

afterEach(async () => {
  roots.splice(0).forEach(() => {})
})

async function makeStore(maxUserRecords = 200): Promise<{ store: MemoryStore; workspace: string }> {
  const workspace = await mkdtemp(join(tmpdir(), 'hippo-proj-'))
  const userRoot = await mkdtemp(join(tmpdir(), 'hippo-user-'))
  roots.push(workspace, userRoot)
  const store = new MemoryStore(maxUserRecords, userRoot)
  await store.ensure(workspace)
  return { store, workspace }
}

describe('MemoryStore', () => {
  it('creates and reads records in the project layer', async () => {
    const { store, workspace } = await makeStore()
    const record = await store.create('project', { text: 'This repo uses pnpm workspaces.' }, { kind: 'explicit' }, workspace)
    expect(record.scope).toBe('project')
    expect(record.source).toEqual({ kind: 'explicit' })
    const listed = await store.list('project', workspace)
    expect(listed).toHaveLength(1)
    expect(listed[0]?.text).toBe('This repo uses pnpm workspaces.')
  })

  it('deduplicates by normalized text within the same scope', async () => {
    const { store, workspace } = await makeStore()
    const first = await store.create('project', { text: 'User prefers Python.' }, { kind: 'explicit' }, workspace)
    const second = await store.create('project', { text: 'user prefers python.' }, { kind: 'explicit' }, workspace)
    expect(second.id).toBe(first.id)
    expect(await store.list('project', workspace)).toHaveLength(1)
  })

  it('keeps project and user layers isolated', async () => {
    const { store, workspace } = await makeStore()
    await store.create('project', { text: 'project fact' }, { kind: 'explicit' }, workspace)
    await store.create('user', { text: 'user fact' }, { kind: 'explicit' })
    expect(await store.list('project', workspace)).toHaveLength(1)
    expect(await store.list('user', workspace)).toHaveLength(1)
    // A different workspace sees an empty project layer.
    const otherWorkspace = await mkdtemp(join(tmpdir(), 'hippo-other-'))
    roots.push(otherWorkspace)
    expect(await store.list('project', otherWorkspace)).toHaveLength(0)
  })

  it('deletes across scopes and resolves true only when present', async () => {
    const { store, workspace } = await makeStore()
    const record = await store.create('project', { text: 'temp' }, { kind: 'explicit' }, workspace)
    expect(await store.delete(record.id, workspace)).toBe(true)
    expect(await store.delete(record.id, workspace)).toBe(false)
  })

  it('recalls project first then user as fallback', async () => {
    const { store, workspace } = await makeStore()
    await store.create('project', { text: 'The build uses pnpm.' }, { kind: 'explicit' }, workspace)
    await store.create('user', { text: 'User prefers vim.' }, { kind: 'explicit' })
    const hits = await store.recall('vim', { workspace })
    expect(hits).toHaveLength(1)
    expect(hits[0]?.record.text).toBe('User prefers vim.')
    expect(hits[0]?.record.scope).toBe('user')
  })

  it('bumps access statistics on recall', async () => {
    const { store, workspace } = await makeStore()
    const record = await store.create('project', { text: 'Use pnpm for installs.' }, { kind: 'explicit' }, workspace)
    await store.recall('pnpm', { workspace })
    const listed = await store.list('project', workspace)
    expect(listed[0]?.accessCount).toBe(1)
    expect(listed[0]?.lastAccessedAt).toBeTypeOf('number')
    void record
  })

  it('evicts the least-recently-accessed user records over the cap', async () => {
    const { store, workspace } = await makeStore(2)
    const a = await store.create('user', { text: 'a' }, { kind: 'explicit' })
    await store.recall('a', { workspace })
    const b = await store.create('user', { text: 'b' }, { kind: 'explicit' })
    await store.recall('b', { workspace })
    // Cap is 2; the third create evicts the least-recently-accessed (a).
    await store.create('user', { text: 'c' }, { kind: 'explicit' })
    const remaining = await store.list('user', workspace)
    expect(remaining.map(r => r.text).sort()).toEqual(['b', 'c'])
    void a
    void b
  })

  it('keywordScore ranks exact-token overlap', () => {
    const record: MemoryRecord = {
      id: '00000000-0000-4000-8000-000000000000',
      text: 'The user likes Python',
      scope: 'project',
      tags: ['coding'],
      source: { kind: 'explicit' },
      createdAt: 1,
      updatedAt: 1,
      accessCount: 0,
    }
    expect(keywordScore(record, 'python coding')).toBe(1)
    expect(keywordScore(record, 'python rust')).toBe(0.5)
    expect(keywordScore(record, 'rust')).toBe(0)
  })

  it('logs and aggregates per-session recalls', async () => {
    const { store, workspace } = await makeStore()
    const project = await store.create('project', { text: 'Project build uses pnpm.' }, { kind: 'explicit' }, workspace)
    const user = await store.create('user', { text: 'User prefers vim.' }, { kind: 'explicit' })
    // Empty session id is ignored.
    await store.recordRecall('', project.id, workspace)
    expect(await store.recallsFor('sess-1', workspace)).toHaveLength(0)

    await store.recordRecall('sess-1', project.id, workspace, 'pnpm')
    await store.recordRecall('sess-1', project.id, workspace, 'pnpm build')
    await store.recordRecall('sess-1', user.id, workspace, 'vim')
    const aggregates = await store.recallsFor('sess-1', workspace)
    // Both records aggregated, regardless of same-millisecond ordering.
    expect(aggregates).toHaveLength(2)
    const projectAgg = aggregates.find(a => a.record.id === project.id)
    expect(projectAgg?.count).toBe(2)
    expect(projectAgg?.lastAt).toBeTypeOf('number')
    const userAgg = aggregates.find(a => a.record.id === user.id)
    expect(userAgg?.count).toBe(1)
    // Limit applies.
    expect(await store.recallsFor('sess-1', workspace, 1)).toHaveLength(1)
  })

  it('drops recall entries whose record was deleted', async () => {
    const { store, workspace } = await makeStore()
    const record = await store.create('project', { text: 'temp fact' }, { kind: 'explicit' }, workspace)
    await store.recordRecall('sess-2', record.id, workspace)
    await store.delete(record.id, workspace)
    expect(await store.recallsFor('sess-2', workspace)).toHaveLength(0)
  })
})
