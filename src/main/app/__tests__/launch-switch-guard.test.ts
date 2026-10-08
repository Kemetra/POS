import { describe, it, expect } from 'vitest';

import { REFUSED_LAUNCH_SWITCHES, assessLaunchSwitches } from '../launch-switch-guard.js';

/**
 * RT-164 — packaged-build launch-switch guard.
 *
 * Electron fuses close ELECTRON_RUN_AS_NODE, NODE_OPTIONS and the Node
 * `--inspect*` arguments, but no fuse covers Chromium's `--remote-debugging-*`
 * switches. On Windows, Chromium accepts a switch with the `--`, `-` or `/`
 * prefix, in any letter case, and the packaged exe opened a CDP port for each
 * spelling (RT-164 baseline evidence). A packaged build refuses to start when
 * any of these switches is present. Unpackaged dev/lab builds are unaffected
 * (owner decision D-2).
 */

const EXE = 'C:\\Program Files\\POS Pulse\\POS Pulse.exe';
const ASAR = 'C:\\Program Files\\POS Pulse\\resources\\app.asar';
const REPO = 'C:\\Users\\dev\\POS';
const noSwitch = (): boolean => false;

function assessPackaged(argv: readonly string[], hasSwitch: (name: string) => boolean = noSwitch) {
  return assessLaunchSwitches({ isPackaged: true, appPath: ASAR, argv: [EXE, ...argv], hasSwitch });
}

describe('assessLaunchSwitches — allowed launches', () => {
  it('allows a packaged launch with no switches', () => {
    expect(assessPackaged([])).toEqual({ ok: true });
  });

  it('allows a packaged launch with unrelated switches and arguments', () => {
    expect(assessPackaged(['--lang=ar', 'C:\\some\\file.txt', '--disable-gpu'])).toEqual({
      ok: true,
    });
  });

  it('never refuses an unpackaged (dev/lab) build, whatever the switches', () => {
    expect(
      assessLaunchSwitches({
        isPackaged: false,
        appPath: REPO,
        argv: [
          'C:\\repo\\node_modules\\electron\\dist\\electron.exe',
          '--remote-debugging-port=9333',
        ],
        hasSwitch: () => true,
      }),
    ).toEqual({ ok: true });
  });

  it.each(['--remote-debugging-portal=1', '--inspector', '--inspect-foo', '--xinspect'])(
    'does not refuse a look-alike switch (%j)',
    (arg) => {
      expect(assessPackaged([arg])).toEqual({ ok: true });
    },
  );

  it('ignores arguments after a bare "--" (Chromium stops parsing switches there)', () => {
    expect(assessPackaged(['--', '--remote-debugging-port=9222'])).toEqual({ ok: true });
  });
});

describe('assessLaunchSwitches — refused launches', () => {
  it('refuses each listed switch in its canonical --name=value form', () => {
    for (const name of REFUSED_LAUNCH_SWITCHES) {
      expect(assessPackaged([`--${name}=9222`])).toEqual({
        ok: false,
        reason: 'debug_switch_present',
        switches: [name],
      });
    }
  });

  it('covers the remote-debugging and inspect switches', () => {
    expect([...REFUSED_LAUNCH_SWITCHES].sort()).toEqual(
      [
        'inspect',
        'inspect-brk',
        'inspect-port',
        'remote-debugging-pipe',
        'remote-debugging-port',
      ].sort(),
    );
  });

  it.each([
    '/remote-debugging-port=9335',
    '-remote-debugging-port=9335',
    '--REMOTE-DEBUGGING-PORT=9336',
    '/Remote-Debugging-Port=1',
    '--remote-debugging-port',
  ])('refuses the Windows spelling %j', (arg) => {
    expect(assessPackaged([arg])).toEqual({
      ok: false,
      reason: 'debug_switch_present',
      switches: ['remote-debugging-port'],
    });
  });

  // Electron derives `app.isPackaged` from the exe FILE NAME: a copy of the
  // shipped exe renamed to electron.exe, or a stock electron.exe pointed at the
  // shipped app.asar, both report false (RT-164 probe: CDP opened on both).
  // Loading the app from an .asar archive is the signal a rename cannot change.
  it.each([ASAR, 'C:\\copy\\resources\\APP.ASAR'])(
    'refuses when the app runs from an asar (%j) even though isPackaged is false',
    (appPath) => {
      expect(
        assessLaunchSwitches({
          isPackaged: false,
          appPath,
          argv: ['C:\\copy\\electron.exe', '--remote-debugging-port=9350'],
          hasSwitch: noSwitch,
        }),
      ).toEqual({
        ok: false,
        reason: 'debug_switch_present',
        switches: ['remote-debugging-port'],
      });
    },
  );

  it('refuses a switch reported by the Chromium command line even if argv lacks it', () => {
    expect(assessPackaged([], (name) => name === 'remote-debugging-pipe')).toEqual({
      ok: false,
      reason: 'debug_switch_present',
      switches: ['remote-debugging-pipe'],
    });
  });

  it('reports switch names only, deduplicated — never their values', () => {
    const result = assessPackaged(
      ['--remote-debugging-port=9222', '/remote-debugging-port=9223', '--inspect=0.0.0.0:9229'],
      (name) => name === 'remote-debugging-port',
    );
    expect(result).toEqual({
      ok: false,
      reason: 'debug_switch_present',
      switches: ['remote-debugging-port', 'inspect'],
    });
    expect(JSON.stringify(result)).not.toMatch(/9222|9223|9229|0\.0\.0\.0/);
  });
});
