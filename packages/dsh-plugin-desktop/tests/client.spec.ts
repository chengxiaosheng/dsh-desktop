/**
 * Client-half tests for the desktop shell bundle: the built `lib/client.js`
 * registers with the real `ClientModuleSystem` machinery (bootstrapped from
 * the published `dsh-client-modules` bundle, seeded with the externals the
 * bundles require), and the plugin mounts the General-settings rows, the
 * locale dictionaries, and the tray-label feed over a fake desktop bridge.
 *
 * Runs in plain Node (no jsdom): the row component's CSS injection is guarded
 * by `typeof document`, and nothing touches the DOM at module scope.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { en, zh } from '../src/client/locales.ts'

/** One `__ModuleLoader__.load` handoff the loader bundles register. */
interface LoaderHandoff {
  id: string
  factory: (require: (spec: string) => unknown) => unknown
}

/** The desktop bridge surface the plugin consumes. */
interface FakeBridge {
  getCloseBehavior: () => Promise<{ closeToTray: boolean }>
  setCloseBehavior: (value: boolean) => Promise<void>
  sendLocale: (labels: { show: string; restart: string; quit: string }) => void
  rebootHost: () => Promise<void>
}

test('locale dictionaries are complete in both languages', () => {
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort(), 'en covers exactly the zh key set')
  assert.ok(Object.keys(zh).length > 0, 'dictionaries are not empty')
})

