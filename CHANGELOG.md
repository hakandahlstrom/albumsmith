# Changelog

All notable changes to Albumsmith are listed here.
The format follows [Keep a Changelog](https://keepachangelog.com/), and the project uses [Semantic Versioning](https://semver.org/).

## [1.0.0-rc.1] - 2026-11-12

First public release candidate.

### Added

- Rule-based Flickr albums: tags (any or all), taken-date range, "on this day", sort order, primary photo with optional lock.
- "Check all" preview of what each rule would add or remove.
- Nightly sync with a safety check that leaves an album alone if it would shrink a lot.
- Albums page with managed and not-managed filter and a gold frame on managed albums.
- Delete rule: stops managing an album without touching it on Flickr.
- Export and import of rules, with preview, and rotating automatic backups.
- Single-owner setup protected by a setup code.
- Health endpoint, version in the footer, configurable port and data folder, session secret generated automatically.
- Docker image and Docker Compose file.
