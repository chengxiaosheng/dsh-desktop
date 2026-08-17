/**
 * Reactive preference source for the close-window behavior settings row.
 *
 * The value is durable in the host `desktop` settings namespace, but the
 * settings WIRE does not serve that namespace (the host ApiProxy's explicit
 * configuration-client allowlist covers the shipped web preferences only), so
 * the row reads and writes through the desktop bridge instead: the Electron
 * main answers `getCloseBehavior`/`setCloseBehavior` against the in-process
 * settings provider, which is not gated by the wire allowlist.
 */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'

/** One close-behavior state published to the row. */
export interface CloseBehaviorState {
  /** `loading` until the bridge read settles; `unavailable` when it fails. */
  status: 'loading' | 'ready' | 'unavailable'
  /** Whether closing the window hides it to the tray. */
  closeToTray: boolean
}

/** The desktop bridge surface the policy consumes (the preload exposes it). */
export interface CloseBehaviorBridge {
  /** Read the current durable close-window behavior from the main process. */
  getCloseBehavior(): Promise<{ closeToTray: boolean }>
  /** Persist a new close-window behavior through the main process. */
  setCloseBehavior(value: boolean): Promise<void>
}

/** The default standing until the bridge read settles (matches the schema default). */
const LOADING_STATE: CloseBehaviorState = { status: 'loading', closeToTray: false }

/**
 * The close-window preference policy. `state` publishes the live value before
 * the durable write starts; the initial read is fired at construction and
 * adopts the stored value once it settles.
 */
export class CloseBehaviorPolicy {
  /** The close-window preference state, bound as `useCloseToTray`. */
  readonly state: SnapshotStore<CloseBehaviorState> = createSnapshotStore(LOADING_STATE)
  private readonly bridge: CloseBehaviorBridge

  /**
   * @param bridge - the desktop bridge surface.
   */
  constructor(bridge: CloseBehaviorBridge) {
    this.bridge = bridge
    void bridge.getCloseBehavior().then(
      (value) => this.state.set({ status: 'ready', closeToTray: value.closeToTray === true }),
      () => this.state.set({ status: 'unavailable', closeToTray: false }),
    )
  }

  /**
   * Change the close-window behavior; the live value publishes before the
   * durable write starts.
   * @param value - whether closing the window hides it to the tray.
   */
  setCloseToTray(value: boolean): void {
    const current = this.state.getSnapshot()
    if (current.status === 'loading' || current.closeToTray === value) return
    this.state.set({ status: 'ready', closeToTray: value })
    void this.bridge.setCloseBehavior(value)
  }
}
