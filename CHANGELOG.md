# Changelog

All notable changes to BaselineLens are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Recommendations with a range threshold ("or fewer" / "or more", including parenthesized forms like "(or less)") are now evaluated as a range instead of an exact value, so a stricter-than-required setting is correctly counted as passing. The threshold is read from the recommendation title or the audit text's qualifier. Affects recs such as some Windows LAPS password settings and the Config Refresh cadence.
- String settings whose value contains a period — such as a firewall log file path ending in ".log" — are no longer cut off at the first period, so a correctly-set value is detected instead of reported as a mismatch.
- String settings that accept one of several values, such as "1, 2 or 3", now pass when the device matches any of them, rather than being compared against the whole phrase as a single literal. Affects recs such as the smart card removal behavior setting.
- A setting whose expected value is repeated on its own line below the registry path no longer folds that value into the value name, so it reads the right value. Affects the setting for restricting remote calls to SAM.
- Settings stored under a device-specific GUID subkey are now resolved at scan time — by locating the Intune enrollment or the policy's winning provider — instead of looking for a literal placeholder key that never exists. Affects recs such as Config Refresh and Auto-Connect to Wi-Fi Sense hotspots. A placeholder that can't be resolved is now reported as an error rather than a misleading failure.

Thanks to Reddit users u/FormerPick102 and u/saffronjewel420 for reporting the issues fixed above.

## [1.0.0] - 2026-05-31

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
