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

const P1 = 'scripts/lab/ci/run-lab-p1.ps1';

/**
 * RT-803 P1 — the automatic update N -> N+1 stage. Same boundary as P0 (manual only, read-only
 * token, no secrets, nothing published, ephemeral trust removed) plus the P1-specific ones: the
 * driver only runs on a GitHub-hosted runner, the feed is an isolated HTTPS `.test` host, the
 * updater is driven by its supported process environment, and no verification is weakened.
 */
describe('RT-803 lab update drill workflow (P1 update N to N+1)', () => {
  const wf = read(WORKFLOW);
  const script = existsSync(path.join(REPO_ROOT, P1)) ? read(P1) : '';

  it('has the driver script', () => {
    expect(script).not.toBe('');
  });

  it('selects the stage by a choice input that defaults to the P0 spike', () => {
    expect(wf).toMatch(
      /stage:\n[^\n]*\n {8}required: false\n {8}default: p0\n {8}type: choice\n {8}options:\n {10}- p0\n {10}- p1\n/,
    );
    expect(wf).toMatch(/p0-spike:\n {4}if: \$\{\{ inputs\.stage == 'p0' \}\}/);
    expect(wf).toMatch(/p1-update:\n {4}if: \$\{\{ inputs\.stage == 'p1' \}\}/);
  });

  it('runs the P1 driver, always cleans up and uploads a short-lived bundle', () => {
    const job = wf.slice(wf.indexOf('p1-update:'));
    expect(job).toContain('./scripts/lab/ci/run-lab-p1.ps1 -Evidence');
    expect(job).toMatch(/if: always\(\)\n {8}shell: pwsh\n {8}run: .*run-lab-p1\.ps1 -Cleanup/);
    expect(job).toMatch(/retention-days: 14/);
    expect(job).toMatch(/runs-on: windows-latest/);
  });

  it('refuses to run anywhere but a GitHub-hosted runner, before any change', () => {
    expect(script).toMatch(
      /GITHUB_ACTIONS -eq 'true' -and \$env:RUNNER_ENVIRONMENT -eq 'github-hosted'/,
    );
    const guard = script.indexOf("RUNNER_ENVIRONMENT -eq 'github-hosted'");
    expect(guard).toBeGreaterThan(-1);
    for (const change of [
      'New-SelfSignedCertificate',
      'Import-Certificate',
      'Add-Content -LiteralPath $hostsFile',
      'Set-LabState @{ sslBound',
    ]) {
      expect(script.indexOf(change)).toBeGreaterThan(guard);
    }
    expect(script).toMatch(/exit 2/);
  });

  it('serves the update from an isolated HTTPS .test feed and drives the updater by its env', () => {
    expect(script).toMatch(/\$feedHost = 'rt772-lab\.test'/);
    expect(script).toMatch(/\$feedOrigin = "https:\/\/\$\{feedHost\}:\$feedPort\/"/);
    expect(script).toMatch(/\$env:ELECTRON_UPDATE_FEED_URL = \$feedOrigin/);
    expect(script).toMatch(/\$env:POS_PULSE_UPDATE_CHANNEL = 'lab'/);
    // The sandbox location guard of the unchanged feed script is overridden only here.
    expect(script).toMatch(/serve-lab-feed\.ps1/);
    expect(script).toMatch(/'-AllowOutsideSandbox'/);
    // Launch-only environment: removed again, and never provisioned machine- or user-wide.
    expect(script).toMatch(
      /Remove-Item Env:ELECTRON_UPDATE_FEED_URL, Env:POS_PULSE_UPDATE_CHANNEL/,
    );
    expect(script).not.toMatch(/SetEnvironmentVariable|setx\b|Session Manager/i);
  });

  it('weakens no verification and never publishes', () => {
    expect(script).not.toMatch(
      /NODE_TLS_REJECT_UNAUTHORIZED|ignore-certificate-errors|forceDevUpdateConfig|dev-app-update|TrustedPublisher|AllowDirtyAppInputs|verifyUpdateCodeSignature|publisherName/i,
    );
    expect(script).not.toMatch(/--publish always|gh release|Invoke-WebRequest|Invoke-RestMethod/);
    expect(script).not.toMatch(
      /CSC_LINK|CSC_KEY_PASSWORD|WIN_CSC|Export-PfxCertificate|PrivateKey|\.pfx/i,
    );
    expect(script).not.toMatch(/secrets\./);
  });

  it('proves the update from the app log of this session, in order, and from the feed log', () => {
    expect(script).toMatch(
      /\$requiredStates = @\('checking', 'downloading', 'downloaded', 'installing'\)/,
    );
    expect(script).toMatch(/\$_\.msg -eq 'app:ready' -and \$_\.at -gt \$installing\.at/);
    expect(script).toMatch(/\$_\.appVersion -eq \$VersionTo/);
    expect(script).toMatch(/'verify_failed', 'verify_unavailable'/);
    expect(script).toMatch(/GET \/\$\(\[regex\]::Escape\(\$installerName\)\) 200 \$size\$/);
  });

  it('keeps installers and key material out of the evidence bundle', () => {
    expect(script).not.toMatch(/Copy-Item[^\n]*installer[^\n]*\$Evidence/i);
    expect(script).toMatch(/Copy-Item -LiteralPath \$cer -Destination \$Evidence/);
    expect(script).toMatch(/function Test-EvidenceBundle/);
    expect(script).toContain('BEGIN (RSA |EC )?PRIVATE KEY');
  });

  it('removes the feed process, TLS binding, hosts line, certificates and trust on cleanup', () => {
    expect(script).toMatch(/function Remove-LabP1State/);
    expect(script).toMatch(/Stop-Process -Force/);
    expect(script).toMatch(/netsh http delete sslcert ipport=0\.0\.0\.0:\$feedPort/);
    expect(script).toMatch(/\$_ -notmatch \[regex\]::Escape\(\$hostsTag\)/);
    for (const store of ['LocalMachine\\Root', 'LocalMachine\\My', 'CurrentUser\\My']) {
      expect(script).toContain(`'${store}'`);
    }
    expect(script).toMatch(/if \(\$Cleanup\) \{ Remove-LabP1State; exit 0 \}/);
  });
});
