/**
 * Keyed-slot compatibility shim for rc.6-era third-party client plugins.
 *
 * DSH 0.1.0-rc.7 tightened the client slot contract: keyed slots
 * (`settings.plugin.item`, `tool.call.toolview`, …) now require
 * `options.key`, and `@deepseek-ai/dsh-client-ui-slots` throws
 * `keyed slot "<name>" requires options.key` when a plugin registers without
 * one — failing that plugin's client entry. Third-party plugins written
 * against rc.6 register into these slots with only `id` (dsh-free-search
 * 0.4.5 is the shipped example). The desktop is the composition owner, so it
 * absorbs the change: the connection carrier (the first client entry) wraps
 * the slots service's `register` the moment the service is provided —
 * synchronously, before any slot declaration or plugin registration runs.
 *
 * A keyless keyed-slot registration receives a synthesized key, so the entry
 * applies instead of failing the plugin. The key must ALSO be a namespace the
 * host serves (`settings.describe`) for the rc.7 configurable-plugins tab to
 * dispatch the card (`settings.plugin.item` is dispatched per served
 * namespace, keyed by it). The synthesis tries the settings-namespace
 * convention first (`dsh-free-search` → `free-search`), and an asynchronous
 * repair pass re-registers the entry under the exact served namespace when the
 * first guess misses — covering plugins whose namespace keeps the package
 * prefix (dsh-remote serves `dsh-remote`, not `remote`).
 *
 * The patch is precise, not blanket: only slots whose declared kind is `keyed`
 * are touched (single/list registrations pass through with no injected key; an
 * unresolvable kind is patched conservatively, the load-preserving direction).
 * The wrap is idempotent (one wrap per service instance), the repair is
 * idempotent (a served key is never re-repaired), and both are self-disarming:
 * once upstream plugins pass a real, served `key`, they are forwarded untouched.
 */

import type { Context } from '@deepseek-ai/cordis'

/** One slot-registration options object, as the compat wrapper sees it. */
export interface SlotRegistrationOptions {
  name: string
  key?: string
  id?: string
  [option: string]: unknown
}

/** The slots-service surface the wrapper reads (spec) and patches (register). */
export interface SlotsService {
  register(options: SlotRegistrationOptions, component: unknown): () => void
  spec?(name: string): { kind?: string } | undefined
}

/** Service instances whose `register` is already compat-wrapped. */
const wrapped = new WeakSet<object>()

/** One keyless keyed registration, tracked for the async namespace repair. */
interface KeylessRegistration {
  name: string
  id?: string
  key: string
  component: unknown
  /** The plugin-facing disposer; the repair chains a repaired entry's disposer onto it. */
  dispose: () => void
}

/** Keyless keyed registrations awaiting (or past) a namespace repair. */
const keyless = new Set<KeylessRegistration>()

/**
 * Normalize a package-style registration name to the settings-namespace
 * convention: strip a leading `dsh-` (or scoped `@scope/dsh-`). A name with no
 * such prefix is returned unchanged.
 * @param name - the registration's id or slot name.
 * @returns the normalized key.
 */
export function normalizeCompatKey(name: string): string {
  return name.replace(/^(?:@[^/]+\/)?dsh-/, '')
}

/**
 * Candidate keys for a keyless registration, most-likely first: the
 * settings-namespace form, then the raw name.
 * @param registration - the tracked registration.
 * @returns the candidate keys in order.
 */
function keyCandidates(registration: Pick<KeylessRegistration, 'id' | 'name'>): string[] {
  const primary = registration.id ?? registration.name
  const normalized = normalizeCompatKey(primary)
  return normalized === primary ? [primary] : [normalized, primary]
}

/**
 * Whether a slot is declared keyed. An unknown (unresolved) kind counts as
 * keyed so a keyless registration is patched in the load-preserving direction
 * rather than left to throw.
 * @param service - the slots service.
 * @param name - the target slot name.
 * @returns true for a keyed slot or an unresolvable kind.
 */
function isKeyed(service: SlotsService, name: string): boolean {
  const kind = service.spec?.(name)?.kind
  return kind === undefined || kind === 'keyed'
}

/**
 * Wrap a slots service's `register` so a keyed-slot registration without a
 * `key` synthesizes one (the settings-namespace convention first) instead of
 * throwing. Idempotent: a second call on the same service instance is a no-op.
 *
 * The returned disposer is chained: when the async repair re-registers the
 * entry under a served namespace, that entry's disposer joins the same chain,
 * so the plugin's unload cleans both.
 * @param service - the `slots` service instance.
 * @returns the same service, with `register` wrapped on first call.
 */
