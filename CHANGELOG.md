# Changelog

All notable changes to Albumsmith are listed here.
The format follows [Keep a Changelog](https://keepachangelog.com/), and the project uses [Semantic Versioning](https://semver.org/).

## [1.0.0] - 2026-11-13

First stable release. There are no functional changes since 1.0.0-rc.3. The README no longer mentions primary photo, which is not available in the interface yet.

## [1.0.0-rc.3] - 2026-11-12

### Changed

- On small screens the menu collapses into a button that opens the list of pages.
- On small screens wide tables scroll sideways inside their own box instead of making the whole page wider.

## [1.0.0-rc.2] - 2026-11-12

### Added

- Screenshots in the README.

### Changed

- The container now stops within a second on SIGTERM or SIGINT, instead of being killed after the Docker timeout. A run in progress gets up to 8 seconds to finish.
- "Export rules" takes you to the login page when your session has expired, instead of saving an error message as a file.
- GitHub Actions workflows use the current major versions of all actions.

## [1.0.0-rc.1] - 2026-11-12

First public release candidate.

### Added

- Rule-based Flickr albums: tags (any or all), taken-date range, "on this day", sort order.
- "Check all" preview of what each rule would add or remove.
- Nightly sync with a safety check that leaves an album alone if it would shrink a lot.
- Albums page with managed and not-managed filter and a gold frame on managed albums.
- Delete rule: stops managing an album without touching it on Flickr.
- Export and import of rules, with preview, and rotating automatic backups.
- Single-owner setup protected by a setup code.
- Health endpoint, version in the footer, configurable port and data folder, session secret generated automatically.
- Docker image and Docker Compose file.
