/**
 * RT-165 — the trusted "shipped app" identity.
 *
 * Every security-sensitive dev/production decision in main (the
 * `POS_PULSE_DEV_*` bypasses, the SecretStore production refusal, the
 * migrations source, the RT-164 launch-switch guard) keys on THIS predicate,
 * never on `app.isPackaged` alone.
 *
 * Electron derives `app.isPackaged` from the exe FILE NAME, so a renamed copy
 * of the shipped exe reports `false`. In the RT-164 probe that let a renamed
 * exe pair with fixture data and auto-sign-in a fixture manager. The shipped
 * exe loads only `resources/app.asar` (fuse `onlyLoadAppFromAsar`), whatever
 * the exe is called, while an unpackaged `electron .` never loads from an
 * archive. So either signal counts as shipped.
 *
 * Out of scope by design: a stock electron.exe pointed at an EXTRACTED copy of
 * the app. Whoever can do that can already edit the code it runs.
 */

export interface ShippedAppInput {
  /** `app.isPackaged`. */
  readonly isPackaged: boolean;
  /** `app.getAppPath()`: ends in `.asar` whenever the shipped app is running. */
  readonly appPath: string;
}

export function isShippedApp(input: ShippedAppInput): boolean {
  return input.isPackaged || input.appPath.toLowerCase().endsWith('.asar');
}
