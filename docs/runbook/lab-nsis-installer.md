# Lab NSIS installer (RT-772 slices 1 and 2)

> **LAB ONLY.** This builds a per-user NSIS installer signed with a **self-signed test
> certificate** for one disposable Windows device. It is not a release path: nothing here
> publishes, uploads, tags or promotes, and the artifact must never reach a customer or a
> production terminal. The production signing path is RT-321 (cloud-HSM, timestamped,
> publisher-pinned) and is unchanged.

## What this proves, and what it does not

| Proves                                                                               | Does not prove                                                      |
| :----------------------------------------------------------------------------------- | :------------------------------------------------------------------ |
| A reproducible per-user NSIS build of the shipped app, with a recorded SHA-256       | The production feed, signing service or promotion (RT-321 / RT-322) |
| The lab signature is `Valid` only where the lab root is trusted                      | Production signing, HSM custody, RFC 3161 timestamping              |
| The installed app keeps `userData` (SQLite, outbox, DPAPI secrets) across 0.1.0 → 0.1.1 | Staged rollout or the compat gate (slice 2 covers the update leg and safe-point gating) |
| A newer schema triggers the pre-migration snapshot; an older build then refuses to start (RT-320) on a **packaged** build | RT-321 / RT-322 / RT-324 acceptance (they stay open and independent) |

## Trust boundary

- The lab certificate subject contains `LAB TEST - NOT FOR PRODUCTION`. A production
  `publisherName` pin can never match it, and the lab pin can never match production.
- The root and leaf keys are **non-exportable** and live in `Cert:\CurrentUser\My` on the
  build machine only. No `.pfx`, no key on disk, nothing in the repo, Jira or Confluence.
- Only the **public** root (`D:\rt772-lab\certs\rt772-lab-root.cer`) leaves the build
  machine. It is imported **only on the disposable lab device**, by its owner. It is never
  trusted on the build machine: there the signature is expected to report `NotTrusted`.
