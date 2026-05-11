fn main() {
    tauri_build::build();

    // audit.ps1 is baked into the binary via `include_str!` from
    // audit/generator.rs. Cargo doesn't track that dependency on its own,
    // so without this directive an edit to the script wouldn't trigger a
    // rebuild and the running app would keep writing the stale embedded
    // version to disk.
    println!("cargo:rerun-if-changed=../ps/audit.ps1");
}
