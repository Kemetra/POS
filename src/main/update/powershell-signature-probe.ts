import { execFile } from 'node:child_process';
import path from 'node:path';

import type { ProbeResult, SignatureProbe } from './signature-verifier.js';

/**
 * RT-772 slice 2 — how the fail-closed verifier launches PowerShell.
 *
 * - The downloaded file's name comes from the update feed, so it is untrusted. It reaches
 *   PowerShell only through the `POS_PULSE_VERIFY_FILE` environment variable, never inside the
 *   script text (doubling quotes is not enough: PowerShell also treats the Unicode single quotes
 *   as delimiters in a single-quoted string).
 * - The executable is Windows PowerShell at its absolute path under `SystemRoot`: no PATH lookup
 *   (a planted `powershell.exe` is never run) and no shell.
 * - `PSModulePath` is dropped from the child's environment, whatever its case (a PowerShell 7
 *   module path breaks `Get-AuthenticodeSignature`; electron-builder issue 7127).
 * - The script is cmdlet-only. Under Constrained Language Mode or a locked-down policy it may be
 *   refused; that is reported as "could not verify" and never as a pass.
 */

const VERIFY_FILE_VARIABLE = 'POS_PULSE_VERIFY_FILE';
const SCRIPT = `Get-AuthenticodeSignature -LiteralPath $env:${VERIFY_FILE_VARIABLE} | ConvertTo-Json -Compress`;
const TIMEOUT_MS = 20_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_REASON_LENGTH = 160;

export type ExecFileLike = (
  file: string,
  args: readonly string[],
  options: {
    env: NodeJS.ProcessEnv;
    timeout: number;
    windowsHide: boolean;
    maxBuffer: number;
  },
  callback: (error: Error | null, stdout: string, stderr: string) => void,
) => unknown;

export interface PowerShellProbeOptions {
  execFile?: ExecFileLike;
  systemRoot?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

const failed = (reason: string): ProbeResult => ({ kind: 'failed', reason });

const defaultExecFile: ExecFileLike = (file, args, options, callback) =>
  execFile(file, [...args], { ...options, encoding: 'utf8' }, callback);

function withoutPsModulePath(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(([name]) => name.toLowerCase() !== 'psmodulepath'),
  );
}

function usableFilePath(filePath: string): boolean {
  return path.win32.isAbsolute(filePath) && !filePath.includes('\u0000');
}

export function createPowerShellProbe(options: PowerShellProbeOptions = {}): SignatureProbe {
  const run = options.execFile ?? defaultExecFile;
  const systemRoot = options.systemRoot ?? process.env.SystemRoot ?? String.raw`C:\Windows`;
  const powershell = path.win32.join(
    systemRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  const platform = options.platform ?? process.platform;
  const baseEnv = withoutPsModulePath(options.env ?? process.env);

  return (filePath) =>
    new Promise<ProbeResult>((resolve) => {
      if (platform !== 'win32') {
        resolve(failed('the signature check runs only on Windows'));
        return;
      }
      if (!usableFilePath(filePath)) {
        resolve(failed('the downloaded file has no usable absolute path'));
        return;
      }
      run(
        powershell,
        ['-NoProfile', '-NonInteractive', '-InputFormat', 'None', '-Command', SCRIPT],
        {
          env: { ...baseEnv, [VERIFY_FILE_VARIABLE]: filePath },
          timeout: TIMEOUT_MS,
          windowsHide: true,
          maxBuffer: MAX_OUTPUT_BYTES,
        },
        (error, stdout, stderr) => {
          if (error !== null) {
            resolve(failed(`PowerShell failed: ${error.message.slice(0, MAX_REASON_LENGTH)}`));
          } else if (stderr.trim() !== '') {
            resolve(
              failed(`PowerShell reported an error: ${stderr.trim().slice(0, MAX_REASON_LENGTH)}`),
            );
          } else if (stdout.trim() === '') {
            resolve(failed('PowerShell returned no output'));
          } else {
            resolve({ kind: 'ok', stdout });
          }
        },
      );
    });
}
