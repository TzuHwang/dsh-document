/**
 * The AI's document tools. Both run in the user's LibreOffice, in the DSH page
 * that shows the session (opened in the center when needed), through the
 * agent channel: edits show live, are one undo step, and are saved to the file.
 */
import { relative, sep } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { NoPageError, type AgentChannel } from './agent-channel.ts'
import type { DocumentRead, EditOperation, EditResult } from './protocol.ts'

/** Formats the tools take (LibreOffice Writer's). */
const EXTENSIONS = ['doc', 'docx', 'odt']
/** Opening a document may start LibreOffice in the page first (a download the first time). */
const CALL_TIMEOUT_MS = 180_000

// Host services, typed locally.
export interface FsTarget { readonly __target: unique symbol }
export interface ToolsHost {
  fs: {
    resolve(path: string, options?: { cwd?: string }): Promise<FsTarget>
    contains(parent: FsTarget, child: FsTarget): boolean
    processPath(target: FsTarget): string
  }
  sandboxPolicy: { workspaceRoot: string }
  tools: { register(tool: unknown): () => void }
  on(event: 'tools/pre-execute', listener: (exec: ToolCall, next: () => Promise<unknown>) => Promise<unknown>): () => void
  effect(factory: () => () => void, label?: string): () => void
}

/** What the tool pipeline hands over about a call (the part used here). */
interface ToolCall {
  readonly name: string
  readonly arguments: unknown
  readonly signal: AbortSignal
  readonly agent?: { readonly session: { readonly id: string; readonly header: { readonly cwd?: string } } }
}

/** A tool's argument `path`, as the session's file addresses carry it. */
async function documentPath(host: ToolsHost, call: ToolCall, path: string): Promise<{ sessionId: string; path: string }> {
  const session = call.agent?.session
  if (session === undefined) throw new Error('this tool runs only in a session')
  const workspaceRoot = session.header.cwd ?? host.sandboxPolicy.workspaceRoot
  const root = await host.fs.resolve(workspaceRoot)
  const target = await host.fs.resolve(path, { cwd: workspaceRoot })
  if (!host.fs.contains(root, target)) throw new Error(`${path} is outside the session's workspace`)
  const inWorkspace = relative(host.fs.processPath(root), host.fs.processPath(target)).split(sep).join('/')
  const extension = inWorkspace.slice(inWorkspace.lastIndexOf('.') + 1).toLowerCase()
  if (!EXTENSIONS.includes(extension)) throw new Error(`${path} is not a .doc, .docx or .odt document`)
  return { sessionId: session.id, path: inWorkspace }
}

/** Calls go to the user's open DSH page; say what to do when there is none. */
function explain(error: unknown): Error {
  if (error instanceof NoPageError) {
    return new Error(`${error.message}. These tools work in the user's DSH editor: ask the user to open this session in DSH in the browser with Editor mode on.`)
  }
  return error instanceof Error ? error : new Error(String(error))
}

function formatRead(path: string, read: DocumentRead): string {
  if (read.total === 0) return `${path} is empty.`
  const first = read.blocks[0]?.index ?? 1
  const last = read.blocks.at(-1)?.index ?? first
  const lines = [`${path}: ${read.total} block(s); showing ${first}–${last}.`]
  for (const block of read.blocks) {
    const body = block.text.replace(/\n/g, '\n    ')
    lines.push(block.kind === 'table'
      ? `[${block.index}] table ${block.rows}×${block.columns}:\n    ${body}`
      : `[${block.index}] (${block.style}) ${body}`)
  }
  if (last < read.total) lines.push(`… ${read.total - last} more block(s): read from ${last + 1}.`)
  return lines.join('\n')
}

const range = {
  from: { type: 'integer', description: 'First block (1-based).' },
  to: { type: 'integer', description: 'Last block, inclusive.' },
} as const
const scoped = {
  from: { type: 'integer', description: 'Only in blocks from this one (1-based); whole document when omitted.' },
  to: { type: 'integer', description: 'Only in blocks up to this one, inclusive.' },
  matchCase: { type: 'boolean', description: 'Case-sensitive match; default false.' },
} as const

