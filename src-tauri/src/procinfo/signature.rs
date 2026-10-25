//! Authenticode verification of a file: its embedded signature, or else the security
//! catalog that lists it (how most of Windows' own files are signed).

use std::ffi::c_void;
use std::io::ErrorKind;
use std::mem::{size_of, zeroed};
use std::ptr::{null, null_mut};
use std::sync::OnceLock;

use serde::Serialize;
use windows_sys::Win32::Foundation::{GENERIC_READ, HANDLE};
use windows_sys::Win32::Security::Cryptography::Catalog::{
    CryptCATAdminAcquireContext2, CryptCATAdminCalcHashFromFileHandle2, CryptCATAdminEnumCatalogFromHash,
    CryptCATAdminReleaseCatalogContext, CryptCATAdminReleaseContext, CryptCATCatalogInfoFromContext, CATALOG_INFO,
};
use windows_sys::Win32::Security::Cryptography::{CertGetNameStringW, CERT_NAME_SIMPLE_DISPLAY_TYPE};
use windows_sys::Win32::Security::WinTrust::{
    WinVerifyTrust, CRYPT_PROVIDER_SGNR, DRIVER_ACTION_VERIFY, WINTRUST_ACTION_GENERIC_VERIFY_V2, WINTRUST_CATALOG_INFO,
    WINTRUST_DATA, WINTRUST_DATA_0, WINTRUST_FILE_INFO, WTD_CACHE_ONLY_URL_RETRIEVAL, WTD_CHOICE_CATALOG, WTD_CHOICE_FILE,
    WTD_REVOCATION_CHECK_NONE, WTD_REVOKE_NONE, WTD_STATEACTION_CLOSE, WTD_STATEACTION_VERIFY, WTD_UI_NONE,
};
use windows_sys::Win32::Storage::FileSystem::{CreateFileW, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING};

use super::modules::FileCache;
use crate::winutil::{from_wide, is_local_path, wide, Handle};

// windows-sys only declares these with the Cryptography_Sip feature (for CRYPT_PROVIDER_DATA,
// which is only passed through here)
windows_link::link!("wintrust.dll" "system" fn WTHelperProvDataFromStateData(state: HANDLE) -> *mut c_void);
windows_link::link!("wintrust.dll" "system" fn WTHelperGetProvSignerFromChain(
    prov: *mut c_void, signer: u32, counter_signer: i32, counter_index: u32) -> *mut CRYPT_PROVIDER_SGNR);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Signature {
    status: &'static str,
    detail: String,
    signer: Option<String>,
    catalog: bool,
}

const TRUST_E_SUBJECT_FORM_UNKNOWN: u32 = 0x800B_0003;
const TRUST_E_NOSIGNATURE: u32 = 0x800B_0100;
const TRUST_E_EXPLICIT_DISTRUST: u32 = 0x800B_0111;
const TRUST_E_BAD_DIGEST: u32 = 0x8009_6010;
const CERT_E_EXPIRED: u32 = 0x800B_0101;
const CERT_E_UNTRUSTEDROOT: u32 = 0x800B_0109;
const CERT_E_CHAINING: u32 = 0x800B_010A;
const CERT_E_REVOKED: u32 = 0x800B_010C;
const CERT_E_UNTRUSTEDTESTROOT: u32 = 0x800B_010D;
const CRYPT_E_FILE_ERROR: u32 = 0x8009_2003;

fn unknown(detail: &str) -> Signature {
    Signature { status: "unknown", detail: detail.into(), signer: None, catalog: false }
}

