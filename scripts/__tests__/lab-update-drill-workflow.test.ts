import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * RT-803 (RT-322 S-E, P0 spike) — guard for the manual lab update drill workflow.
 *
 * The workflow builds and runs a self-signed LAB installer on an ephemeral GitHub
 * runner. These tests pin the boundary: manual trigger only, read-only token, no
 * secrets, no publish or upload of the installer, and the ephemeral lab trust is
 * removed again. The workflow is not part of the PR gate.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel: string): string =>
  readFileSync(path.join(REPO_ROOT, rel), 'utf8').replaceAll('\r\n', '\n');

const WORKFLOW = '.github/workflows/lab-update-drill.yml';
const SPIKE = 'scripts/lab/ci/run-lab-spike.ps1';

describe('RT-803 lab update drill workflow (P0 spike)', () => {
  it('exists together with its spike script', () => {
    expect(existsSync(path.join(REPO_ROOT, WORKFLOW))).toBe(true);
    expect(existsSync(path.join(REPO_ROOT, SPIKE))).toBe(true);
  });

  const wf = existsSync(path.join(REPO_ROOT, WORKFLOW)) ? read(WORKFLOW) : '';

  it('is triggered manually only', () => {
    expect(wf).toMatch(/^on:\n {2}workflow_dispatch:/m);
    expect(wf).not.toMatch(/^\s+(push|pull_request|pull_request_target|schedule|workflow_run):/m);
  });

  it('has a read-only token, no secrets and no long-lived credential', () => {
    expect(wf).toMatch(/^permissions:\n {2}contents: read\n/m);
    expect(wf).not.toMatch(/secrets\./);
    expect(wf).not.toMatch(/CSC_LINK|CSC_KEY_PASSWORD|WIN_CSC|\.pfx|PRIVATE KEY/i);
  });

  it('runs on Windows with a bounded timeout and never uses the ci gate name', () => {
    expect(wf).toMatch(/runs-on: windows-latest/);
    expect(wf).toMatch(/timeout-minutes: (?:[1-9]|[1-3]\d|45)\b/);
    expect(wf).not.toMatch(/^name: ci$/m);
  });

  it('does not take the dispatched ref through shell interpolation', () => {
    for (const run of wf.split(/\n\s+run: /).slice(1)) {
      const block = run.split('\n      - ')[0] ?? '';
      expect(block).not.toMatch(/\$\{\{\s*(?:inputs|github\.event)\./);
    }
  });

  it('keeps the evidence bundle short-lived and installers out of it', () => {
    expect(wf).toMatch(/retention-days: 14/);
    expect(wf).not.toMatch(/path:[^\n]*\.exe/);
    expect(wf).toMatch(/if: always\(\)/);
  });

  it('spike script never publishes and removes the ephemeral trust', () => {
    const script = read(SPIKE);
    expect(script).not.toMatch(/--publish always|gh release|Invoke-WebRequest|Invoke-RestMethod/);
    expect(script).not.toMatch(/Export-PfxCertificate|PrivateKey|\.pfx/i);
    expect(script).toMatch(/Cert:\\LocalMachine\\Root/);
    expect(script).toMatch(/function Remove-LabTrust/);
    expect(script).toMatch(/Remove-Item -LiteralPath \$path/);
    expect(script).toMatch(/Cert:\\CurrentUser\\My\\\$\(\$state\.leafThumbprint\)/);
  });
});
