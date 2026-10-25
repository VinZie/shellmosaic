//! The Windows Event Log API (wevtapi) behind the Event Viewer: channels, log
//! properties, queries, live subscriptions and event XML. Free of Tauri.

use std::collections::{HashMap, VecDeque};
use std::mem::{size_of, size_of_val};
use std::ptr::null;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde::Serialize;
use windows_sys::Win32::Foundation::{
    ERROR_ACCESS_DENIED, ERROR_EVT_CHANNEL_NOT_FOUND, ERROR_EVT_FILTER_ALREADYSCOPED, ERROR_EVT_FILTER_OUT_OF_RANGE,
    ERROR_EVT_FILTER_TOO_COMPLEX, ERROR_EVT_FILTER_UNEXPECTEDTOKEN, ERROR_EVT_INVALID_CHANNEL_PATH,
    ERROR_EVT_INVALID_OPERATION_OVER_ENABLED_DIRECT_CHANNEL, ERROR_EVT_INVALID_QUERY, ERROR_EVT_MAX_INSERTS_REACHED,
    ERROR_EVT_MESSAGE_NOT_FOUND, ERROR_EVT_QUERY_RESULT_STALE, ERROR_EVT_SUBSCRIPTION_TO_DIRECT_CHANNEL,
    ERROR_INSUFFICIENT_BUFFER, ERROR_INVALID_OPERATION, ERROR_NO_MORE_ITEMS, ERROR_TIMEOUT, WAIT_OBJECT_0,
};
use windows_sys::Win32::System::EventLog::{
    EvtChannelConfigEnabled, EvtChannelConfigType, EvtClose, EvtFormatMessage, EvtFormatMessageXml, EvtGetChannelConfigProperty,
    EvtGetExtendedStatus, EvtGetLogInfo, EvtGetQueryInfo, EvtLogFileSize, EvtLogLastWriteTime, EvtLogNumberOfLogRecords, EvtLogOldestRecordNumber,
    EvtNext, EvtNextChannelPath, EvtOpenChannelConfig, EvtOpenChannelEnum, EvtOpenChannelPath, EvtOpenLog,
    EvtOpenPublisherMetadata, EvtQuery, EvtQueryChannelPath, EvtQueryForwardDirection, EvtQueryReverseDirection,
    EvtQueryStatuses, EvtQueryTolerateQueryErrors, EvtRender, EvtRenderEventXml, EvtSubscribe, EvtSubscribeToFutureEvents, EvtVarTypeBoolean,
    EvtVarTypeFileTime, EvtVarTypeHexInt32, EvtVarTypeHexInt64, EvtVarTypeUInt32, EvtVarTypeUInt64,
    EVT_CHANNEL_CONFIG_PROPERTY_ID, EVT_HANDLE, EVT_LOG_PROPERTY_ID, EVT_VARIANT, EVT_VARIANT_TYPE_ARRAY,
};
use windows_sys::Win32::System::Threading::{CreateEventW, ResetEvent, WaitForSingleObject};

use crate::winutil::{describe, filetime_ms, from_wide, last_error, last_error_text, wide, Handle};

/// The largest event XML handed out (UTF-8 bytes); bigger events fall back to the raw
/// XML, or are skipped. Cutting one short would break its XML.
const MAX_XML: usize = 1024 * 1024;
/// Events fetched per EvtNext call.
const BATCH: usize = 64;
const NEXT_TIMEOUT_MS: u32 = 5000;
/// How long one call scans for text-filter matches before handing back what it has.
const SCAN_BUDGET: Duration = Duration::from_millis(1500);
const CHANNELS_FRESH: Duration = Duration::from_secs(60);
const MAX_PUBLISHERS: usize = 1000;
/// A provider whose metadata couldn't be opened is tried again after this long.
const PUBLISHER_RETRY: Duration = Duration::from_secs(10 * 60);
const MAX_CHANNEL: usize = 512;
const MAX_XPATH: usize = 16 * 1024;
const MAX_TEXT: usize = 1024;

