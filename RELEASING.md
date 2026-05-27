# Releasing

The **git tag is the single source of truth** for the published version. You
never hand-edit a version in `package.json`.

## How to cut a release

1. Merge your PRs to `main`.
2. When `main` is ready, create a **GitHub Release**:
   - GitHub → Releases → *Draft a new release*
   - Tag: `vX.Y.Z` (e.g. `v0.5.0`), target `main`, *Create new tag on publish*
   - Write the notes, then **Publish release**.

That's it. Publishing the Release fires:

- **`npm release`** (`.github/workflows/npm-release.yml`, `on: release: published`)
  — stamps every workspace to `X.Y.Z`, pins the `cli → seed` dependency to the
  same version, then publishes `@praxis-framework/seed` and
  `@praxis-framework/cli` to npm via Trusted Publishing (OIDC).
- **`Dashboard image`** (`.github/workflows/dashboard-image.yml`) — the tag the
  Release created publishes the multi-arch `:X.Y.Z` (+ `:latest`) image to GHCR.

## Why `package.json` says `0.0.0`

Every `package.json` in the repo carries a deliberate `0.0.0` placeholder, and
`cli` depends on `@praxis-framework/seed: "*"`. npm requires a `version` field,
so we can't omit it — but it is never published. The release workflow overwrites
it with the tag version at publish time. This keeps the tag authoritative and
means there's no real number in the repo to drift out of sync with npm.

Local installs/builds use the workspace links, so the `0.0.0`/`*` placeholders
don't affect development.

## If a release fails

- **"Tag is not valid semver"** — the tag must be `vX.Y.Z`. Delete the Release +
  tag and recreate with a valid tag.
- **"cannot publish over previously published version"** — that version is
  already on npm. Cut the next version; npm publishes are immutable.
