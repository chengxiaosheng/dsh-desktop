/**
 * The restart-host row in the settings General section: a button asking the
 * main process to re-boot the host in-process, so pending plugin changes (the
 * plugin market's "needs restart" banner) take effect without restarting the
 * application. The window reloads; the process, tray, and window stay up.
 */

import { useState, type JSX } from 'react'
import type { PropsLocale, PropsRuntime, InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import styles from './settings-row.module.css'

/** Registration-side injected face. */
export interface RestartHostRowInjected {
  /** Ask the main process to re-boot the host in-process. */
  restartHost: () => Promise<void>
}

/** Full Settings-row props: runtime share + locale seat + injected face. */
export type RestartHostRowProps = PropsRuntime<'settings.general.item'> & PropsLocale<'settings.desktop'> & InjectFace<RestartHostRowInjected>

/**
 * Render the restart-host action.
 * @param props - composed slot props.
 * @returns the row element tree.
 */
export function RestartHostRow({ t, restartHost }: RestartHostRowProps): JSX.Element | null {
  const [busy, setBusy] = useState(false)
  return (
    <div className={styles.row}>
      <div className={styles.rowText}>
        <div className={styles.title}>{t('settings.desktop.restart.title')}</div>
        <div className={styles.desc}>{t('settings.desktop.restart.description')}</div>
      </div>
      <button
        type="button"
        className={styles.selector}
        disabled={busy}
        onClick={() => {
          setBusy(true)
          void restartHost().finally(() => setBusy(false))
        }}
      >
        {t(busy ? 'settings.desktop.restart.busy' : 'settings.desktop.restart.action')}
      </button>
    </div>
  )
}
