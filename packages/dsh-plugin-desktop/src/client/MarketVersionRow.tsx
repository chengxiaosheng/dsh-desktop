/**
 * The plugin-market version row in the settings General section: shows the
 * bundled (built-in) and any user-installed override versions, checks the
 * registry for a newer release, and triggers the desktop-owned update or
 * rollback. The shell owns this surface rather than the market itself, so the
 * control works even when the market is broken or outdated, and an update
 * never routes through the market's own manage flow (which could compose a
 * duplicate row).
 */

import { useCallback, useEffect, useState, type JSX } from 'react'
import type { PropsLocale, PropsRuntime, InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import styles from './settings-row.module.css'

/** The version states the shell reports; structural mirror of the host info. */
export interface MarketVersionInfo {
  bundled: string | null
  override: string | null
  latest: string | null
  error?: string
}

/** One update/rollback result from the shell. */
export interface MarketVersionResult {
  ok: boolean
  message: string
}

/** Registration-side injected face. */
export interface MarketVersionRowInjected {
  getMarketVersion: () => Promise<MarketVersionInfo>
  updateMarket: (version: string) => Promise<MarketVersionResult>
  rollbackMarket: () => Promise<MarketVersionResult>
}

/** Full Settings-row props: runtime share + locale seat + injected face. */
export type MarketVersionRowProps = PropsRuntime<'settings.general.item'> & PropsLocale<'settings.desktop'> & InjectFace<MarketVersionRowInjected>

/**
 * Render the market-version control.
 * @param props - composed slot props.
 * @returns the row element tree.
 */
export function MarketVersionRow({ t, getMarketVersion, updateMarket, rollbackMarket }: MarketVersionRowProps): JSX.Element | null {
  const [info, setInfo] = useState<MarketVersionInfo | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    setBusy(true)
    setMessage(null)
    try {
      setInfo(await getMarketVersion())
    } finally {
      setBusy(false)
    }
  }, [getMarketVersion])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const active = info?.override ?? info?.bundled ?? null
  const updatable = info?.latest !== null && info?.latest !== undefined && info?.latest !== active && active !== null

  const act = useCallback(async (action: () => Promise<MarketVersionResult>): Promise<void> => {
    setBusy(true)
    setMessage(null)
    try {
      const result = await action()
      setMessage(result.message)
      if (result.ok) await refresh()
    } finally {
      setBusy(false)
    }
  }, [refresh])

  return (
    <div className={styles.row}>
      <div className={styles.rowText}>
        <div className={styles.title}>{t('settings.desktop.market.title')}</div>
        <div className={styles.desc}>
          {t('settings.desktop.market.bundled')}: {info?.bundled ?? '–'}
          {info?.override !== null && info?.override !== undefined ? ` · ${t('settings.desktop.market.override')}: ${info.override}` : ''}
          {info?.latest !== null && info?.latest !== undefined ? ` · ${t('settings.desktop.market.latest')} ${info.latest}` : ''}
        </div>
        {message !== null ? <div className={styles.desc}>{message}</div> : null}
      </div>
      {updatable ? (
        <button
          type="button"
          className={styles.selector}
          disabled={busy}
          onClick={() => void act(() => updateMarket(info.latest as string))}
        >
          {t('settings.desktop.market.update')}
        </button>
      ) : null}
      {info?.override !== null && info?.override !== undefined ? (
        <button
          type="button"
          className={styles.selector}
          disabled={busy}
          onClick={() => void act(() => rollbackMarket())}
        >
          {t('settings.desktop.market.rollback')}
        </button>
      ) : null}
      <button type="button" className={styles.selector} disabled={busy} onClick={() => void refresh()}>
        {t(busy ? 'settings.desktop.market.checking' : 'settings.desktop.market.check')}
      </button>
    </div>
  )
}
