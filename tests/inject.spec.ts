import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { agentEvents, Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentStatus, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import { MemoryStore } from '../src/store.ts'
import { registerAutoInject } from '../src/inject.ts'

/** Build one registry-compatible live agent whose session carries a workspace. */
function stubAgent(rawId: string, workspace: string): Agent {
  const session = Session.create(SessionId(rawId), undefined, {
    version: SESSION_FORMAT_VERSION,
    id: SessionId(rawId),
    createdAt: Date.now(),
    cwd: workspace,
  })
  const status: AgentStatus = 'running'
  const agent: Agent = {
    id: session.id,
    options: {},
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    get status() { return status },
    ctx: new Context(),
    send: () => {},
    followup: () => {},
    steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject() {},
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle() { return Promise.resolve() },
  }
  return agent
}

async function setup(workspace: string) {
  const userRoot = await mkdtemp(join(tmpdir(), 'hippo-inject-user-'))
  const store = new MemoryStore(200, userRoot)
  await store.ensure(workspace)
  const ctx = new Context()
  await ctx.plugin(AgentRegistry)
  registerAutoInject(ctx, store, { limit: 3 })
  return { ctx, store }
}

/** Run the pre-step waterfall with the registered listener. */
async function runStep(
  ctx: Context,
  agent: Agent,
  messages: UserMessage[],
): Promise<PreStepDecision> {
  return await agentEvents(ctx, agent).waterfall(
    'agent/pre-step',
    { messages, turn: 1, step: 1, signal: new AbortController().signal },
    () => Promise.resolve({ kind: 'enter' as const, messages: [...messages] }),
  )
}

function pluginMessages(decision: PreStepDecision): UserMessage[] {
  if (decision.kind === 'reject') return []
  return decision.messages.filter(m =>
    (m.source as { kind?: string }).kind === 'plugin')
}

describe('registerAutoInject', () => {
  it('injects a memory snapshot when recall finds hits', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'hippo-inject-'))
    const { ctx, store } = await setup(workspace)
    await store.create('project', { text: 'This repo uses pnpm.', tags: ['pnpm'] }, { kind: 'explicit' }, workspace)
    const agent = stubAgent('inject-1', workspace)
    ctx.agents.register(agent)

    const decision = await runStep(ctx, agent, [
      createUserMessage({
        content: [{ type: 'text', text: 'How do we install deps here?' }],
        source: { kind: 'user' },
      }),
    ])
    const injected = pluginMessages(decision)
    expect(injected).toHaveLength(1)
    const text = injected[0]!.content.map(b => b.type === 'text' ? b.text : '').join('')
    expect(text).toContain('pnpm')
    // The injected message is a one-time notice (not replaceable state): it
    // must declare form 'notice' with a summary and no sections/snapshot.
    const source = injected[0]!.source as {
      form?: string
      summary?: string
      sections?: unknown
    }
    expect(source.form).toBe('notice')
    expect(typeof source.summary).toBe('string')
    expect(source.summary!.length).toBeGreaterThan(0)
    expect(source.sections).toBeUndefined()
  })

  it('does not inject when recall finds nothing', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'hippo-inject2-'))
    const { ctx } = await setup(workspace)
    const agent = stubAgent('inject-2', workspace)
    ctx.agents.register(agent)

    const decision = await runStep(ctx, agent, [
      createUserMessage({
        content: [{ type: 'text', text: 'completely unrelated topic' }],
        source: { kind: 'user' },
      }),
    ])
    expect(pluginMessages(decision)).toHaveLength(0)
  })

  it('does not inject for non-user (tool) messages', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'hippo-inject3-'))
    const { ctx, store } = await setup(workspace)
    await store.create('user', { text: 'User prefers vim.', tags: ['editor'] }, { kind: 'explicit' })
    const agent = stubAgent('inject-3', workspace)
    ctx.agents.register(agent)

    const toolMessage = createUserMessage({
      content: [{ type: 'text', text: 'which editor?' }],
      source: { kind: 'tool', callId: 'call-1', name: 'bash' } as never,
    })
    const decision = await runStep(ctx, agent, [toolMessage])
    expect(pluginMessages(decision)).toHaveLength(0)
  })

  it('does not re-inject the same query within a session', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'hippo-inject4-'))
    const { ctx, store } = await setup(workspace)
    await store.create('user', { text: 'User prefers vim.', tags: ['editor'] }, { kind: 'explicit' })
    const agent = stubAgent('inject-4', workspace)
    ctx.agents.register(agent)

    const messages = [
      createUserMessage({
        content: [{ type: 'text', text: 'which editor?' }],
        source: { kind: 'user' },
      }),
    ]
    const first = await runStep(ctx, agent, messages)
    const second = await runStep(ctx, agent, messages)
    // First injects; the second deduplicates by query digest.
    expect(pluginMessages(first)).toHaveLength(1)
    expect(pluginMessages(second)).toHaveLength(0)
  })
})