const CLASSIC: [&str; 6] = ["Application", "System", "Security", "Setup", "ForwardedEvents", "HardwareEvents"];

/// An event log handle (query, event, subscription, publisher metadata, …), closed on drop.
pub struct EvtHandle(EVT_HANDLE);

impl EvtHandle {
    fn new(h: EVT_HANDLE) -> Option<Self> {
        // never build one around 0: dropping it would overwrite the last error
        if h != 0 {
            Some(Self(h))
        } else {
            None
        }
    }
}

impl Drop for EvtHandle {
    fn drop(&mut self) {
        unsafe { EvtClose(self.0) };
    }
}

// ── channels ────────────────────────────────────────────────────────────

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventChannel {
    pub name: String,
    pub enabled: bool,
    /// "admin" | "operational" | "analytic" | "debug" | "classic"
    pub kind: &'static str,
}

type ChannelCache = Mutex<Option<(Instant, Vec<EventChannel>)>>;

/// Every channel on this computer, the classic logs first; cached for a minute.
pub fn channels() -> Result<Vec<EventChannel>, String> {
    static CACHE: OnceLock<ChannelCache> = OnceLock::new();
    let cache = CACHE.get_or_init(Default::default);
    if let Some((t, list)) = cache.lock().as_ref() {
        if t.elapsed() < CHANNELS_FRESH {
            return Ok(list.clone());
        }
    }
    let mut list: Vec<EventChannel> = channel_names()?.into_iter().map(channel).collect();
    list.sort_by_cached_key(|c| (c.kind != "classic", c.name.to_lowercase()));
    *cache.lock() = Some((Instant::now(), list.clone()));
    Ok(list)
}

fn channel_names() -> Result<Vec<String>, String> {
    let failed = |code| format!("Couldn't list the event logs: {}", describe(code));
    let channels = EvtHandle::new(unsafe { EvtOpenChannelEnum(0, 0) }).ok_or_else(|| failed(last_error()))?;
    let mut names = Vec::new();
    let mut buf = vec![0u16; 512];
    loop {
        let mut used = 0u32;
        if unsafe { EvtNextChannelPath(channels.0, buf.len() as u32, buf.as_mut_ptr(), &mut used) } != 0 {
            names.push(from_wide(&buf[..(used as usize).min(buf.len())]));
            continue;
        }
        match last_error() {
            ERROR_NO_MORE_ITEMS => return Ok(names),
            ERROR_INSUFFICIENT_BUFFER if (used as usize) > buf.len() && used <= 32 * 1024 => buf.resize(used as usize, 0),
            e => return Err(failed(e)),
        }
    }
}

/// A channel's state and type; one whose configuration can't be read counts as an enabled operational log.
fn channel(name: String) -> EventChannel {
    let config = EvtHandle::new(unsafe { EvtOpenChannelConfig(0, wide(&name).as_ptr(), 0) });
    let property = |id| config.as_ref().and_then(|c| channel_property(c, id));
    let enabled = property(EvtChannelConfigEnabled) != Some(0);
    let kind = if CLASSIC.iter().any(|c| c.eq_ignore_ascii_case(&name)) {
        "classic"
    } else {
        match property(EvtChannelConfigType) {
            Some(0) => "admin",
            Some(2) => "analytic",
            Some(3) => "debug",
            _ => "operational",
        }
    };
    EventChannel { name, enabled, kind }
}

fn channel_property(config: &EvtHandle, id: EVT_CHANNEL_CONFIG_PROPERTY_ID) -> Option<u64> {
    let mut v = EVT_VARIANT::default();
    let mut used = 0u32;
    let ok = unsafe { EvtGetChannelConfigProperty(config.0, id, 0, size_of::<EVT_VARIANT>() as u32, &mut v, &mut used) } != 0;
    if ok {
        variant_u64(&v)
    } else {
        None
    }
}

