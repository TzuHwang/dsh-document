/**
 * dsh-document's browser plugin: registers the document engine for `.doc`,
 * `.docx` and `.odt` with the editor from dsh-editor-template, runs the AI's
 * document tools in this page, and adds a page to DSH's settings.
 *
 * The engine is self-managed: the template's core reads and saves text only,
 * so this plugin brings its own reading, saving and file watching, and the core
 * only mounts the engine in the center beside the AI chat.
 */
import type { CordisContext, EditorService, Translate } from '@dsh-editor/core'
import { Documents, startBridge, type BridgeDeps } from './bridge.ts'
import { createDocumentEngine } from './engine.ts'
import type { WorkspaceFiles } from './file-io.ts'
import { en, zh } from './locales.ts'
import { Settings, type ConfigFormSnapshot } from './settings.tsx'

export const name = 'dsh-document'
export const inject = ['editor', 'remote', 'remote.workspaceFiles', 'locale', 'slots', 'sessions', 'uiSession']

/** Locale namespace of this plugin's own text. */
const NS = 'dshDocument'
/** Profile entry id of this plugin's row; its settings are read from that entry's config form. */
const ENTRY_ID = 'dsh-document'

interface Locale {
  register(ns: string, dicts: Record<string, object>): () => void
  bind(ns: string): Translate
}
interface ConfigForm {
  getSnapshot(): ConfigFormSnapshot
  subscribe(listener: () => void): () => void
  set(field: string, value: unknown): Promise<boolean>
}
interface ConfigForms {
  get(id: string): ConfigForm
  whileServed(namespaces: readonly string[], register: () => () => void): () => void
}
interface Slots {
  inject(name: string, callback: () => () => void): () => void
  register(options: object, component: (props: never) => unknown): () => void
}

export function apply(ctx: CordisContext): void {
  const editor = ctx.editor as EditorService
  const files = (ctx.remote as { workspaceFiles: WorkspaceFiles }).workspaceFiles
  const locale = ctx.locale as Locale
  const t = locale.bind(NS)
  ctx.effect(() => locale.register(NS, { zh, en }), 'dsh-document: dictionaries')

  const documents = new Documents()
  ctx.effect(() => editor.engines.register(createDocumentEngine(files, t, documents.register)), 'dsh-document: document engine')
  ctx.effect(() => startBridge(documents, {
    editor,
    current: (ctx.uiSession as { adapter: { current: BridgeDeps['current'] } }).adapter.current,
    sessions: (ctx.sessions as { list: BridgeDeps['sessions'] }).list,
  }), 'dsh-document: AI tools in this page')

  // The page in DSH's settings, while the host serves this entry's settings.
  const forms = ctx.get('configForms') as ConfigForms | undefined
  if (forms !== undefined) {
    const form = forms.get(ENTRY_ID)
    const slots = ctx.slots as Slots
    ctx.effect(() => forms.whileServed([ENTRY_ID], () => slots.inject('settings.section', () => slots.register(
      {
        name: 'settings.section',
        id: 'dsh-document',
        order: 31,
        label: () => t('settings.nav'),
        locale: NS,
        inject: () => ({
          set: (field: 'confirmEdits', value: boolean) => form.set(field, value).catch(() => false),
          hooks: { form },
        }),
      },
      Settings as (props: never) => unknown,
    ))), 'dsh-document: settings page')
  }
}