export function installKeyedSlotCompat(service: SlotsService): SlotsService {
  if (wrapped.has(service)) return service
  wrapped.add(service)
  const register = service.register.bind(service)
  service.register = (options, component) => {
    const compat = options.key === undefined && isKeyed(service, options.name)
    if (compat) options.key = normalizeCompatKey(options.id ?? options.name)
    const disposer = register(options, component)
    if (!compat) return disposer
    // compat ⇒ options.key was just assigned, so it is a string here.
    const key = options.key as string
    const registration: KeylessRegistration = {
      name: options.name,
      id: options.id,
      key,
      component,
      dispose: disposer,
    }
    keyless.add(registration)
    return () => {
      keyless.delete(registration)
      registration.dispose()
    }
  }
  return service
}

/**
 * Re-register tracked keyless entries whose synthesized key is not among the
 * served namespaces, under the first served candidate (convention form, then
 * raw name). Each repaired entry keeps its original (invisible) entry and
 * gains a served-key duplicate; the plugin-facing disposer chains the
 * duplicate's cleanup. Idempotent: a served key is never re-repaired.
 * @param service - the wrapped slots service.
 * @param served - the host-served settings namespaces.
 * @returns how many entries were repaired.
 */
export function repairKeylessKeys(service: SlotsService, served: ReadonlySet<string>): number {
  let repaired = 0
  for (const registration of keyless) {
    if (served.has(registration.key)) continue
    const candidate = keyCandidates(registration).find((ns) => served.has(ns))
    if (candidate === undefined) continue
    const repairedDisposer = service.register(
      { name: registration.name, id: registration.id, key: candidate },
      registration.component,
    )
    const previous = registration.dispose
    registration.dispose = () => {
      previous()
      repairedDisposer()
    }
    registration.key = candidate
    repaired += 1
  }
  return repaired
}

/** The settings `describe` response shape the tab reads served namespaces from. */
interface DescribeResponse {
  result?: { ok?: boolean; value?: { namespaces?: Array<{ ns?: unknown }> } }
}

/**
 * Read the host-served settings namespaces through the desktop connection's
 * wire face — the same call the configurable-plugins tab makes.
 * @param ctx - the client root context.
 * @returns the served namespaces, or an empty set when the face is unavailable.
 */
export async function fetchServedNamespaces(ctx: Context): Promise<ReadonlySet<string>> {
  const connection = ctx.get('connection') as { api?: { settings?: { describe?(arg: object): Promise<DescribeResponse> } } } | undefined
  const response = await connection?.api?.settings?.describe?.({})
  if (response?.result?.ok !== true) return new Set()
  return new Set((response.result.value?.namespaces ?? []).flatMap((view) => {
    return typeof view.ns === 'string' ? [view.ns] : []
  }))
}

/**
 * One repair pass: fetch the served namespaces and re-register any keyless
 * entry whose key misses. Bounded retries cover a connection that is not yet
 * answering.
 * @param ctx - the client root context.
 * @param service - the wrapped slots service.
 * @param attempts - how many retries remain (default 5).
 */
export async function repairServedKeys(ctx: Context, service: SlotsService, attempts = 5): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let served: ReadonlySet<string>
    try {
      served = await fetchServedNamespaces(ctx)
    } catch {
      served = new Set()
    }
    if (served.size === 0) {
      await new Promise((resolve) => setTimeout(resolve, 250))
      continue
    }
    repairKeylessKeys(service, served)
    return
  }
}

/**
 * Install the desktop renderer's keyed-slot compatibility shim on the client
 * root context: subscribe to the `internal/service` event and wrap `slots`
 * the moment the service is provided, then schedule the served-namespace
 * repair. The event fires synchronously inside the provide's notification
 * pass, ahead of every deferred entry apply, so the wrap is in place before
 * any slot declaration or plugin registration.
 *
 * Must be called from the earliest client entry (the desktop connection
 * carrier, `immediately: true`) so the subscription exists before the slots
 * service mounts. If slots is somehow already present, it is wrapped
 * immediately (idempotency makes the double path harmless).
 * @param ctx - the client root context.
 */
export function installSlotsCompat(ctx: Context): void {
  const wrap = (value: unknown): void => {
    if (value === undefined) return
    installKeyedSlotCompat(value as SlotsService)
  }
  wrap(ctx.get('slots'))
  ctx.on('internal/service', (name: unknown, value: unknown) => {
    if (name === 'slots') wrap(value)
  })
  // The repair runs after apply returns (so `ctx.connection` exists) and is a
  // best effort: if the host is not yet answering, it gives up quietly — the
  // synthesized convention key already covers the common case.
  const slots = ctx.get('slots') as SlotsService | undefined
  if (slots !== undefined) {
    void repairServedKeys(ctx, slots)
  } else {
    ctx.on('internal/service', (name: unknown, value: unknown) => {
      if (name === 'slots') void repairServedKeys(ctx, value as SlotsService)
    })
  }
}