/// A boolean, integer or FILETIME variant as a number.
fn variant_u64(v: &EVT_VARIANT) -> Option<u64> {
    let t = v.Type as i32;
    // SAFETY: the union member read is the one `Type` names
    unsafe {
        if t == EvtVarTypeBoolean {
            Some((v.Anonymous.BooleanVal != 0) as u64)
        } else if t == EvtVarTypeUInt32 || t == EvtVarTypeHexInt32 {
            Some(v.Anonymous.UInt32Val as u64)
        } else if t == EvtVarTypeUInt64 || t == EvtVarTypeHexInt64 || t == EvtVarTypeFileTime {
            Some(v.Anonymous.UInt64Val)
        } else {
            None
        }
    }
}

// ── log properties ──────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventLogInfo {
    pub records: Option<u64>,
    pub file_size: Option<u64>,
    /// Unix ms
    pub last_write: Option<i64>,
    pub oldest_record: Option<u64>,
}

pub fn log_info(channel: &str) -> Result<EventLogInfo, String> {
    check_channel(channel)?;
    let log = EvtHandle::new(unsafe { EvtOpenLog(0, wide(channel).as_ptr(), EvtOpenChannelPath) })
        .ok_or_else(|| open_error(last_error(), channel))?;
    let mut denied = 0;
    let mut property = |id: EVT_LOG_PROPERTY_ID| {
        let mut v = EVT_VARIANT::default();
        let mut used = 0u32;
        if unsafe { EvtGetLogInfo(log.0, id, size_of::<EVT_VARIANT>() as u32, &mut v, &mut used) } != 0 {
            variant_u64(&v)
        } else {
            denied += (last_error() == ERROR_ACCESS_DENIED) as u32;
            None
        }
    };
    let info = EventLogInfo {
        records: property(EvtLogNumberOfLogRecords),
        file_size: property(EvtLogFileSize),
        last_write: property(EvtLogLastWriteTime).filter(|&t| t > 0).map(|t| filetime_ms(t as i64)),
        oldest_record: property(EvtLogOldestRecordNumber),
    };
    if denied == 4 {
        return Err(open_error(ERROR_ACCESS_DENIED, channel));
    }
    Ok(info)
}

// ── input checks and errors ─────────────────────────────────────────────

fn check_channel(channel: &str) -> Result<(), String> {
    if channel.trim().is_empty() {
        Err("No log was given.".into())
    } else if channel.chars().count() > MAX_CHANNEL {
        Err("That log name is too long.".into())
    } else if channel.chars().any(char::is_control) {
        Err("A log name can't contain control characters.".into())
    } else {
        Ok(())
    }
}

/// The XPath filter to run ("*" for every event).
fn check_xpath(xpath: Option<&str>) -> Result<String, String> {
    let xpath = xpath.map(str::trim).filter(|x| !x.is_empty()).unwrap_or("*");
    if xpath.len() > MAX_XPATH {
        return Err("The filter is too long (16 KB at most).".into());
    }
    if xpath.contains('\0') {
        return Err("The filter isn't a valid event query: it contains a NUL character.".into());
    }
    // a structured <QueryList> could name other logs and .evtx files anywhere on disk
    if xpath.starts_with('<') {
        return Err("The filter isn't a valid event query: use an XPath filter such as *[System[Level=2]], not a <QueryList>.".into());
    }
    Ok(xpath.to_string())
}

/// Why opening a log, a query or a subscription failed. Call right after the failure:
/// the details of a bad query are kept per thread until the next event log call.
fn open_error(code: u32, channel: &str) -> String {
    match code {
        ERROR_EVT_CHANNEL_NOT_FOUND | ERROR_EVT_INVALID_CHANNEL_PATH => format!("No such log: {channel}"),
        ERROR_EVT_INVALID_QUERY
        | ERROR_EVT_FILTER_ALREADYSCOPED..=ERROR_EVT_FILTER_UNEXPECTEDTOKEN
        | ERROR_EVT_FILTER_TOO_COMPLEX
        | ERROR_EVT_FILTER_OUT_OF_RANGE => {
            format!("The filter isn't a valid event query: {}", extended_status().unwrap_or_else(|| describe(code)))
        }
        ERROR_ACCESS_DENIED => format!("Couldn't open the {channel} log: access denied (it needs Shellmosaic running as administrator)"),
        ERROR_EVT_SUBSCRIPTION_TO_DIRECT_CHANNEL => format!("{channel} is an analytic or debug log: it can't be watched live"),
        ERROR_EVT_INVALID_OPERATION_OVER_ENABLED_DIRECT_CHANNEL => {
            format!("{channel} is an analytic or debug log: it can only be read while it's disabled")
        }
        _ => format!("Couldn't open the {channel} log: {}", describe(code)),
    }
}

