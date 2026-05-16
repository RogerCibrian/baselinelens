//! Data types persisted to the appdata directory.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::HashMap;

/// Per-baseline user annotations, persisted as
/// `user_states/{baseline_sha256}.json`. Loading re-creates the maps; an
/// absent file means a fresh baseline with no annotations yet.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UserState {
    pub(crate) baseline_sha256: String,
    pub(crate) exceptions: HashMap<String, Exception>,
    pub(crate) notes: HashMap<String, Note>,
}

/// An accepted-risk decision against a single recommendation. Counted as a
/// pass for the In-scope score; the reason and grantor are surfaced in the
/// detail drawer.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Exception {
    pub(crate) reason: String,
    pub(crate) granted_at: DateTime<Utc>,
    pub(crate) granted_by: Option<String>,
}

/// Free-form context attached to a recommendation. Doesn't affect status or
/// scoring; survives across scans of the same baseline.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Note {
    pub(crate) text: String,
    pub(crate) updated_at: DateTime<Utc>,
}

/// Cross-baseline application state, persisted as `app_state.json`. Tracks
/// which baseline (if any) the dashboard should reopen on next launch and
/// user-level UI preferences that don't belong to any single baseline.
#[derive(Debug, Clone, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppState {
    pub(crate) active_baseline_sha: Option<String>,
    #[serde(default)]
    pub(crate) preferences: Preferences,
}

/// User-level UI preferences that survive baseline switches.
#[derive(Debug, Clone, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Preferences {
    #[serde(default)]
    pub(crate) theme: Theme,
    #[serde(default)]
    pub(crate) time_format: TimeFormat,
    #[serde(default)]
    pub(crate) density: Density,
}

/// Console table row spacing. `Comfortable` is the roomier default;
/// `Compact` tightens row padding so more recommendations fit on
/// screen for admin scanning.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Density {
    #[default]
    Comfortable,
    Compact,
}

/// Clock display preference for rendered timestamps. `TwentyFourHour`
/// shows `14:30`; `TwelveHour` shows `2:30 PM`. Date parts are
/// unaffected.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, Type, PartialEq, Eq)]
pub(crate) enum TimeFormat {
    #[default]
    #[serde(rename = "24h")]
    TwentyFourHour,
    #[serde(rename = "12h")]
    TwelveHour,
}

/// Color scheme preference. `System` follows the OS via the webview's
/// `prefers-color-scheme`; `Light` / `Dark` pin the theme regardless.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Theme {
    #[default]
    System,
    Light,
    Dark,
}
