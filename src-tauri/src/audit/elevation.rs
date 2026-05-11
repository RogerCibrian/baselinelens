//! Detects whether the current process is running elevated. Used by
//! the audit runner to decide between the in-process pipe path (when
//! we already have admin) and the UAC-elevated child path (when we
//! don't).

#[cfg(windows)]
pub(crate) fn is_elevated() -> bool {
    use std::mem;

    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::Security::{
        GetTokenInformation, TOKEN_ELEVATION, TOKEN_QUERY, TokenElevation,
    };
    use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    // SAFETY: the three Win32 calls below take valid handles or pointers
    // to local memory; we close the token handle before returning.
    unsafe {
        let mut token = HANDLE::default();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).is_err() {
            return false;
        }
        let mut elev = TOKEN_ELEVATION::default();
        let mut size: u32 = 0;
        let result = GetTokenInformation(
            token,
            TokenElevation,
            Some(&mut elev as *mut _ as *mut std::ffi::c_void),
            mem::size_of::<TOKEN_ELEVATION>() as u32,
            &mut size,
        );
        let _ = CloseHandle(token);
        result.is_ok() && elev.TokenIsElevated != 0
    }
}

#[cfg(not(windows))]
pub(crate) fn is_elevated() -> bool {
    // Non-Windows targets can't run the audit anyway (no powershell.exe,
    // no Win32 token model). Reporting `false` routes the runner to the
    // elevated-child path, which then fails fast on spawn — surfacing a
    // clear "couldn't start" error rather than crashing later.
    false
}
