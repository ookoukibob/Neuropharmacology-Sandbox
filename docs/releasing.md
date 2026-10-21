# Release procedure

Neuropharmacology Sandbox is a **static web application**. A release is a
versioned, checksummed ZIP of the production `dist/` output, attached to a
GitHub Release and tied to an exact source tag. There is no npm publication
(`private: true` stays `true`) and no backend. Hosting deployment is separate
from the versioned release archive.

## Rules that never bend

- **Release only a verified commit on `main`.** Never tag an unmerged PR
  commit or a branch-only commit.
- **No release without green gates** on the exact commit being released.
- Build the ZIP from the tagged source after a clean dependency install.
- Artifacts (ZIP, checksum, test reports) are never committed to the repository.
- A stable release (for example `1.0.0`) is published as a normal GitHub
  Release, not marked as a prerelease. SemVer prereleases such as
  `1.1.0-rc.1` must be marked as prereleases.

## Versioning

`package.json` is the source of the application version (the About panel reads
it at build time). The tag is `v` plus that version. Update `package.json` and
`package-lock.json` together (top-level version and
`packages[""].version`) and update [CHANGELOG.md](../CHANGELOG.md) in the
same release-preparation PR. Do not publish a release tag until the PR has
merged and the resulting `main` commit has passed all checks.

## 1. Release-preparation PR

On the release branch, after updating version, changelog and relevant
documentation, run:

```bash
npm ci
npm run typecheck
npm run typecheck:e2e
npm run lint
npm test
npm run test:coverage
npm run build
npm run test:e2e          # requires: npx playwright install chromium
npm run test:crash        # supervised Chromium; same install
npm audit --omit=dev      # production dependency tree must be clean
git diff --check
```

Open a PR against `main`. The workflow intentionally runs on branch pushes
and manual dispatch, not on pull-request events. Push the final PR head and
confirm these four required checks are successful for that exact commit:
`Quality gates`, `Coverage`, `E2E smoke test`, and `NV-1 crash durability`.
The branch protection on `main` requires those checks.

## 2. Merge and verify `main`

Merge the PR using the repository's allowed merge method. Then verify:

```bash
git switch main
git pull --ff-only origin main
git log -1 --oneline
git status
```

The working tree must be clean. Confirm the GitHub Actions run triggered by
the merge push completed successfully with all four jobs. If `main` moved
after the checks were run, rerun the gates on the commit that will be tagged.

## 3. Tag the verified commit

For the stable 1.0.0 release:

```bash
git tag -a v1.0.0 -m "Release v1.0.0"
git push origin v1.0.0
```

Run this on the verified `main` HEAD after the release-preparation PR has
merged. The annotated tag records the exact source commit represented by the
release assets.

## 4. Build the release artifacts

From a clean checkout of the exact tag:

```powershell
npm ci
npm run build

$version = (Get-Content package.json -Raw | ConvertFrom-Json).version
$archive = "neuropharmacology-sandbox-v$version.zip"
Compress-Archive -Path dist\* -DestinationPath $archive -Force
$hash = (Get-FileHash $archive -Algorithm SHA256).Hash.ToLower()
"$hash  $archive" | Out-File -Encoding ascii "$archive.sha256"
```

Inspect `dist/` before packaging. It must contain the app entry point and
built assets, and must not contain environment files, secrets, audit outputs,
test fixtures that should not ship, or a bundled pharmacology database.
Keep the ZIP and checksum outside the repository working tree.

## 5. Publish the GitHub Release

Create the release for the exact tag through the GitHub UI or API. For
`v1.0.0`, **leave “Set as a pre-release” unchecked** and use the
`[1.0.0]` section of the changelog as the release notes. Upload both files:

1. `neuropharmacology-sandbox-v1.0.0.zip`
2. `neuropharmacology-sandbox-v1.0.0.zip.sha256`

Do not describe a release as published until the assets are uploaded and
verified. The application is not published to npm.

## 6. Verify the published assets

Download both assets to a temporary directory and compare the checksum:

```powershell
$version = "1.0.0"
$archive = "neuropharmacology-sandbox-v$version.zip"
$base = "https://github.com/ookoukibob/Neuropharmacology-Sandbox/releases/download/v$version"
Invoke-WebRequest -Uri "$base/$archive" -OutFile ".\downloaded.zip"
Invoke-WebRequest -Uri "$base/$archive.sha256" -OutFile ".\published.sha256"
$expected = ((Get-Content ".\published.sha256" -Raw).Trim() -split "\s+")[0]
$actual = (Get-FileHash ".\downloaded.zip" -Algorithm SHA256).Hash.ToLower()
if ($actual -ne $expected) { throw "Published archive checksum mismatch" }
```

Also verify that:

- The release page has the intended tag and both assets; a stable release is
  not marked as a prerelease.
- The tag resolves to the intended verified `main` commit
  (`git ls-remote --tags origin v1.0.0` plus the release page's source links).
- The downloaded ZIP extracts and boots from a static server, and the About
  panel reports the version represented by the tag.

A locally built ZIP that was never uploaded and re-verified is a candidate,
not a completed release.
