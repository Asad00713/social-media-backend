# Releasing

How the backend is versioned and how a release is cut.

## Where the version lives

`package.json` `version` is the single source of truth. At runtime
`src/common/app-version.ts` exposes it, together with the short git SHA Railway
stamps on each deploy (`RAILWAY_GIT_COMMIT_SHA`):

| Where                  | What you see                                       |
| ---------------------- | -------------------------------------------------- |
| `GET /health/version`  | `{ "version": "1.0.0", "commit": "2b47f00" }`      |
| Response header        | `X-App-Version: 1.0.0` (every response)            |
| Sentry release         | `schedura-backend@1.0.0+2b47f00`                   |

`commit` is `dev` when running locally. `SENTRY_RELEASE`, if set, overrides the
Sentry release name.

## Semver rules

- **MAJOR** (`2.0.0`): a breaking change to the API contract, meaning an
  endpoint, request or response shape, or auth behaviour that an existing
  client would break on.
- **MINOR** (`1.1.0`): a backwards-compatible feature, such as a new endpoint,
  a new optional field, or a new integration.
- **PATCH** (`1.0.1`): a backwards-compatible fix, meaning bug fixes, hardening,
  performance, and docs or internal changes that ship.

Pre-release suffixes (`1.1.0-rc.1`) are valid.

## Release steps

1. Branch from `main`: `chore/release-X.Y.Z`.
2. Bump `version` in `package.json` and the two matching entries at the top of
   `package-lock.json` (`npm version X.Y.Z --no-git-tag-version` does all three).
3. In `CHANGELOG.md`, move the `[Unreleased]` entries under a new
   `## [X.Y.Z] - YYYY-MM-DD` heading, and update the compare links at the
   bottom.
4. Open a PR, get it merged to `main`, and let Railway deploy it.
5. After the merge, tag the merge commit on `main`: `git tag vX.Y.Z` and
   `git push origin vX.Y.Z`. The coordinator creates the tag.
6. Confirm the deploy: `GET /health/version` shows the new version and the
   merge commit's short SHA.

Every user-visible change adds a line under `[Unreleased]` in the PR that makes
it.

## API URL versioning

URLs are deliberately **not** versioned (no `/v1` prefix) yet. The frontend and
backend deploy together, so there is never a client on an older contract than
the server. Add URL versioning when a public API or a mobile app exists, which
is when old clients can outlive a deploy. Until then a breaking change is
handled by shipping both sides together, and still counts as a MAJOR bump.
