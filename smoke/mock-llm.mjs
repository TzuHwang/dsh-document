// A local stand-in for DeepSeek's Messages-compatible endpoint, for the smoke
// test: it records every request and answers deterministically. Copied from
// dsh-editor-template's smoke/mock-llm.mjs, with dsh-document's tools.
//
// Answers "ok", or a tool call when the last user text contains a trigger:
//   TRIGGER_DOC_READ        -> document_read sample.docx
//   TRIGGER_DOC_EDIT        -> document_edit sample.docx (DOC_EDIT)
//   TRIGGER_DOC_EDIT_CLOSED -> document_edit sample.odt (DOC_EDIT_CLOSED)
// After a tool result it answers "done".
import { createServer } from 'node:http'

/** What TRIGGER_DOC_EDIT asks for. */
export const DOC_EDIT = [
  { op: 'style', from: 1, to: 1, style: 'Heading 1' },
  { op: 'replace', find: 'Second paragraph', replace: 'Rewritten by the AI' },
]
/** What TRIGGER_DOC_EDIT_CLOSED asks for. */
export const DOC_EDIT_CLOSED = [{ op: 'insert', after: 0, text: 'Added by the AI' }]

function lastUser(messages) {
  const last = messages.at(-1)
  if (last?.role !== 'user') return { text: '', toolResult: false }
  const parts = typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : last.content
  return { text: parts.map(p => p.text ?? '').join('\n'), toolResult: parts.some(p => p.type === 'tool_result') }
}

function plan(request) {
  const { text, toolResult } = lastUser(request.messages ?? [])
  if (toolResult) return { text: 'done' }
  if (text.includes('TRIGGER_DOC_READ')) return { tool: 'document_read', input: { path: 'sample.docx' } }
  if (text.includes('TRIGGER_DOC_EDIT_CLOSED')) return { tool: 'document_edit', input: { path: 'sample.odt', operations: DOC_EDIT_CLOSED } }
  if (text.includes('TRIGGER_DOC_EDIT')) return { tool: 'document_edit', input: { path: 'sample.docx', operations: DOC_EDIT } }
  return { text: 'ok' }
}

/**
 * Start the endpoint on a free loopback port.
 * @returns {Promise<{ url: string, requests: object[], close(): Promise<void> }>}
 */
export async function startMockLlm() {
  const requests = []
  let counter = 0
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    const request = body ? JSON.parse(body) : {}
    requests.push({ url: req.url, body: request })
    if (!req.url.includes('/messages')) {
      res.setHeader('content-type', 'application/json')
      res.end('{"data":[],"has_more":false}')
      return
    }
    const step = plan(request)
    counter++
    const message = { id: `msg_${counter}`, type: 'message', role: 'assistant', model: request.model ?? 'mock', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } }
    res.setHeader('content-type', 'text/event-stream')
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`)
    send('message_start', { message })
    if (step.tool !== undefined) {
      send('content_block_start', { index: 0, content_block: { type: 'tool_use', id: `toolu_${counter}`, name: step.tool, input: {} } })
      send('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(step.input) } })
      send('content_block_stop', { index: 0 })
      send('message_delta', { delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 1 } })
    } else {
      send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
      send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: step.text } })
      send('content_block_stop', { index: 0 })
      send('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } })
    }
    send('message_stop', {})
    res.end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise(resolve => server.close(() => resolve())),
  }
}

/** Text parts of the last user message of every Messages request, in order. */
export function userTurns(requests) {
  return requests
    .filter(request => request.url.includes('/messages'))
    .map(request => {
      const last = request.body.messages.at(-1)
      const parts = typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : last.content
      return parts.map(part => part.type === 'tool_result' ? `[tool_result] ${JSON.stringify(part.content)}` : part.text ?? '')
    })
}