/// The error a tolerant query met (a missing log, no access, a bad filter), if any.
fn query_status(results: &EvtHandle) -> Option<u32> {
    // the variant and the array it points to (one status per log queried)
    let mut buf = [0u64; 32];
    let mut used = 0u32;
    let size = size_of_val(&buf) as u32;
    if unsafe { EvtGetQueryInfo(results.0, EvtQueryStatuses, size, buf.as_mut_ptr().cast(), &mut used) } == 0 {
        return None;
    }
    // SAFETY: the buffer starts with an EVT_VARIANT (and is aligned for one); its array is checked below
    let v = unsafe { &*(buf.as_ptr() as *const EVT_VARIANT) };
    let room = (used.min(size) as usize).saturating_sub(size_of::<EVT_VARIANT>()) / size_of::<u32>();
    let count = (v.Count as usize).min(room);
    if v.Type != EvtVarTypeUInt32 as u32 | EVT_VARIANT_TYPE_ARRAY || count == 0 || unsafe { v.Anonymous.UInt32Arr }.is_null() {
        return None;
    }
    let statuses = unsafe { std::slice::from_raw_parts(v.Anonymous.UInt32Arr, count) };
    statuses.iter().copied().find(|&s| s != 0)
}

/// Why reading the next events failed.
fn read_error(code: u32) -> String {
    match code {
        ERROR_EVT_QUERY_RESULT_STALE => "The log was cleared or overwritten while it was being read. Run the query again.".into(),
        _ => format!("Couldn't read more events: {}", describe(code)),
    }
}

/// The detailed text of the last event log error on this thread (where a query went wrong).
fn extended_status() -> Option<String> {
    let mut buf = [0u16; 1024];
    let mut used = 0u32;
    if unsafe { EvtGetExtendedStatus(buf.len() as u32, buf.as_mut_ptr(), &mut used) } != 0 {
        return None;
    }
    let text = from_wide(&buf[..(used as usize).min(buf.len())]);
    let text = text.trim().trim_end_matches('.');
    (!text.is_empty()).then(|| text.to_string())
}

// ── reading events ──────────────────────────────────────────────────────

/// Text every returned event's XML must contain, ignoring case.
pub struct TextFilter {
    needle: String,
    ascii: bool,
}

impl TextFilter {
    /// None for no (or empty) text.
    pub fn new(text: Option<&str>) -> Result<Option<Self>, String> {
        let Some(text) = text.filter(|t| !t.is_empty()) else { return Ok(None) };
        if text.len() > MAX_TEXT {
            return Err("The search text is too long (1 KB at most).".into());
        }
        Ok(Some(Self { needle: text.to_lowercase(), ascii: text.is_ascii() }))
    }

    pub fn matches(&self, xml: &str) -> bool {
        if self.ascii {
            let n = self.needle.as_bytes();
            xml.as_bytes().windows(n.len()).any(|w| w.eq_ignore_ascii_case(n))
        } else {
            xml.to_lowercase().contains(&self.needle)
        }
    }
}

enum Next {
    Events(Vec<EvtHandle>),
    End,
    Timeout,
}

