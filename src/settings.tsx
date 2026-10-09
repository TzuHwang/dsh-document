/**
 * dsh-document's page in DSH's settings (the `settings.section` slot), laid out
 * like DSH's own pages and the template's Editor mode page. Values are this
 * entry's volatile config, written through its config form; they apply at once.
 */
import { Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Translate } from '@dsh-editor/core'
import { useEffect, useState } from 'react'

export interface ConfigFormSnapshot {
  readonly status: 'loading' | 'ready' | 'unavailable'
  readonly value: { readonly confirmEdits?: boolean } | undefined
}

export interface SettingsProps {
  readonly t: Translate
  readonly useForm: <T>(selector: (snapshot: ConfigFormSnapshot) => T) => T
  /** Save one setting; resolves whether it was stored. */
  readonly set: (field: 'confirmEdits', value: boolean) => Promise<boolean>
}

// DSH's own settings look, on DSH's theme variables.
const page = { display: 'flex', flexDirection: 'column', width: '100%' } as const
const heading = { fontSize: 18, fontWeight: 600, lineHeight: '26px', color: 'var(--dsw-alias-label-primary)' } as const
const intro = { fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-tertiary)', margin: '4px 0 8px' } as const
const row = {
  display: 'flex', alignItems: 'center', gap: 8, padding: '16px 0',
  borderBottom: '0.5px solid var(--dsw-alias-border-l2)',
} as const
const rowText = { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4, paddingRight: 48 } as const
const title = { fontSize: 14, lineHeight: '22px', color: 'var(--dsw-alias-label-primary)' } as const
const desc = { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' } as const

export function Settings({ t, useForm, set }: SettingsProps) {
  const ready = useForm(snapshot => snapshot.status === 'ready')
  // The default is to ask.
  const saved = useForm(snapshot => snapshot.value?.confirmEdits !== false)
  // The form answers after the write round-trips; show the choice at once.
  const [pending, setPending] = useState<boolean | undefined>(undefined)
  useEffect(() => { if (pending === saved) setPending(undefined) }, [pending, saved])
  const confirmEdits = pending ?? saved
  return (
    <div data-testid="dsh-document-settings" style={page}>
      <div style={heading}>{t('settings.title')}</div>
      <div style={intro}>{t('settings.description')}</div>
      <div style={row}>
        <div style={rowText}>
          <div style={title}>{t('settings.confirmEdits')}</div>
          <div style={desc}>{t(confirmEdits ? 'settings.confirmEdits.on' : 'settings.confirmEdits.off')}</div>
        </div>
        <span data-testid="dsh-document-settings-confirm">
          <Switch
            checked={confirmEdits}
            label={t('settings.confirmEdits')}
            disabled={!ready}
            onChange={(next) => {
              setPending(next)
              void set('confirmEdits', next)
            }}
          />
        </span>
      </div>
    </div>
  )
}
