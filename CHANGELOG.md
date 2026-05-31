# Changelog

All notable changes to BaselineLens are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0] - 2026-05-30

### Added

- Parse a CIS Benchmark PDF you supply into an auditable baseline.
- Audit the local Windows machine against that baseline, entirely on-device.
- Overview report: overall compliance, score by level (L1 / L2 / BitLocker), a trend across recent scans, the weakest categories, and recent changes.
- Console workbench: search, filter, sort, and resizable columns over every recommendation, with saved views and a detail drawer showing expected vs. found values.
- Record exceptions, notes, and attestations per recommendation.
- Export a scan to CSV or JSON.
- Signed `.msi` installer for Windows 10 and 11.

[Unreleased]: https://github.com/RogerCibrian/baselinelens/compare/1.0.0...HEAD
[1.0.0]: https://github.com/RogerCibrian/baselinelens/releases/tag/1.0.0
