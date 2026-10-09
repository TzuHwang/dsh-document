/**
 * The document engine. Placeholder until LibreOffice (ZetaOffice, in an
 * isolated iframe) is wired in: it proves the registration and mounting path.
 */
import type { SelfManagedEngine } from '@dsh-editor/core'

/** Formats LibreOffice Writer opens and saves. */
export const EXTENSIONS = ['doc', 'docx', 'odt'] as const

export const documentEngine: SelfManagedEngine = {
  id: 'dsh-document',
  extensions: EXTENSIONS,
  selfManaged: true,
  mount(host, binding) {
    const view = host.ownerDocument.createElement('div')
    view.dataset.testid = 'dsh-document-placeholder'
    view.style.padding = '16px'
    view.style.fontSize = '13px'
    view.textContent = `${binding.path}: the LibreOffice editor is not wired in yet.`
    host.append(view)
    return {
      flush: async () => {},
      focus() {},
      destroy() { view.remove() },
    }
  },
}