export function registerTools(host: ToolsHost, channel: AgentChannel, confirmEdits: () => boolean): void {
  host.effect(() => host.tools.register(defineTool({
    name: 'document_read',
    description: [
      'Read a Word or OpenDocument text document (.doc, .docx, .odt) as the user\'s editor has it, unsaved changes included.',
      'The body is a list of numbered blocks: paragraphs (with their paragraph style, e.g. "Heading 1") and tables.',
      'Use the block numbers with document_edit. Opens the document in the user\'s editor if it is not open.',
      'Prefer this over reading the file with other tools: they cannot see unsaved changes and cannot read .doc.',
    ].join(' '),
    parameters: {
      path: { type: 'string', required: true, description: 'The document, relative to the workspace or absolute.' },
      ...range,
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      const call = exec as unknown as ToolCall
      const target = await documentPath(host, call, args.path)
      const read = await channel.call(target.sessionId, target.path, { kind: 'read', from: args.from, to: args.to }, CALL_TIMEOUT_MS, call.signal).catch((error: unknown) => { throw explain(error) })
      return formatRead(target.path, read as DocumentRead)
    },
  })), 'dsh-document: document_read')

  host.effect(() => host.tools.register(defineTool({
    name: 'document_edit',
    description: [
      'Edit a Word or OpenDocument text document (.doc, .docx, .odt) in the user\'s editor, where the change shows at once.',
      'Read it first with document_read for block numbers and style names.',
      'Operations apply in order as one undo step (the user undoes all of them with one Ctrl+Z); if one fails, none is applied.',
      'Block numbers refer to the document as each operation runs: an insert or delete shifts later blocks, so edit from the end backwards.',
      'Paragraph styles take their internal English names as document_read shows them (e.g. "Standard", "Text body", "Heading 1").',
      'The document is saved to its file, in its own format, afterwards.',
    ].join(' '),
    parameters: {
      path: { type: 'string', required: true, description: 'The document, relative to the workspace or absolute.' },
      operations: {
        type: 'array',
        required: true,
        description: 'Edits, applied in order.',
        items: {
          oneOf: [
            {
              type: 'object',
              additionalProperties: false,
              description: 'Replace every occurrence of `find` with `replace` (keeps the surrounding formatting).',
              properties: {
                op: { type: 'string', enum: ['replace'], required: true },
                find: { type: 'string', required: true },
                replace: { type: 'string', required: true },
                ...scoped,
              },
            },
            {
              type: 'object',
              additionalProperties: false,
              description: 'Insert paragraphs, one per line of `text`, after block `after` (0: at the start).',
              properties: {
                op: { type: 'string', enum: ['insert'], required: true },
                after: { type: 'integer', required: true },
                text: { type: 'string', required: true },
                style: { type: 'string', description: 'Paragraph style of the new paragraphs; otherwise they continue the style of block `after`.' },
              },
            },
            {
              type: 'object',
              additionalProperties: false,
              description: 'Delete paragraphs `from`–`to` (inclusive). Tables cannot be deleted.',
              properties: {
                op: { type: 'string', enum: ['delete'], required: true },
                from: { type: 'integer', required: true },
                to: { type: 'integer', required: true },
              },
            },
            {
              type: 'object',
              additionalProperties: false,
              description: 'Give paragraphs `from`–`to` a paragraph style.',
              properties: {
                op: { type: 'string', enum: ['style'], required: true },
                from: { type: 'integer', required: true },
                to: { type: 'integer', required: true },
                style: { type: 'string', required: true },
              },
            },
            {
              type: 'object',
              additionalProperties: false,
              description: 'Turn bold / italic / underline on (true) or off (false) for every occurrence of `find`.',
              properties: {
                op: { type: 'string', enum: ['format'], required: true },
                find: { type: 'string', required: true },
                bold: { type: 'boolean' },
                italic: { type: 'boolean' },
                underline: { type: 'boolean' },
                ...scoped,
              },
            },
          ],
        },
      },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      const call = exec as unknown as ToolCall
      const target = await documentPath(host, call, args.path)
      const operations = args.operations as unknown as EditOperation[]
      const result = await channel.call(target.sessionId, target.path, { kind: 'edit', operations }, CALL_TIMEOUT_MS, call.signal).catch((error: unknown) => { throw explain(error) }) as EditResult
      return [
        `Edited ${target.path} as one undo step, and saved it:`,
        ...result.applied.map(line => `- ${line}`),
        `The document now has ${result.total} block(s).`,
      ].join('\n')
    },
  })), 'dsh-document: document_edit')

  // Ask the user before each edit, while the setting says so.
  host.effect(() => host.on('tools/pre-execute', async (call, next) => {
    if (call.name !== 'document_edit' || !confirmEdits()) return next()
    const args = call.arguments as { path?: unknown; operations?: unknown }
    const path = typeof args.path === 'string' ? args.path : '?'
    const count = Array.isArray(args.operations) ? args.operations.length : 0
    return {
      kind: 'ask',
      reason: `document_edit: ${count} operation(s) on ${path}`,
      displayReason: {
        en: `The AI wants to edit ${path} (${count} change(s)).`,
        zh: `AI 想要修改 ${path}（${count} 项更改）。`,
      },
    }
  }), 'dsh-document: confirm edits')
}
