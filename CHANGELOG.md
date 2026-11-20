# Changelog

All notable changes to the Schedura backend are recorded here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
the project follows [Semantic Versioning](https://semver.org/). How to cut a
release: [docs/releasing.md](docs/releasing.md).

## [Unreleased]

## [1.0.0] - 2026-11-20

First production release.

### Added
- Account and Settings API (Settings redesign, Part A).
- App versioning: `GET /health/version`, an `X-App-Version` header on every
  response, and a Sentry release named `schedura-backend@<version>+<commit>`.
- `MAESTRO_ENABLED` launch gate: Maestro shows as "coming soon" unless the
  flag is `true`.

### Changed
- X (Twitter) can only be newly connected on a paid plan.

### Fixed / Reliability (#233-#267)
- Graceful shutdown, liveness and readiness probes, Sentry error reporting.
- Publishing: stranded and scheduled posts are recovered, transient failures
  are held and retried instead of failing for good, rate limits are scoped per
  account, and a deleted workspace no longer publishes.
- Billing: webhook replay and duplicate-event protection, race-free usage
  counters.
- Hardening: request body limits, an upload media allowlist, throttling on the
  open auth routes, and request-rate metrics.
- Platform polling: LinkedIn API version, non-commentable media, quieter
  Instagram DM polling.
- Each cron now runs on one process per tick; web and worker roles can be split
  with `ROLE`.

[Unreleased]: https://github.com/Asad00713/social-media-backend/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/Asad00713/social-media-backend/releases/tag/v1.0.0