/// The signature of a local file, cached by (path, size, modified time). Network paths
/// aren't touched: opening `\\host\…` would make Windows log in to that host.
pub fn signature(path: &str) -> Result<Signature, String> {
    static CACHE: OnceLock<FileCache<Signature>> = OnceLock::new();
    if !is_local_path(path) {
        return Ok(unknown("Not a local file"));
    }
    let meta = match std::fs::metadata(path) {
        Ok(m) if m.is_file() => m,
        Ok(_) => return Ok(unknown("Not a file")),
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(unknown("The file doesn't exist")),
        Err(e) if e.kind() == ErrorKind::PermissionDenied => return Ok(unknown("Access denied")),
        Err(_) => return Ok(unknown("Couldn't read the file")),
    };
    Ok(CACHE.get_or_init(FileCache::new).get(path, &meta, || verify(path)))
}

fn verify(path: &str) -> Signature {
    let wpath = wide(path);
    let mut file = WINTRUST_FILE_INFO {
        cbStruct: size_of::<WINTRUST_FILE_INFO>() as u32,
        pcwszFilePath: wpath.as_ptr(),
        hFile: null_mut(),
        pgKnownSubject: null_mut(),
    };
    let (code, signer) = win_verify(WTD_CHOICE_FILE, WINTRUST_DATA_0 { pFile: &mut file });
    match code {
        TRUST_E_NOSIGNATURE | TRUST_E_SUBJECT_FORM_UNKNOWN => catalog(&wpath).unwrap_or_else(|| result(code, None, false)),
        _ => result(code, signer, false),
    }
}

fn result(code: u32, signer: Option<String>, catalog: bool) -> Signature {
    let (status, detail) = match code {
        0 => ("valid", "Signed".into()),
        TRUST_E_NOSIGNATURE | TRUST_E_SUBJECT_FORM_UNKNOWN => ("unsigned", "Not signed".into()),
        TRUST_E_BAD_DIGEST => ("invalid", "The file was changed after it was signed".into()),
        CERT_E_EXPIRED => ("invalid", "The certificate has expired".into()),
        CERT_E_UNTRUSTEDROOT | CERT_E_CHAINING | CERT_E_UNTRUSTEDTESTROOT => ("invalid", "Not trusted on this computer".into()),
        TRUST_E_EXPLICIT_DISTRUST => ("invalid", "Explicitly distrusted".into()),
        CERT_E_REVOKED => ("invalid", "The certificate was revoked".into()),
        CRYPT_E_FILE_ERROR => ("unknown", "Couldn't read the file".into()),
        c => ("invalid", format!("The signature isn't valid (0x{c:08X})")),
    };
    Signature { status, detail, signer, catalog }
}

/// WinVerifyTrust (no UI, no revocation checks, nothing fetched from the network), and
/// the signer's name, read while the verification state is still open.
fn win_verify(choice: u32, subject: WINTRUST_DATA_0) -> (u32, Option<String>) {
    let mut data: WINTRUST_DATA = unsafe { zeroed() };
    data.cbStruct = size_of::<WINTRUST_DATA>() as u32;
    data.dwUIChoice = WTD_UI_NONE;
    data.fdwRevocationChecks = WTD_REVOKE_NONE;
    data.dwUnionChoice = choice;
    data.Anonymous = subject;
    data.dwStateAction = WTD_STATEACTION_VERIFY;
    data.dwProvFlags = WTD_CACHE_ONLY_URL_RETRIEVAL | WTD_REVOCATION_CHECK_NONE;
    let mut action = WINTRUST_ACTION_GENERIC_VERIFY_V2;
    let code = unsafe { WinVerifyTrust(null_mut(), &mut action, (&mut data as *mut WINTRUST_DATA).cast()) } as u32;
    let signer = signer_name(data.hWVTStateData);
    data.dwStateAction = WTD_STATEACTION_CLOSE;
    unsafe { WinVerifyTrust(null_mut(), &mut action, (&mut data as *mut WINTRUST_DATA).cast()) };
    (code, signer)
}