/// Up to `want` (≤ BATCH) events from a query or subscription.
fn next_events(results: &EvtHandle, want: usize, timeout_ms: u32) -> Result<Next, String> {
    let mut raw = [0 as EVT_HANDLE; BATCH];
    let want = want.clamp(1, BATCH);
    let mut got = 0u32;
    if unsafe { EvtNext(results.0, want as u32, raw.as_mut_ptr(), timeout_ms, 0, &mut got) } == 0 {
        return match last_error() {
            // (a subscription read again after it ran dry, before new events arrived, answers ERROR_INVALID_OPERATION)
            ERROR_NO_MORE_ITEMS | ERROR_INVALID_OPERATION => Ok(Next::End),
            ERROR_TIMEOUT => Ok(Next::Timeout),
            e => Err(read_error(e)),
        };
    }
    let events: Vec<EvtHandle> = raw[..(got as usize).min(want)].iter().filter_map(|&h| EvtHandle::new(h)).collect();
    Ok(if events.is_empty() { Next::End } else { Next::Events(events) })
}

/// Turns event handles into XML, reusing its buffers from one event to the next.
#[derive(Default)]
struct Renderer {
    raw: Vec<u16>,
    formatted: Vec<u16>,
}

impl Renderer {
    /// The formatted XML (with <RenderingInfo>) when the provider's messages can be
    /// found, otherwise the raw XML; None when the event can't be rendered or is too large.
    fn event_xml(&mut self, event: &EvtHandle) -> Option<String> {
        let raw = self.raw_xml(event)?;
        let formatted = provider_name(&raw)
            .and_then(|name| publisher(&name))
            .and_then(|meta| self.formatted_xml(&meta.lock(), event));
        Some(formatted.unwrap_or(raw))
    }

    fn raw_xml(&mut self, event: &EvtHandle) -> Option<String> {
        if self.raw.is_empty() {
            self.raw = vec![0; 8 * 1024];
        }
        for _ in 0..2 {
            let (mut used, mut count) = (0u32, 0u32);
            let size = (self.raw.len() * 2) as u32;
            let ok = unsafe { EvtRender(0, event.0, EvtRenderEventXml, size, self.raw.as_mut_ptr().cast(), &mut used, &mut count) } != 0;
            // `used` counts bytes here
            let units = (used as usize).div_ceil(2);
            if ok {
                return within_cap(from_wide(&self.raw[..units.min(self.raw.len())]));
            }
            if last_error() != ERROR_INSUFFICIENT_BUFFER || units <= self.raw.len() || units > MAX_XML + 1 {
                return None;
            }
            self.raw.resize(units, 0);
        }
        None
    }

    fn formatted_xml(&mut self, meta: &EvtHandle, event: &EvtHandle) -> Option<String> {
        if self.formatted.is_empty() {
            self.formatted = vec![0; 16 * 1024];
        }
        for _ in 0..3 {
            // nothing left over from the previous event if the call writes nothing
            self.formatted[0] = 0;
            let mut used = 0u32;
            let len = self.formatted.len() as u32;
            let ok = unsafe {
                EvtFormatMessage(meta.0, event.0, 0, 0, null(), EvtFormatMessageXml, len, self.formatted.as_mut_ptr(), &mut used)
            } != 0;
            // `used` counts characters here
            let used = used as usize;
            if ok {
                return within_cap(from_wide(&self.formatted[..used.min(self.formatted.len())]));
            }
            let code = last_error();
            if used > self.formatted.len() {
                if used > MAX_XML + 1 {
                    return None;
                }
                self.formatted.resize(used, 0);
                continue;
            }
            // a message (or an insert in it) is missing, but the XML may be there: keep it if it's whole
            if (ERROR_EVT_MESSAGE_NOT_FOUND..=ERROR_EVT_MAX_INSERTS_REACHED).contains(&code) {
                let xml = from_wide(&self.formatted[..used]);
                if xml.starts_with("<Event") && xml.trim_end().ends_with("</Event>") {
                    return within_cap(xml);
                }
            }
            return None;
        }
        None
    }
}

fn within_cap(xml: String) -> Option<String> {
    (!xml.is_empty() && xml.len() <= MAX_XML).then_some(xml)
}

