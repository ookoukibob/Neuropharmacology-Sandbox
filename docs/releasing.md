# Release procedure

Neuropharmacology Sandbox is a **static web application**: a release is
a versioned, checksummed ZIP of the production `dist/` output, published
as a **GitHub pre-release** with its source tag. There is no npm
publication (`private: true` stays `true`), no deployment pipeline and no
backend. This document is the auditable, repeatable procedure.

Rules that never bend:

- **No tag and no published release may point to an unmerged PR
  commit.** Releases are cut only from verified commits on `main`.
- **No release without green gates.** Every check listed in step 3 must
  be run and pass on the exact commit being released.
- Artifacts (ZIP, checksum, test reports) are **never committed** to the
  repository; they live outside the source tree.

Versioning: `package.json` is the single source of the application
version (the About panel reads it at build time). A preview release uses
a SemVer prerelease such as `0.1.0-alpha.1`; the tag is `v` + that
version. Update `package.json` **and** `package-lock.json` together (two
version fields: top-level and `packages.""`), and update
[CHANGELOG.md](../CHANGELOG.md) in the same PR.

## 1. Release-preparation PR (local commands)

```bash
# On the prepared release branch — version, CHANGELOG, docs updated:
npm ci
npm run typecheck
npm run typecheck:e2e
npm run lint
npm test
npm run test:coverage
npm run build
npm run test:e2e          # needs: npx playwright install chromium
npm run test:crash        # same install; supervised-Chromium suite
npm audit --omit=dev      # production tree must be clean
git diff --check
```

Open the PR against `main` and wait for the four required CI checks
(`Quality gates`, `Coverage`, `E2E smoke test`, `NV-1 crash durability`)
to report **success on the PR head**. `main` is branch-protected: a
direct push is not possible and must not be attempted.

## 2. Merge and verify `main`

Merge the PR (merge commit, not squash, to keep auditable history).
Then verify the result:

```bash
git switch main
git pull --ff-only origin main
git log -1 --oneline                      # expected: the merge commit
git status                                # must be clean
```

Confirm the GitHub Actions run **triggered by the merge push** is green
(all four jobs). Do not release from a `main` that has moved since your
checks: re-run the local gate block from step 1 on the merged commit if
anything is uncertain.

## 3. Tag the verified commit

```bash
git tag -a v0.1.0-alpha.1 -m "Preview release v0.1.0-alpha.1"   # on the verified main HEAD
git push origin v0.1.0-alpha.1
```

The tag object records the exact commit SHA — that is the audit link
between the release assets and the source.

## 4. Build the release artifacts (local, not committed)

```bash
npm ci
npm run build
```

Inspect `dist/` before packaging: it must contain the entry HTML and
hashed assets, and must **not** contain `.env` files, secrets, local
audit artifacts, test fixtures that should not ship, or any bundled
pharmacology database.

```powershell
# Windows (PowerShell); equivalent zip/tar/sha256sum commands work on POSIX.
Compress-Archive -Path dist\* -DestinationPath neuropharmacology-sandbox-v0.1.0-alpha.1.zip -Force
(Get-FileHash neuropharmacology-sandbox-v0.1.0-alpha.1.zip -Algorithm SHA256).Hash.ToLower() `
  + "  neuropharmacology-sandbox-v0.1.0-alpha.1.zip" `
  | Out-File -Encoding ascii neuropharmacology-sandbox-v0.1.0-alpha.1.zip.sha256
```

Keep the ZIP and `.sha256` file **outside the repository working tree**.

## 5. Publish the GitHub pre-release

Create the release through the GitHub UI or API, marking it
**"This is a pre-release"** (never a latest/stable release for an
`-alpha` version), with `CHANGELOG.md`'s version section as the release
notes. Upload:

1. `neuropharmacology-sandbox-v<version>.zip`
2. `neuropharmacology-sandbox-v<version>.zip.sha256`

## 6. Verify the published release

After publication, verify the real artifacts — never assume the upload
matched the local files:

```powershell
# Re-download the published assets to a temp directory and re-hash:
Invoke-WebRequest -Uri https://github.com/ookoukibob/Neuropharmacology-Sandbox/releases/download/v0.1.0-alpha.1/neuropharmacology-sandbox-v0.1.0-alpha.1.zip -OutFile .\redownloaded.zip
(Get-FileHash .\redownloaded.zip -Algorithm SHA256).Hash            # must equal the published .sha256
```

- Confirm the release page shows **Pre-release** (not Latest), the tag
  `v0.1.0-alpha.1`, and both assets.
- Confirm the tag resolves to the intended `main` merge commit:
  `git ls-remote --tags origin v0.1.0-alpha.1` and the release page's
  "Source code" links.
- Optionally unzip the downloaded archive into a scratch directory and
  serve it (`npx vite preview --outDir <dir>` or any static server) to
  confirm the published bundle boots and the About panel reports the
  released version.

Only after these steps is the release real. A locally built ZIP that was
never uploaded and re-verified is a **candidate**, not a release.
