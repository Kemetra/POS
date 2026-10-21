import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * RT-772 slice 1 — guard for the lab-only NSIS builder config.
 *
 * The lab installer is built from a SEPARATE config (`electron-builder.lab.yml`,
 * passed with `--config`) that extends the shipped one. These tests pin the
 * boundary: the shipped config keeps its `dir` target and hardening, and the lab
 * config can never publish, weaken the updater's signature check, change the
 * update identity, or reference key material.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// Line endings are normalised: a Windows checkout with `core.autocrlf=true` writes CRLF, and the
// multi-line patterns below match `\n`. (CI is Linux, so only a local Windows run would notice.)
const read = (rel: string): string =>
  readFileSync(path.join(REPO_ROOT, rel), 'utf8').replaceAll('\r\n', '\n');
const nodeRequire = createRequire(import.meta.url);

interface LabSignLib {
  LAB_SUBJECT_MARKER: string;
  assertLabSubject(subject: string): void;
  normalizeThumbprint(value: string | undefined): string;
  buildSigntoolArgs(opts: { thumbprint: string; file: string; tsaUrl?: string }): string[];
}
const lib = nodeRequire('../lab/lab-sign-lib.cjs') as LabSignLib;

const SHA1 = 'A'.repeat(40);

describe('RT-772 shipped electron-builder.yml is untouched by the lab slice', () => {
  const base = read('electron-builder.yml');

  it('keeps the dir target and nothing installer- or publish-shaped', () => {
    expect(base).toMatch(/target:\s*dir\b/);
    expect(base).not.toMatch(/nsis/i);
    expect(base).not.toMatch(/^\s*publish:/m);
    expect(base).not.toMatch(/signtoolOptions|certificateSha1|cscLink/);
  });

  it('keeps the frozen update identity and the RT-164 fuses', () => {
    expect(base).toMatch(/^appId:\s*tech\.smartdatapulse\.pos$/m);
    expect(base).toMatch(/^productName:\s*POS Pulse$/m);
    expect(base).toMatch(/runAsNode:\s*false/);
    expect(base).toMatch(/onlyLoadAppFromAsar:\s*true/);
    expect(base).toMatch(/enableEmbeddedAsarIntegrityValidation:\s*true/);
  });
});

describe('RT-772 electron-builder.lab.yml', () => {
  const labPath = 'electron-builder.lab.yml';
  const lab = existsSync(path.join(REPO_ROOT, labPath)) ? read(labPath) : '';

  it('exists and extends the shipped config', () => {
    expect(lab).not.toBe('');
    expect(lab).toMatch(/^extends:\s*\.\/electron-builder\.yml$/m);
  });

  it('builds a per-user, non-elevating NSIS installer that never deletes app data', () => {
    expect(lab).toMatch(/target:\s*nsis\b/);
    expect(lab).toMatch(/oneClick:\s*true/);
    expect(lab).toMatch(/perMachine:\s*false/);
    expect(lab).toMatch(/allowElevation:\s*false/);
    expect(lab).toMatch(/deleteAppDataOnUninstall:\s*false/);
  });

  it('has exactly one publish provider: generic, https, a reserved .test host, channel lab', () => {
    expect(lab.match(/^\s*-?\s*provider:/gm)).toHaveLength(1);
    expect(lab).toMatch(
      /^publish:\n\s+- provider: generic\n\s+url: https:\/\/[a-z0-9-]+\.test(:\d+)?\/\S*\n\s+channel: lab\n/m,
    );
  });

  it('can never upload: no uploading provider, no token, and the build is --publish never', () => {
    expect(lab).not.toMatch(/provider:\s*(github|s3|spaces|bitbucket|keygen|snapcraft|custom)/i);
    expect(lab).not.toMatch(/token|accessKey|secretKey|bucket/i);
    expect(read('scripts/lab/build-lab-installer.ps1')).toMatch(/--publish never/);
  });

  it('does not override the frozen identity or the fuses', () => {
    expect(lab).not.toMatch(/^appId:/m);
    expect(lab).not.toMatch(/^productName:/m);
    expect(lab).not.toMatch(/electronFuses/);
  });

  it('never weakens the updater signature check', () => {
    expect(lab).not.toMatch(/verifyUpdateCodeSignature:\s*false/);
    expect(lab).not.toMatch(/forceCodeSigning:\s*false/);
  });

  it('holds no key material or certificate path', () => {
    expect(lab).not.toMatch(/certificateFile|certificatePassword|cscLink|cscKeyPassword|\.pfx/i);
  });

  it('pins a publisher that carries the lab marker, so it can never match a production pin', () => {
    const match = /^\s*publisherName:\s*(.+)$/m.exec(lab);
    expect(match).not.toBeNull();
    expect(match?.[1]).toContain(lib.LAB_SUBJECT_MARKER);
  });

  it('signs through the lab sign hook, which exists', () => {
    const hook = /^\s*sign:\s*(\S+)$/m.exec(lab);
    expect(hook?.[1]).toBe('./scripts/lab/lab-sign.cjs');
    expect(existsSync(path.join(REPO_ROOT, 'scripts/lab/lab-sign.cjs'))).toBe(true);
  });
});