test('built bundle registers and the plugin mounts the settings row', async () => {
  // Seed the module table with the externals the desktop bundle requires:
  // react (the renderer's own instances), the packages the runtime bundle
  // reaches, and a primitives stub — its real entry imports
  // `katex/dist/katex.min.css`, which plain Node cannot load, and the
  // apply-path never renders the row, so no primitives member is touched.
  const staticModules = {
    react: await import('react'),
    'react/jsx-runtime': await import('react/jsx-runtime'),
    '@deepseek-ai/dsh-client-ui-primitives': { Menu: () => null, IconChevronDownOutline14: () => null },
    '@deepseek-ai/cordis': await import('@deepseek-ai/cordis'),
    '@deepseek-ai/dsh-client-ui-slots': await import('@deepseek-ai/dsh-client-ui-slots'),
  }

  // Bootstrap the real loader: evaluate the dsh-client-modules bundle against
  // a temporary __ModuleLoader__, then construct the system (which installs
  // the real registration sink — the temporary one must be gone first).
  const bootstrapped: LoaderHandoff[] = []
  ;(globalThis as { window: unknown }).window = globalThis
  globalThis.__ModuleLoader__ = { load: (handoff) => bootstrapped.push(handoff) }
  await import('@deepseek-ai/dsh-client-modules/client')
  const modulesHandoff = bootstrapped.find((handoff) => handoff.id === '@deepseek-ai/dsh-client-modules')
  assert.ok(modulesHandoff !== undefined, 'dsh-client-modules bundle registered')
  const { ClientModuleSystem } = modulesHandoff.factory(() => {
    throw new Error('dsh-client-modules bundle has no externals')
  }) as { ClientModuleSystem: new (options: unknown) => ClientSystem }
  globalThis.__ModuleLoader__ = undefined

  const system = new ClientModuleSystem({
    modules: [],
    staticModules,
    loadBundle: async () => { throw new Error('unexpected bundle fetch') },
  })

  // Evaluate the runtime bundle and the desktop bundle against the real
  // loader, then materialize the desktop plugin through it.
  const evalBundle = (path: string): void => {
    const code = readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
    // Indirect eval: the bundles reference `window` at top level only.
    // eslint-disable-next-line no-eval
    ;(0, eval)(code)
  }
  evalBundle('../node_modules/@deepseek-ai/dsh-client-runtime/lib/client.js')
  evalBundle('../lib/client.js')

  const plugin = (await system.import('dsh-plugin-desktop')) as {
    apply: (ctx: unknown) => void
    inject: string[]
    SETTINGS_NS: string
  }
  assert.equal(typeof plugin.apply, 'function')
  assert.deepEqual(plugin.inject, ['slots', 'locale'])
  assert.equal(plugin.SETTINGS_NS, 'settings.desktop')

  // A fake desktop bridge: the stored preference, the write log, and the
  // tray-label log the plugin publishes.
  const bridgeWrites: boolean[] = []
  const localeLabels: Array<{ show: string; restart: string; quit: string }> = []
  const bridge: FakeBridge = {
    getCloseBehavior: async () => ({ closeToTray: true }),
    setCloseBehavior: async (value) => { bridgeWrites.push(value) },
    sendLocale: (labels) => { localeLabels.push(labels) },
    rebootHost: async () => {},
  }
  ;(globalThis as { dshDesktop?: FakeBridge }).dshDesktop = bridge

  // A fake client context: the two services the plugin touches.
  const localeRegistrations: Array<[string, unknown]> = []
  const rowRegistrations: unknown[] = []
  const fakeCtx = {
    effect: (fn: () => unknown) => {
      const disposer = fn()
      return () => { if (typeof disposer === 'function') disposer() }
    },
    locale: {
      register: (ns: string, dicts: unknown) => {
        localeRegistrations.push([ns, dicts])
        return () => {}
      },
      bind: () => (key: string) => key,
    },
    on: () => {},
    slots: {
      register: (options: unknown) => {
        rowRegistrations.push(options)
        return () => {}
      },
      inject: (_key: string, register: () => unknown) => {
        register()
      },
    },
  }
  plugin.apply(fakeCtx)
  await Promise.resolve()

  // Dictionaries registered for the settings namespace with both languages.
  assert.equal(localeRegistrations.length, 1, 'one dictionary registration')
  assert.equal(localeRegistrations[0][0], 'settings.desktop')
  const dicts = localeRegistrations[0][1] as { zh: Record<string, string>; en: Record<string, string> }
  assert.deepEqual(Object.keys(dicts.zh).sort(), Object.keys(dicts.en).sort())

  // The tray-label feed publishes once at boot with the current locale copy.
  assert.equal(localeLabels.length, 1, 'tray labels published at boot')
  assert.deepEqual(localeLabels[0], { show: 'settings.desktop.tray.show', restart: 'settings.desktop.tray.restart', quit: 'settings.desktop.tray.quit' })

  // The two General-section rows are registered with the expected identities.
  assert.equal(rowRegistrations.length, 2, 'close-behavior + restart-host rows')
  const row = rowRegistrations[0] as {
    name: string
    id: string
    order: number
    locale: string
    inject: () => {
      hooks: { closeToTray: { getSnapshot(): { status: string; closeToTray: boolean }; subscribe(fn: () => void): () => void } }
      setCloseToTray(value: boolean): void
    }
  }
  const restartRow = rowRegistrations[1] as {
    name: string
    id: string
    order: number
    locale: string
    inject: () => { restartHost(): Promise<void> }
  }
  assert.equal(row.name, 'settings.general.item')
  assert.equal(row.id, 'desktop-close-behavior')
  assert.equal(row.order, 30)
  assert.equal(row.locale, 'settings.desktop')
  assert.equal(restartRow.name, 'settings.general.item')
  assert.equal(restartRow.id, 'desktop-restart-host')
  assert.equal(restartRow.order, 40)
  assert.equal(restartRow.locale, 'settings.desktop')

  // The injected face adopts the stored preference from the bridge read and
  // writes back through the bridge.
  const face = row.inject()
  const state = face.hooks.closeToTray.getSnapshot()
  assert.equal(state.status, 'ready', 'adopts the stored preference')
  assert.equal(state.closeToTray, true, 'adopts the stored preference')
  face.setCloseToTray(false)
  assert.equal(face.hooks.closeToTray.getSnapshot().closeToTray, false, 'live value publishes')
  assert.deepEqual(bridgeWrites, [false], 'durable write goes through the bridge')

  // The restart-host row asks the main process to reboot via the bridge.
  assert.equal(typeof restartRow.inject().restartHost, 'function', 'restartHost exposed to the row')
})

/** The public loader surface the test drives (narrowed from the bundle types). */
interface ClientSystem {
  import(specifier: string): Promise<unknown>
}
