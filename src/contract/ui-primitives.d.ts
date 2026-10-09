/**
 * DSH's shared UI primitives, typed locally (as dsh-editor-template does). The
 * package is in the Web Client's baseline module table, so the browser bundle
 * imports it at run time (external in our build). Verified against 0.2.0-rc.2.
 */
declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type { ReactNode } from 'react'

  export function Switch(props: {
    checked: boolean
    onChange: (next: boolean) => void
    label: string
    disabled?: boolean
    title?: string
  }): ReactNode
}