- `electron-builder.lab.yml` has no uploading publish provider (one `generic` entry on the reserved
  `.test` host, see slice 2), no certificate path, and does not touch the shipped `electron-builder.yml`, the frozen identity (`tech.smartdatapulse.pos` /
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

## Slice 2: the update leg (lab only)

Slice 2 adds the packaged-only, fail-closed `UpdateService` and the `SafePointGate` (see
`docs/architecture/current.md` §4). Production behaviour is unchanged: the lab differs only by
configuration, so there is no lab-only verification path.

- **Lab feed.** `electron-builder.lab.yml` carries one `generic` publish entry on the reserved host
  `rt772-lab.test` with channel `lab`. It exists so electron-builder bakes an `app-update.yml` with
  the pinned lab publisher (electron-updater skips signature verification when none is baked).
  Builds still run with `--publish never`: nothing is uploaded, and a build also writes `lab.yml`
  next to the installer. The running app takes its origin from `ELECTRON_UPDATE_FEED_URL` and its
  channel from `POS_PULSE_UPDATE_CHANNEL`.
- **Serve it only inside the Sandbox.** `scripts/lab/serve-lab-feed.ps1` is a static HTTPS server
  (GET/HEAD, no Range, every request logged). It refuses to run outside the Sandbox user and for any
  host that is not `.test`. In the Sandbox: create a self-signed TLS certificate for the host name,
  trust it in the Sandbox's own store, add a hosts entry to `127.0.0.1`, and pass the thumbprint.
  The TLS certificate and the trust never leave the Sandbox.
- **Feeds for the drill.** One directory per case, each with `lab.yml` and the installer:
  `happy` (the newer, signed build), `tamper` (one byte flipped; `lab.yml` keeps the real hash),
  `unsigned` (signature removed with `signtool remove /s`; `lab.yml` rewritten to the new
  `sha512` and size), `wrongpub` (re-signed by a second leaf of the **same lab root** with a
  different subject; `lab.yml` rewritten) and `older` (the older build's `lab.yml` and installer).
  The five cases above serve no `.blockmap`, so a full download is used; the fallback drill below
  covers a differential attempt that fails.
- **Build with uncommitted changes.** `build-lab-installer.ps1 -AllowDirtyAppInputs` records the blob
  id of every differing app input in the manifest (`git hash-object <path>`), so the exact content
  can be checked against a later commit. Without the switch the build still refuses.
- **Cases and what to look for** (the `update:state` lines in `userData\logs\main-*.log`):

  | Case                            | Expected                                                                             |
  | :------------------------------ | :----------------------------------------------------------------------------------- |
  | newer signed build, no shift    | `checking`, `downloading`, `downloaded`, `installing` (app start); relaunch as new   |
  | tampered installer              | `verify_failed` (`sha512 checksum mismatch`); version unchanged                      |
  | unsigned installer              | `verify_failed` (`not signed by the application owner`); version unchanged           |
  | wrong publisher, valid chain    | `verify_failed` (pin mismatch); version unchanged                                    |
  | open shift                      | `update_pending` with blocker `open_shift`; not installed                            |
  | same download after shift close | installs at the next app start                                                       |
  | older version offered           | `checking`, `idle`; no installer download in the feed log; version unchanged         |
  | PowerShell cannot run           | `verify_unavailable` (the `signature verification unavailable` marker); never installs |

  Which cases exercise the app's own verifier (`signature-verifier.ts`): the accept path (first
  row), the unsigned and wrong-publisher rows, and the PowerShell row. The tampered row is refused
  earlier, by the `sha512` check, before any signature check.

- **Gotchas.**
  - electron-updater 6.8.10's own Windows verifier resolves "valid" when its PowerShell check cannot
    run, so it must not be left in charge: the app installs its own fail-closed verifier and reads it
    back. The "PowerShell cannot run" case is only meaningful against that verifier. In the Sandbox,
    `takeown /f` and `icacls ... /deny` on `powershell.exe` make the spawn fail (the file is owned by
    TrustedInstaller, so ownership comes first); only the app's PowerShell child is affected, because
    the driver's own process is already running.
  - The installer's relaunch after an update does **not** inherit the process environment: the
    relaunched app logs `update:disabled reason=no_origin`. A real terminal needs the origin and
    channel set persistently (user or machine environment).
  - A "was this state reached" check must read only the current session. Logs accumulate across
    launches, so a count over the whole file reports an earlier `installing` line (this made the
    first driver mark the older-version case as failed although that session behaved correctly).
  - A shift can be simulated by seeding rows (`shift_cashup_opens`, then `shift_cashup_closes`) into a
    copy of the DB. That exercises the app-start trigger; the shift-close trigger is covered by unit
    tests, not by this drill.

## Next

Beyond the lab: the production feed, signing service and promotion are RT-321 and RT-322, the
fleet visibility and minimum-supported-version contract is RT-323, and the drill on the rt9 lab is
RT-324. None of those is started here.

## Slice 3: differential-to-full fallback drill (RT-322, lab only)

Design §4/§12.9: a differential download that fails must fall back to a full download, and the full
download is still checked (`sha512`, then the pinned-publisher signature). No updater logic is added
for this; the pinned `electron-updater` 6.8.10 already does it (`AppUpdater.differentialDownloadInstaller`
catches any error and returns `true`, which `NsisUpdater` reads as "download in full"; `verifySignature`
runs after both paths). `scripts/__tests__/lab-nsis-config.test.ts` pins the configuration side: the
lab builder emits a `.blockmap` next to the installer, and neither the config nor `UpdateService`
disables differential download. This section is the runtime proof. Run it in the Sandbox only.

- **Feed.** Add `-BlockmapMode Corrupt` (or `Missing`) to `serve-lab-feed.ps1`; default is `Normal`.
  `Corrupt` answers every `*.blockmap` request with non-gzip bytes, `Missing` with 404. It never
  touches the installer or `lab.yml`.
- **Layout.** Copy the `happy` feed, plus the new build's `POS-Pulse-LAB-Setup-<new>.exe.blockmap`
  and the old build's blockmap, from the build output next to the installers, in every feed
  directory (electron-updater fetches both; a missing old map would fail step 0 on a 404 instead of
  the cause it is meant to show). `Corrupt` and `Missing` answer before the file lookup, so they
  hold either way.
- **Where the evidence is.** The app never routes electron-updater's own logger into `main-*.log`
  (`UpdateService` records only `update:*` state lines), so the fallback line and its cause are
  written to the process console. Launch the packaged lab POS from PowerShell with its output piped
  to a file, for example `& "$env:LOCALAPPDATA\Programs\POS Pulse\POS Pulse.exe" 2>&1 | Tee-Object C:\rt322-console.log`
  (piping keeps the console handle attached), and read the fallback line and the error text after it
  there; the `update:*` states and `verify_failed` stay in `main-*.log`.
  The build writes them by default (`createBlockmap`); do not pass `--config.nsis.differentialPackage=false`.

| Step | Expected |
| :--- | :------- |
| 0. `Normal`, real blockmaps, `happy` installer | the fallback line with cause `Server doesn't support Accept-Ranges` (the lab feed has no Range support), then a full download, `downloaded`, safe-point install. Proves the fallback on a failure that is not injected |
| 1. `-BlockmapMode Corrupt`, `happy` installer | fallback line preceded by `Cannot parse blockmap` for a `.blockmap` URL (the new one in 6.8.10, which fetches it first; either map is accepted, `Corrupt` serves junk for both) and not the Accept-Ranges cause, then a full installer GET in the feed log, `downloaded`, install at the safe point; relaunch as the new version |
| 2. `-BlockmapMode Missing`, `happy` installer | fallback line preceded by a `404` HTTP error on the `.blockmap` URL, then full download and verified install |
| 3. `-BlockmapMode Corrupt`, `tamper` installer | the fallback line, then `verify_failed` (`sha512 checksum mismatch`); version unchanged; the installer never runs |
| 4. `-BlockmapMode Corrupt`, `wrongpub` installer | the fallback line, then `verify_failed` from the signature check (pin mismatch); version unchanged. Proves the publisher pin holds on the fallback path |

A successful differential download is **not** exercised: the lab feed serves no HTTP Range, so every
differential attempt ends in the fallback. Only the fallback and the checks after it are proven here.

Pass criteria: in steps 0-2 the update never ends in an error state and the install happens
only after the safe-point gate; in steps 3 and 4 nothing is installed. Reset the Sandbox between steps (the
downloaded-update cache would otherwise short-circuit the download). Record the log excerpts in Jira
RT-322 and update the Confluence lab runbook page afterwards.
