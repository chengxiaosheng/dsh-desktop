/** Desktop-shell settings-row and tray copy; the key-set source of truth. */
export const zh = {
  'settings.desktop.title': '关闭窗口行为',
  'settings.desktop.description': '选择点击窗口关闭按钮后应用的行为。',
  'settings.desktop.options.quit': '退出应用',
  'settings.desktop.options.tray': '最小化到托盘',
  'settings.desktop.tray.show': '打开主窗口',
  'settings.desktop.tray.restart': '重启宿主',
  'settings.desktop.tray.quit': '退出',
  'settings.desktop.restart.title': '重启宿主',
  'settings.desktop.restart.description': '重新加载插件组合，让插件市场的「需要重启」变更生效，无需重启应用。',
  'settings.desktop.restart.action': '重启宿主',
  'settings.desktop.restart.busy': '重启中…',
  'settings.desktop.market.title': '插件市场版本',
  'settings.desktop.market.bundled': '内置',
  'settings.desktop.market.override': '覆盖',
  'settings.desktop.market.latest': '最新',
  'settings.desktop.market.check': '检查更新',
  'settings.desktop.market.checking': '检查中…',
  'settings.desktop.market.update': '更新到最新版',
  'settings.desktop.market.rollback': '回退到内置版',
} as const

/** The settings-row and tray key union. */
export type DesktopSettingsKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en: Record<DesktopSettingsKey, string> = {
  'settings.desktop.title': 'Close-window behavior',
  'settings.desktop.description': 'Choose what happens when you close the main window.',
  'settings.desktop.options.quit': 'Quit the app',
  'settings.desktop.options.tray': 'Minimize to tray',
  'settings.desktop.tray.show': 'Open DSH Desktop',
  'settings.desktop.tray.restart': 'Restart host',
  'settings.desktop.tray.quit': 'Quit',
  'settings.desktop.restart.title': 'Restart host',
  'settings.desktop.restart.description': 'Re-compose the plugin tree so the plugin market\u2019s \u201cneeds restart\u201d changes take effect, without restarting the app.',
  'settings.desktop.restart.action': 'Restart host',
  'settings.desktop.restart.busy': 'Restarting\u2026',
  'settings.desktop.market.title': 'Plugin market version',
  'settings.desktop.market.bundled': 'Bundled',
  'settings.desktop.market.override': 'Override',
  'settings.desktop.market.latest': 'Latest',
  'settings.desktop.market.check': 'Check for updates',
  'settings.desktop.market.checking': 'Checking\u2026',
  'settings.desktop.market.update': 'Update to latest',
  'settings.desktop.market.rollback': 'Roll back to bundled',
}