/// The `Name` of the event's `<Provider>` element.
fn provider_name(xml: &str) -> Option<String> {
    let start = xml.find("<Provider ")? + "<Provider ".len();
    let tag = &xml[start..];
    let tag = &tag[..tag.find('>')?];
    // `Name=`, not the end of `EventSourceName=`
    let (at, _) = tag
        .match_indices("Name=")
        .find(|&(i, _)| i == 0 || tag.as_bytes()[i - 1].is_ascii_whitespace())?;
    let value = &tag[at + "Name=".len()..];
    let quote = value.chars().next().filter(|&q| q == '\'' || q == '"')?;
    let value = &value[1..];
    let value = &value[..value.find(quote)?];
    Some(if value.contains('&') {
        value
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&quot;", "\"")
            .replace("&apos;", "'")
            .replace("&amp;", "&")
    } else {
        value.to_string()
    })
}

/// A provider's message metadata, shared by every reader; one call at a time uses it.
type Publisher = Arc<Mutex<EvtHandle>>;
/// When each provider was opened, and its metadata (None when it couldn't be opened).
type PublisherCache = Mutex<HashMap<String, (Instant, Option<Publisher>)>>;

/// Publisher metadata by provider name, failures included: opening it is the slow part.
fn publisher(name: &str) -> Option<Publisher> {
    static CACHE: OnceLock<PublisherCache> = OnceLock::new();
    let cache = CACHE.get_or_init(Default::default);
    if let Some((t, p)) = cache.lock().get(name) {
        if p.is_some() || t.elapsed() < PUBLISHER_RETRY {
            return p.clone();
        }
    }
    let p = EvtHandle::new(unsafe { EvtOpenPublisherMetadata(0, wide(name).as_ptr(), null(), 0, 0) }).map(|h| Arc::new(Mutex::new(h)));
    let mut c = cache.lock();
    if c.len() >= MAX_PUBLISHERS {
        c.clear();
    }
    c.insert(name.to_string(), (Instant::now(), p.clone()));
    p
}

// ── queries ─────────────────────────────────────────────────────────────

/// An open query: its result set and the events fetched from it but not handed out yet.
pub struct Query {
    results: EvtHandle,
    pending: VecDeque<EvtHandle>,
    filter: Option<TextFilter>,
}

pub struct Page {
    pub events: Vec<String>,
    /// no more events
    pub done: bool,
    /// events looked at
    pub scanned: u32,
}

impl Query {
    pub fn open(channel: &str, xpath: Option<&str>, reverse: bool, text: Option<&str>) -> Result<Self, String> {
        check_channel(channel)?;
        let xpath = check_xpath(xpath)?;
        let filter = TextFilter::new(text)?;
        let direction = if reverse { EvtQueryReverseDirection } else { EvtQueryForwardDirection };
        let flags = EvtQueryChannelPath | EvtQueryTolerateQueryErrors | direction;
        let run = |flags| EvtHandle::new(unsafe { EvtQuery(0, wide(channel).as_ptr(), wide(&xpath).as_ptr(), flags) });
        let results = run(flags).ok_or_else(|| open_error(last_error(), channel))?;
        // a tolerated error (no such log, no access, a bad filter) leaves an empty result
        if let Some(status) = query_status(&results) {
            // asked again without tolerance, the query fails with the details (where a filter goes wrong)
            let code = match run(flags & !EvtQueryTolerateQueryErrors) {
                None => last_error(),
                Some(_) => status,
            };
            return Err(open_error(code, channel));
        }
        Ok(Self { results, pending: VecDeque::new(), filter })
    }

    /// The next `max` events (that contain the filter text). With a text filter, a call
    /// stops scanning after SCAN_BUDGET even with fewer matches (`done` stays false).
    pub fn next_page(&mut self, max: usize) -> Result<Page, String> {
        let started = Instant::now();
        let mut render = Renderer::default();
        let mut page = Page { events: Vec::new(), done: false, scanned: 0 };
        while page.events.len() < max {
            if self.filter.is_some() && started.elapsed() >= SCAN_BUDGET {
                break;
            }
            let Some(event) = self.pending.pop_front() else {
                match next_events(&self.results, BATCH, NEXT_TIMEOUT_MS)? {
                    Next::Events(batch) => self.pending.extend(batch),
                    Next::End => page.done = true,
                    Next::Timeout => {}
                }
                if self.pending.is_empty() {
                    break;
                }
                continue;
            };
            page.scanned += 1;
            if let Some(xml) = render.event_xml(&event) {
                if self.filter.as_ref().map_or(true, |f| f.matches(&xml)) {
                    page.events.push(xml);
                }
            }
        }
        Ok(page)
    }
}

