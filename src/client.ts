/**
 * dsh-document's browser plugin: registers the document engine for `.doc`,
 * `.docx` and `.odt` with the editor from dsh-editor-template.
 *
 * The engine is self-managed: the template's core reads and saves text only,
 * so this plugin brings its own reading, saving and file watching, and the core
 * only mounts the engine in the center beside the AI chat.
 */
import type { CordisContext, EditorService, Translate } from '@dsh-editor/core'
import { createDocumentEngine, type WorkspaceFiles } from './engine.ts'
import { en, zh } from './locales.ts'

export const name = 'dsh-document'
export const inject = ['editor', 'remote', 'remote.workspaceFiles', 'locale']

/** Locale namespace of the engine's own text. */
const NS = 'dshDocument'

interface Locale {
  register(ns: string, dicts: Record<string, object>): () => void
  bind(ns: string): Translate
}

export function apply(ctx: CordisContext): void {
  const editor = ctx.editor as EditorService
  const files = (ctx.remote as { workspaceFiles: WorkspaceFiles }).workspaceFiles
  const locale = ctx.locale as Locale
  ctx.effect(() => locale.register(NS, { zh, en }), 'dsh-document: dictionaries')
  ctx.effect(() => editor.engines.register(createDocumentEngine(files, locale.bind(NS))), 'dsh-document: document engine')
}
