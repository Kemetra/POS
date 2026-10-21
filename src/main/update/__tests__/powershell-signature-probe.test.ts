import { describe, expect, it, vi } from 'vitest';

import { createPowerShellProbe } from '../powershell-signature-probe.js';
import type { ExecFileLike } from '../powershell-signature-probe.js';

/**
 * RT-772 slice 2 — how the lab/production verifier launches PowerShell.
 *
 * The downloaded file's name comes from the update feed, so it is untrusted: it reaches
 * PowerShell only through an environment variable, never inside the script text (quote
 * doubling is not enough: PowerShell also treats the Unicode single quotes as delimiters).
 * The executable is an absolute path, so a planted `powershell.exe` earlier on PATH is never
 * run, and there is no shell.
 */

const SYSTEM_ROOT = 'C:\\Windows';
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const FILE = 'C:\\Users\\pos\\AppData\\Local\\pos-pulse-updater\\pending\\Setup.exe';

type Callback = (error: Error | null, stdout: string, stderr: string) => void;

function fakeExec(answer: { error?: Error | null; stdout?: string; stderr?: string } = {}) {
  const calls: Array<{ file: string; args: readonly string[]; options: Record<string, unknown> }> =
    [];
  const exec = vi.fn((file: string, args: readonly string[], options: object, cb: Callback) => {
    calls.push({ file, args, options: options as Record<string, unknown> });
    cb(answer.error ?? null, answer.stdout ?? '{"Status":0}', answer.stderr ?? '');
  }) as unknown as ExecFileLike;
  return { exec, calls };
}

const probeWith = (exec: ExecFileLike, extra: object = {}) =>
  createPowerShellProbe({
    execFile: exec,
    systemRoot: SYSTEM_ROOT,
    platform: 'win32',
    env: { Path: 'C:\\evil', PSModulePath: 'C:\\Program Files\\PowerShell\\7\\Modules', keep: '1' },
    ...extra,
  });

describe('launching PowerShell', () => {
  it('runs the absolute Windows PowerShell path, with no shell', async () => {
    const { exec, calls } = fakeExec();
    await probeWith(exec)(FILE);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.file).toBe(POWERSHELL);
    expect(calls[0]?.options.shell).not.toBe(true);
    expect(calls[0]?.options.windowsHide).toBe(true);
    expect(calls[0]?.options.timeout).toBe(20_000);
  });

  it('uses fixed arguments and a script that names only an environment variable', async () => {
    const { exec, calls } = fakeExec();
    await probeWith(exec)(FILE);
    const args = calls[0]?.args ?? [];
    expect(args.slice(0, 5)).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-InputFormat',
      'None',
      '-Command',
    ]);
    expect(args).toHaveLength(6);
    expect(args[5]).toContain('Get-AuthenticodeSignature -LiteralPath $env:POS_PULSE_VERIFY_FILE');
    expect(args[5]).toContain('ConvertTo-Json -Compress');
  });

  it('passes the file only through the environment, however hostile its name', async () => {
    const hostile = "C:\\x\\a';calc;'b\u2019;calc;\u2018.exe\r\n";
    const { exec, calls } = fakeExec();
    await probeWith(exec)(hostile.replace(/\r?\n$/, ''));
    const sent = hostile.replace(/\r?\n$/, '');
    expect(calls[0]?.args.join(' ')).not.toContain('calc');
    expect((calls[0]?.options.env as Record<string, string>).POS_PULSE_VERIFY_FILE).toBe(sent);
  });

  it('removes PSModulePath whatever its case, and keeps the rest of the environment', async () => {
    const { exec, calls } = fakeExec();
    await probeWith(exec, { env: { psmodulepath: 'x', PSMODULEPATH: 'y', keep: '1' } })(FILE);
    const env = calls[0]?.options.env as Record<string, string>;
    expect(Object.keys(env).filter((k) => k.toLowerCase() === 'psmodulepath')).toEqual([]);
    expect(env.keep).toBe('1');
  });

  it('never resolves the executable through PATH', async () => {
    const { exec, calls } = fakeExec();
    await probeWith(exec)(FILE);
    expect(calls[0]?.file).not.toBe('powershell.exe');
    expect(calls[0]?.file.toLowerCase().startsWith('c:\\windows\\system32\\')).toBe(true);
  });
});

describe('reading the answer', () => {
  it('returns the output when the process succeeded with empty stderr', async () => {
    const { exec } = fakeExec({ stdout: '{"Status":0}' });
    await expect(probeWith(exec)(FILE)).resolves.toEqual({ kind: 'ok', stdout: '{"Status":0}' });
  });

  it('fails when the process errors (spawn failure, timeout, non-zero exit)', async () => {
    const { exec } = fakeExec({ error: new Error('spawn EPERM') });
    const result = await probeWith(exec)(FILE);
    expect(result.kind).toBe('failed');
    expect(JSON.stringify(result)).toContain('spawn EPERM');
  });

  it('fails when anything is written to stderr', async () => {
    const { exec } = fakeExec({ stderr: 'Get-AuthenticodeSignature : not supported' });
    expect((await probeWith(exec)(FILE)).kind).toBe('failed');
  });

  it('fails on empty output', async () => {
    const { exec } = fakeExec({ stdout: '  \n' });
    expect((await probeWith(exec)(FILE)).kind).toBe('failed');
  });
});

describe('refusing to run at all', () => {
  it.each(['', 'relative\\Setup.exe', './Setup.exe', 'C:\\x\\a\u0000b.exe'])(
    'does not spawn for the path %j',
    async (file) => {
      const { exec, calls } = fakeExec();
      const result = await probeWith(exec)(file);
      expect(result.kind).toBe('failed');
      expect(calls).toHaveLength(0);
    },
  );

  it('does not spawn off Windows', async () => {
    const { exec, calls } = fakeExec();
    const result = await probeWith(exec, { platform: 'linux' })(FILE);
    expect(result.kind).toBe('failed');
    expect(calls).toHaveLength(0);
  });
});

describe('defaults', () => {
  it('falls back to C:\\Windows when SystemRoot is not set, never to a PATH lookup', async () => {
    vi.stubEnv('SystemRoot', undefined);
    try {
      const { exec, calls } = fakeExec();
      await createPowerShellProbe({ execFile: exec, platform: 'win32', env: {} })(FILE);
      expect(calls[0]?.file).toBe(POWERSHELL);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('uses the real process, platform and execFile when no options are given', async () => {
    // Not Windows here would fail closed; on Windows an unusable path fails before any spawn.
    const result = await createPowerShellProbe()('not-an-absolute-path');
    expect(result.kind).toBe('failed');
  });

  it('defaults the environment to the process environment, minus PSModulePath', async () => {
    vi.stubEnv('POS_PULSE_PROBE_TEST_MARKER', 'present');
    vi.stubEnv('PSModulePath', 'C:\\somewhere');
    try {
      const { exec, calls } = fakeExec();
      await createPowerShellProbe({ execFile: exec, systemRoot: SYSTEM_ROOT, platform: 'win32' })(
        FILE,
      );
      const env = calls[0]?.options.env as Record<string, string>;
      expect(env.POS_PULSE_PROBE_TEST_MARKER).toBe('present');
      expect(Object.keys(env).some((k) => k.toLowerCase() === 'psmodulepath')).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