describe('RT-322 differential download stays on, with a full-download fallback', () => {
  const lab = read('electron-builder.lab.yml');
  const nsisTarget = read('node_modules/app-builder-lib/out/targets/nsis/NsisTarget.js');
  const updater = read('node_modules/electron-updater/out/AppUpdater.js');
  const updateService = read('src/main/update/update-service.ts');
  const feed = read('scripts/lab/serve-lab-feed.ps1');

  it('lab builder config does not switch off the differential package (so a .blockmap is emitted)', () => {
    expect(lab).not.toMatch(/differentialPackage/);
    expect(lab).not.toMatch(/disableDifferentialDownload/);
    expect(read('electron-builder.yml')).not.toMatch(/differentialPackage/);
    // electron-builder writes the blockmap for every non-portable NSIS build unless
    // `differentialPackage: false` is set; the lab target is a plain `nsis` one.
    expect(nsisTarget).toMatch(/options\.differentialPackage !== false/);
    expect(nsisTarget).toMatch(/createBlockmap\)\(installerPath/);
    expect(lab).not.toMatch(/target:\s*portable/);
  });

  it('no updater wiring (src/main/update/**, src/main/index.ts) disables differential download', () => {
    const files = [
      'src/main/index.ts',
      ...readdirSync(path.join(REPO_ROOT, 'src/main/update'), { recursive: true })
        .map(String)
        .filter((f) => f.endsWith('.ts') && !f.includes('__tests__'))
        .map((f) => `src/main/update/${f.replaceAll(path.sep, '/')}`),
    ];
    expect(files).toContain('src/main/update/update-service.ts');
    for (const f of files) {
      expect(read(f), f).not.toMatch(/disableDifferentialDownload|differentialPackage/);
    }
    expect(updateService).not.toMatch(/disableDifferentialDownload/);
  });

  it('NsisUpdater verifies the signature after the download block, on both paths', () => {
    const nsis = read('node_modules/electron-updater/out/NsisUpdater.js');
    expect(nsis).toMatch(
      /await this\.httpExecutor\.download\(fileInfo\.url, destinationFile, downloadOptions\);\s*\}\s*const signatureVerificationStatus = await this\.verifySignature\(destinationFile\)/,
    );
  });

  it('the pinned electron-updater falls back to a full download on any differential error', () => {
    expect(updater).toMatch(/Cannot download differentially, fallback to full download/);
    // outside test mode the catch returns true, which NsisUpdater reads as "download in full"
    expect(updater).toMatch(/_testOnlyOptions != null\) \{[^}]*throw e;[^}]*\}\s*return true;/);
  });

  it('the lab feed corrupts or hides only .blockmap paths and is off by default', () => {
    expect(feed).toMatch(
      /\[ValidateSet\('Normal', 'Corrupt', 'Missing'\)\]\[string\]\$BlockmapMode = 'Normal'/,
    );
    expect(feed).toMatch(/\$isBlockmap -and \$BlockmapMode -eq 'Missing'/);
    expect(feed).toMatch(/\$isBlockmap -and \$BlockmapMode -eq 'Corrupt'/);
    expect(feed).toMatch(/Assert-LabFeedAllowed/);
  });
});

describe('RT-772 lab signing helpers', () => {
  it('accepts only a certificate subject carrying the lab marker', () => {
    expect(() => {
      lib.assertLabSubject(`CN=Kemetra POS ${lib.LAB_SUBJECT_MARKER}`);
    }).not.toThrow();
    expect(() => {
      lib.assertLabSubject('CN=Kemetra Ltd');
    }).toThrow(/lab/i);
    expect(() => {
      lib.assertLabSubject('');
    }).toThrow(/lab/i);
  });

  it('normalises a thumbprint and rejects anything that is not 40 hex chars', () => {
    expect(lib.normalizeThumbprint(`aa bb${'c'.repeat(36)}`)).toBe(`AABB${'C'.repeat(36)}`);
    expect(() => lib.normalizeThumbprint(undefined)).toThrow(/thumbprint/i);
    expect(() => lib.normalizeThumbprint('not-a-thumbprint')).toThrow(/thumbprint/i);
  });

  it('signs with SHA-256 from the CurrentUser store and makes no timestamp call by default', () => {
    const args = lib.buildSigntoolArgs({ thumbprint: SHA1, file: 'C:\\x\\Setup.exe' });
    expect(args).toEqual(['sign', '/fd', 'sha256', '/s', 'My', '/sha1', SHA1, 'C:\\x\\Setup.exe']);
    expect(args).not.toContain('/t');
    expect(args).not.toContain('/tr');
  });

  it('adds an RFC 3161 timestamp only when a TSA url is given explicitly', () => {
    const args = lib.buildSigntoolArgs({
      thumbprint: SHA1,
      file: 'C:\\x\\Setup.exe',
      tsaUrl: 'https://tsa.example/rfc3161',
    });
    expect(args).toContain('/tr');
    expect(args[args.indexOf('/tr') + 1]).toBe('https://tsa.example/rfc3161');
    expect(args[args.indexOf('/td') + 1]).toBe('sha256');
    expect(args[args.length - 1]).toBe('C:\\x\\Setup.exe');
  });

  it('refuses a plain-http timestamp url', () => {
    expect(() =>
      lib.buildSigntoolArgs({ thumbprint: SHA1, file: 'f.exe', tsaUrl: 'http://tsa.example' }),
    ).toThrow(/https/i);
  });
});