// ── subscriptions ───────────────────────────────────────────────────────

/// A live subscription (pull model): new events wait in it until polled.
pub struct Subscription {
    // closed before the event it signals
    handle: EvtHandle,
    signal: Handle,
    filter: Option<TextFilter>,
    /// Reading ran dry: the service signals when more events arrive, and reading before
    /// that fails. (It signals only after a read has run dry, so the first poll just reads.)
    waiting: bool,
}

impl Subscription {
    pub fn open(channel: &str, xpath: Option<&str>, text: Option<&str>) -> Result<Self, String> {
        check_channel(channel)?;
        let xpath = check_xpath(xpath)?;
        let filter = TextFilter::new(text)?;
        let signal = Handle::new(unsafe { CreateEventW(null(), 1, 0, null()) })
            .ok_or_else(|| format!("Couldn't watch the {channel} log: {}", last_error_text()))?;
        let h = unsafe {
            EvtSubscribe(0, signal.0, wide(channel).as_ptr(), wide(&xpath).as_ptr(), 0, null(), None, EvtSubscribeToFutureEvents)
        };
        let handle = EvtHandle::new(h).ok_or_else(|| open_error(last_error(), channel))?;
        Ok(Self { handle, signal, filter, waiting: false })
    }

    /// Up to `max` events written since the last poll (that contain the filter text), oldest first.
    pub fn poll(&mut self, max: usize) -> Result<Vec<String>, String> {
        if self.waiting && unsafe { WaitForSingleObject(self.signal.0, 0) } != WAIT_OBJECT_0 {
            return Ok(Vec::new());
        }
        // before reading: a signal for events that arrive meanwhile must survive
        unsafe { ResetEvent(self.signal.0) };
        self.waiting = false;
        let started = Instant::now();
        let mut render = Renderer::default();
        let mut events = Vec::new();
        while events.len() < max {
            if self.filter.is_some() && started.elapsed() >= SCAN_BUDGET {
                break;
            }
            // never more than still fit: what's fetched is handed out or filtered out, not kept
            let Next::Events(batch) = next_events(&self.handle, max - events.len(), 0)? else {
                self.waiting = true;
                break;
            };
            for event in batch {
                if let Some(xml) = render.event_xml(&event) {
                    if self.filter.as_ref().map_or(true, |f| f.matches(&xml)) {
                        events.push(xml);
                    }
                }
            }
        }
        Ok(events)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_names() {
        let xml = "<Event><System><Provider Name='Service Control Manager' Guid='{x}' EventSourceName='SCM'/><EventID>1</EventID>";
        assert_eq!(provider_name(xml).as_deref(), Some("Service Control Manager"));
        let xml = "<Event><System><Provider EventSourceName='A' Name=\"B &amp; C\"/>";
        assert_eq!(provider_name(xml).as_deref(), Some("B & C"));
        assert_eq!(provider_name("<Event><System><EventID>1</EventID>"), None);
    }

    #[test]
    fn text_filter_ignores_case() {
        let f = TextFilter::new(Some("Kernel-POWER")).unwrap().unwrap();
        assert!(f.matches("<Provider Name='Microsoft-Windows-Kernel-Power'/>"));
        assert!(!f.matches("<Provider Name='Microsoft-Windows-Kernel-General'/>"));
        let f = TextFilter::new(Some("ÉTÉ")).unwrap().unwrap();
        assert!(f.matches("<Data>été</Data>"));
        assert!(TextFilter::new(Some("")).unwrap().is_none());
    }
}
