/**
 * Ambient CSS-module import shape: the esbuild bundle build emits a hashed
 * class map per `*.module.css`. Script file on purpose — an exported .d.ts
 * would turn these wildcard declarations into module-local augmentations.
 */

declare module '*.module.css' {
  /** Hashed class map the esbuild CSS-module loader emits. */
  const classes: { readonly [className: string]: string }
  export default classes
}
