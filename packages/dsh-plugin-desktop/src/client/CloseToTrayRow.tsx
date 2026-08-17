/**
 * The close-window behavior row in the settings General section: title,
 * description, and a two-option selector (quit the app / minimize to tray),
 * following the harness row pattern — status-gated rendering and a disabled
 * trigger while the stored preference is still loading.
 */

import { useState, type JSX } from 'react'
import { IconChevronDownOutline14, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { CloseBehaviorState } from './close-behavior-policy.ts'
import styles from './CloseToTrayRow.module.css'

/** The two selectable close-window behaviors, keyed by their locale entries. */
const OPTIONS = [
  { id: 'quit', label: 'settings.desktop.options.quit' },
  { id: 'tray', label: 'settings.desktop.options.tray' },
] as const

/** Registration-side preference face. */
export interface CloseToTrayRowInjected {
  hooks: {
    /** Close-window preference state bound as `useCloseToTray`. */
    closeToTray: SnapshotStore<CloseBehaviorState>
  }
  /** Change the close-window behavior. */
  setCloseToTray: (value: boolean) => void
}

/** Full Settings-row props: runtime share + locale seat + injected face. */
export type CloseToTrayRowProps = PropsRuntime<'settings.general.item'> & PropsLocale<'settings.desktop'> & InjectFace<CloseToTrayRowInjected>

/**
 * Render the close-window behavior selector.
 * @param props - composed slot props.
 * @returns the row element tree.
 */
export function CloseToTrayRow({ useCloseToTray, setCloseToTray, t }: CloseToTrayRowProps): JSX.Element | null {
  const state = useCloseToTray((snapshot) => snapshot)
  const [open, setOpen] = useState(false)
  if (state.status === 'unavailable') return null
  const selectedLabel = state.closeToTray ? 'settings.desktop.options.tray' : 'settings.desktop.options.quit'
  return (
    <div className={styles.row}>
      <div className={styles.rowText}>
        <div className={styles.title}>{t('settings.desktop.title')}</div>
        <div className={styles.desc}>{t('settings.desktop.description')}</div>
      </div>
      <Menu
        open={open}
        onClose={() => setOpen(false)}
        items={OPTIONS.map((option) => ({ id: option.id, label: t(option.label) }))}
        selectedId={state.closeToTray ? 'tray' : 'quit'}
        onSelect={(id) => {
          setOpen(false)
          setCloseToTray(id === 'tray')
        }}
        align="end"
        portal
        anchor={(
          <button
            type="button"
            className={styles.selector}
            aria-haspopup="menu"
            aria-expanded={open}
            disabled={state.status === 'loading'}
            onClick={() => setOpen((value) => !value)}
          >
            {t(selectedLabel)}
            <IconChevronDownOutline14 className={styles.chevron} />
          </button>
        )}
      />
    </div>
  )
}
