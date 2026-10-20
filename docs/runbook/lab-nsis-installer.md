# Lab NSIS installer (RT-772 slice 1)

> **LAB ONLY.** This builds a per-user NSIS installer signed with a **self-signed test
> certificate** for one disposable Windows device. It is not a release path: nothing here
> publishes, uploads, tags or promotes, and the artifact must never reach a customer or a
> production terminal. The production signing path is RT-321 (cloud-HSM, timestamped,
> publisher-pinned) and is unchanged.

## What this proves, and what it does not

| Proves                                                                               | Does not prove                                                      |
| :----------------------------------------------------------------------------------- | :------------------------------------------------------------------ |
| A reproducible per-user NSIS build of the shipped app, with a recorded SHA-256       | That any updater exists (there is none; `electron-updater` is RT-322) |
| The lab signature is `Valid` only where the lab root is trusted                      | Production signing, HSM custody, RFC 3161 timestamping              |
| The installed app keeps `userData` (SQLite, outbox, DPAPI secrets) across 0.1.0 → 0.1.1 | Staged rollout, safe-point install gating, compat gate              |
| A newer schema triggers the pre-migration snapshot; an older build then refuses to start (RT-320) on a **packaged** build | RT-321 / RT-322 / RT-324 acceptance (they stay open and independent) |

## Trust boundary

- The lab certificate subject contains `LAB TEST - NOT FOR PRODUCTION`. A production
  `publisherName` pin can never match it, and the lab pin can never match production.
- The root and leaf keys are **non-exportable** and live in `Cert:\CurrentUser\My` on the
  build machine only. No `.pfx`, no key on disk, nothing in the repo, Jira or Confluence.
- Only the **public** root (`D:\rt772-lab\certs\rt772-lab-root.cer`) leaves the build
  machine. It is imported **only on the disposable lab device**, by its owner. It is never
  trusted on the build machine: there the signature is expected to report `NotTrusted`.
- `electron-builder.lab.yml` has no `publish` block, no certificate path, and does not touch
  the shipped `electron-builder.yml`, the frozen identity (`tech.smartdatapulse.pos` /
  `POS Pulse`) or the RT-164 fuses. `scripts/__tests__/lab-nsis-config.test.ts` pins this.
- No timestamp call is made. A signature without a timestamp stops verifying when the leaf
  expires (90 days), so lab artifacts are short-lived by design. A timestamp is added only
  if the owner sets `RT772_LAB_TSA_URL` (https), which is an explicit owner decision.

## Build

On the build machine (Windows SDK `signtool.exe` and the Node toolchain required):

```powershell
# once: create the lab root + leaf in CurrentUser\My, export the PUBLIC root
.\scripts\lab\new-lab-signing-cert.ps1

# per version: build + sign + record
.\scripts\lab\build-lab-installer.ps1 -Version 0.1.0 -CertSha1 <leaf thumbprint>
.\scripts\lab\build-lab-installer.ps1 -Version 0.1.1 -CertSha1 <leaf thumbprint>
```

Output goes to `D:\rt772-lab\out\<version>\` (outside the repo): the installer and
`lab-manifest.json` (version, SHA-256, git SHA, signer). The script refuses to build if
anything that ends up in the app (`src/`, `migrations/`, `package*.json`,
`electron-builder.yml`, build config) differs from `HEAD`. The first NSIS build downloads
the NSIS toolchain from GitHub into the electron-builder cache.

**Schema fixture for the packaged RT-320 drill.** To give 0.1.1 a schema step 0.1.0 does not
know, create the throwaway, **never committed** file `migrations/9999_rt772_lab_fixture.sql`
(for example `CREATE TABLE rt772_lab_fixture (id INTEGER PRIMARY KEY);`), build with
`-LabFixtureMigration`, then delete the file. The output folder is `0.1.1-fixture`.

## Disposable lab device (owner)

Use Windows Sandbox or a throwaway VM. `--user-data-dir` is **not** isolation: after an
install or update restart the app relaunches under the same Windows user's default
`%APPDATA%\pos-pulse`, which on a working machine can be a real lab profile. Enabling Windows
Sandbox and importing the root certificate are system-trust changes made by the device owner.

1. Map `D:\rt772-lab` into the device read-only.
2. Import `rt772-lab-root.cer` into the device's `Trusted Root Certification Authorities`.
3. Verify the installer the way `electron-updater` will:

   ```powershell
   .\verify-lab-signature.ps1 -InstallerPath <installer> -ExpectedSha256 <sha256 from the manifest>
   ```

   Expected on the lab device: `RESULT: PASS`. Expected on the build machine (root not
   trusted): `RESULT: FAIL`. Both outcomes are evidence; record them.

## Drill (manual, on the lab device)

A packaged build refuses `--remote-debugging-*`, so this is driven by hand.

1. Install `0.1.0`. Pair (or note that pairing needs lab credentials), create a sale so the
   DB and outbox hold rows. Record the row counts.
2. Install `0.1.1` over it (re-run the installer). Confirm `userData` and the row counts
   survived, and `app.getVersion()` reads `0.1.1`.
3. Fixture build only: confirm `userData\backups\pos-pulse-pre-migration-*.db` was written
   before the new migration applied, and that `schema_migrations` lists the fixture.
4. Fixture build only: install `0.1.0` over `0.1.1-fixture`. Expect the schema-ahead refusal
   dialog and exit (no start on the newer DB), and the DB untouched.
5. Uninstall. Confirm `userData` is **not** deleted (`deleteAppDataOnUninstall: false`).
6. Negative: flip one byte of a copy of the installer; `verify-lab-signature.ps1` must report
   `HashMismatch` / FAIL. Verify an **unsigned** installer fails too.

## Clean-up and rotation

Leaf certificates expire in 90 days and the root in 180. To retire the lab trust early,
delete both certificates from `Cert:\CurrentUser\My` on the build machine and discard the
sandbox (its trust and `userData` die with it). Create a new pair with
`new-lab-signing-cert.ps1`; old installers then fail verification, which is intended.

## Next

The update leg (an `electron-updater` dependency, `UpdateService`, `SafePointGate`) is the
RT-322-shaped slice 2. It needs explicit dependency approval and an owner decision on the lab
update origin and its TLS trust. It is not part of this slice.
