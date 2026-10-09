/**
 * dsh-document's browser plugin: registers the document engine for `.doc`,
 * `.docx` and `.odt` with the editor from dsh-editor-template.
 *
 * The engine is self-managed: the template's core reads and saves text only,
 * so this plugin brings its own reading, saving and file watching, and the core
 * only mounts the engine in the center beside the AI chat.
 */
import type { CordisContext, EditorService } from '@dsh-editor/core'
import { documentEngine } from './engine.ts'

export const name = 'dsh-document'
export const inject = ['editor']

export function apply(ctx: CordisContext): void {
  const editor = ctx.editor as EditorService
  ctx.effect(() => editor.engines.register(documentEngine), 'dsh-document: document engine')
}
