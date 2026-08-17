/** Desktop-shell settings-row and tray copy; the key-set source of truth. */
export const zh = {
  'settings.desktop.title': '关闭窗口行为',
  'settings.desktop.description': '选择点击窗口关闭按钮后应用的行为。',
  'settings.desktop.options.quit': '退出应用',
  'settings.desktop.options.tray': '最小化到托盘',
  'settings.desktop.tray.show': '打开主窗口',
  'settings.desktop.tray.quit': '退出',
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
  'settings.desktop.tray.quit': 'Quit',
}
