use serde::{Deserialize, Serialize};
use specta::Type;

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
