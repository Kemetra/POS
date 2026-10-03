/**
 * RT-164 — packaged-build launch-switch guard.
 *
 * The packaged build's Electron fuses (electron-builder.yml `electronFuses`)
 * disable ELECTRON_RUN_AS_NODE, NODE_OPTIONS and the Node `--inspect*`
 * arguments. No fuse covers Chromium's `--remote-debugging-port` /
 * `--remote-debugging-pipe`, which hand the running POS (renderer and
 * `window.api` bridge) to anything that connects. So a PACKAGED build refuses
 * to start when one is present. The `--inspect*` names are refused too, as a
 * second line behind the fuse.
 *
 * Unpackaged (`electron .`) builds are never refused: dev and lab tooling use
 * them for CDP and inspection (owner decision D-2, RT-164).
 *
 * "Packaged" is NOT `app.isPackaged` alone: Electron derives that from the exe
 * file name, so a renamed copy of the shipped exe, or a stock electron.exe
 * pointed at the shipped app.asar, reports false (both opened CDP in the RT-164
 * probe). The shipped app always loads from an `.asar` archive and an
 * unpackaged `electron .` never does, so either signal counts as shipped.
 *
 * The decision is pure here; the composition root logs it and exits.
 */

export const REFUSED_LAUNCH_SWITCHES: readonly string[] = Object.freeze([
  'remote-debugging-port',
  'remote-debugging-pipe',
  'inspect',
  'inspect-brk',
  'inspect-port',
]);

/** Chromium on Windows accepts all three switch prefixes. Longest first. */
const SWITCH_PREFIXES = ['--', '-', '/'] as const;

/** Chromium stops reading switches at a bare `--`. */
const END_OF_SWITCHES = '--';

export interface LaunchSwitchInput {
  /** `app.isPackaged`. */
  readonly isPackaged: boolean;
  /** `app.getAppPath()`: ends in `.asar` whenever the shipped app is running. */
  readonly appPath: string;
  /** Normally `process.argv`. */
  readonly argv: readonly string[];
  /** Normally `(name) => app.commandLine.hasSwitch(name)`: Chromium's own parse. */
  readonly hasSwitch: (name: string) => boolean;
}

export type LaunchSwitchAssessment =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: 'debug_switch_present';
      /** Switch NAMES only — never their values (ports, hosts). */
      readonly switches: readonly string[];
    };

/** `--Remote-Debugging-Port=9222` → `remote-debugging-port`; non-switch → null. */
function switchName(arg: string): string | null {
  const prefix = SWITCH_PREFIXES.find((p) => arg.startsWith(p));
  if (prefix === undefined) return null;
  const body = arg.slice(prefix.length);
  const eq = body.indexOf('=');
  return (eq === -1 ? body : body.slice(0, eq)).toLowerCase();
}

function switchesInArgv(argv: readonly string[]): Set<string> {
  const names = new Set<string>();
  for (const arg of argv.slice(1)) {
    if (arg === END_OF_SWITCHES) break;
    const name = switchName(arg);
    if (name !== null) names.add(name);
  }
  return names;
}

function runsShippedApp(input: LaunchSwitchInput): boolean {
  return input.isPackaged || input.appPath.toLowerCase().endsWith('.asar');
}

export function assessLaunchSwitches(input: LaunchSwitchInput): LaunchSwitchAssessment {
  if (!runsShippedApp(input)) return { ok: true };
  const inArgv = switchesInArgv(input.argv);
  const found = REFUSED_LAUNCH_SWITCHES.filter((name) => inArgv.has(name) || input.hasSwitch(name));
  return found.length === 0
    ? { ok: true }
    : { ok: false, reason: 'debug_switch_present', switches: found };
}
