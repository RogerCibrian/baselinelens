use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::parser;
use crate::parser::model::Baseline;

#[derive(Debug, Serialize, Deserialize, Type)]
pub struct Hello {
    pub msg: String,
}

#[tauri::command]
#[specta::specta]
pub(crate) fn hello() -> Hello {
    Hello {
        msg: "world".into(),
    }
}

/// Parses the CIS benchmark PDF at `path` and returns a fully-populated
/// `Baseline` for the frontend to render.
#[tauri::command]
#[specta::specta]
pub(crate) fn parse_baseline(path: String) -> Result<Baseline, String> {
    parser::parse(&PathBuf::from(path)).map_err(|err| err.to_string())
}
