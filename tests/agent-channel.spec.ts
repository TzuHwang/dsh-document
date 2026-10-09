import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentChannel, NoPageError } from '../src/agent-channel.ts'
import type { AgentRequest } from '../src/protocol.ts'

/** One open DSH page: its stream as the channel writes it. */
function connectPage(channel: AgentChannel) {
  const req = new EventEmitter() as IncomingMessage
  const written: string[] = []
  const res = { writeHead: vi.fn(), write: (chunk: string) => { written.push(chunk) }, end: vi.fn() } as unknown as ServerResponse
  channel.connect(req, res)
  const id = /^event: page\ndata: (.+)\n\n$/.exec(written[0]!)![1]!
  return {
    id,
    /** Calls sent to this page. */
    requests: (): AgentRequest[] => written.filter(chunk => chunk.startsWith('data: ')).map(chunk => JSON.parse(chunk.slice(6)) as AgentRequest),
    close: () => req.emit('close'),
  }
}

const read = { kind: 'read' } as const
const channels: AgentChannel[] = []
function channel(): AgentChannel {
  const created = new AgentChannel()
  channels.push(created)
  return created
}
afterEach(() => {
  for (const created of channels.splice(0)) created.dispose()
  vi.useRealTimers()
})

describe('AgentChannel', () => {
  it('fails at once when no page is open', async () => {
    await expect(channel().call('s', 'a.docx', read, 1000)).rejects.toBeInstanceOf(NoPageError)
  })

  it('sends a call to every page and resolves with the first answer', async () => {
    const agents = channel()
    const one = connectPage(agents)
    const two = connectPage(agents)
    const result = agents.call('s', 'a.docx', read, 1000)
    const [request] = one.requests()
    expect(request).toMatchObject({ sessionId: 's', path: 'a.docx', operation: read })
    expect(two.requests()).toEqual([request])
    agents.reply({ id: request!.id, page: two.id, ok: true, value: 'text' })
    agents.reply({ id: request!.id, page: one.id, ok: true, value: 'late' })
    await expect(result).resolves.toBe('text')
  })

  it('fails with NoPageError once every page answered unavailable', async () => {
    const agents = channel()
    const one = connectPage(agents)
    const two = connectPage(agents)
    const result = agents.call('s', 'a.docx', read, 1000)
    const id = one.requests()[0]!.id
    agents.reply({ id, page: one.id, ok: false, unavailable: true, error: 'not shown' })
    // A repeated answer from the same page does not count twice.
    agents.reply({ id, page: one.id, ok: false, unavailable: true, error: 'not shown' })
    let settled = false
    void result.catch(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    agents.reply({ id, page: two.id, ok: false, unavailable: true, error: 'not shown' })
    await expect(result).rejects.toBeInstanceOf(NoPageError)
  })

  it('counts a page that closes mid-call as not serving it', async () => {
    const agents = channel()
    const one = connectPage(agents)
    const two = connectPage(agents)
    const result = agents.call('s', 'a.docx', read, 1000)
    agents.reply({ id: one.requests()[0]!.id, page: one.id, ok: false, unavailable: true, error: 'not shown' })
    // Already answered, then closes: still counted once.
    one.close()
    two.close()
    await expect(result).rejects.toBeInstanceOf(NoPageError)
  })

  it('passes a page\'s failure through as the call\'s result', async () => {
    const agents = channel()
    const one = connectPage(agents)
    const result = agents.call('s', 'a.docx', read, 1000)
    agents.reply({ id: one.requests()[0]!.id, page: one.id, ok: false, error: 'block 9 does not exist' })
    await expect(result).rejects.toThrow('block 9 does not exist')
  })

  it('times out without an answer', async () => {
    vi.useFakeTimers()
    const agents = channel()
    connectPage(agents)
    const result = agents.call('s', 'a.docx', read, 1000)
    vi.advanceTimersByTime(1001)
    await expect(result).rejects.toThrow('did not answer in time')
  })
})