/// Subject of the first signer's certificate ("Microsoft Windows").
fn signer_name(state: HANDLE) -> Option<String> {
    if state.is_null() {
        return None;
    }
    unsafe {
        let prov = WTHelperProvDataFromStateData(state);
        if prov.is_null() {
            return None;
        }
        let signer = WTHelperGetProvSignerFromChain(prov, 0, 0, 0);
        if signer.is_null() || (*signer).csCertChain == 0 || (*signer).pasCertChain.is_null() {
            return None;
        }
        let cert = (*(*signer).pasCertChain).pCert;
        if cert.is_null() {
            return None;
        }
        let mut buf = [0u16; 512];
        let n = CertGetNameStringW(cert, CERT_NAME_SIMPLE_DISPLAY_TYPE, 0, null(), buf.as_mut_ptr(), buf.len() as u32);
        Some(from_wide(&buf)).filter(|s| n > 1 && !s.is_empty())
    }
}

/// A catalog admin context, released on drop.
struct CatAdmin(isize);

impl Drop for CatAdmin {
    fn drop(&mut self) {
        unsafe { CryptCATAdminReleaseContext(self.0, 0) };
    }
}

/// A catalog found for a hash, released on drop (before its admin context).
struct CatInfo<'a> {
    admin: &'a CatAdmin,
    info: isize,
}

impl Drop for CatInfo<'_> {
    fn drop(&mut self) {
        unsafe { CryptCATAdminReleaseCatalogContext(self.admin.0, self.info, 0) };
    }
}

/// The verdict of the security catalog that lists the file's hash; None when none does.
fn catalog(wpath: &[u16]) -> Option<Signature> {
    let file = Handle::new(unsafe {
        CreateFileW(
            wpath.as_ptr(),
            GENERIC_READ,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            null(),
            OPEN_EXISTING,
            0,
            null_mut(),
        )
    })?;
    // catalogs since Windows 8 hash with SHA256, older ones with SHA1
    for algorithm in ["SHA256", "SHA1"] {
        let walg = wide(algorithm);
        let mut raw = 0isize;
        if unsafe { CryptCATAdminAcquireContext2(&mut raw, &DRIVER_ACTION_VERIFY, walg.as_ptr(), null(), 0) } == 0 {
            continue;
        }
        let admin = CatAdmin(raw);
        let mut hash = [0u8; 64];
        let mut len = hash.len() as u32;
        if unsafe { CryptCATAdminCalcHashFromFileHandle2(admin.0, file.0, &mut len, hash.as_mut_ptr(), 0) } == 0 {
            continue;
        }
        let len = (len as usize).min(hash.len());
        let found = unsafe { CryptCATAdminEnumCatalogFromHash(admin.0, hash.as_ptr(), len as u32, 0, null_mut()) };
        if found == 0 {
            continue;
        }
        let info = CatInfo { admin: &admin, info: found };
        let mut cat_info: CATALOG_INFO = unsafe { zeroed() };
        cat_info.cbStruct = size_of::<CATALOG_INFO>() as u32;
        if unsafe { CryptCATCatalogInfoFromContext(info.info, &mut cat_info, 0) } == 0 {
            continue;
        }
        let tag: String = hash[..len].iter().map(|b| format!("{b:02X}")).collect();
        let wtag = wide(&tag);
        let mut member = WINTRUST_CATALOG_INFO {
            cbStruct: size_of::<WINTRUST_CATALOG_INFO>() as u32,
            dwCatalogVersion: 0,
            pcwszCatalogFilePath: cat_info.wszCatalogFile.as_ptr(),
            pcwszMemberTag: wtag.as_ptr(),
            pcwszMemberFilePath: wpath.as_ptr(),
            hMemberFile: file.0,
            pbCalculatedFileHash: hash.as_mut_ptr(),
            cbCalculatedFileHash: len as u32,
            pcCatalogContext: null_mut(),
            hCatAdmin: admin.0,
        };
        let (code, signer) = win_verify(WTD_CHOICE_CATALOG, WINTRUST_DATA_0 { pCatalog: &mut member });
        return Some(result(code, signer, true));
    }
    None
}
