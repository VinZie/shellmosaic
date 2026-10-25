//! Open queries and subscriptions per plugin pane: owner checks, caps and the idle sweep.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde::Serialize;

use super::wevt::{Query, Subscription};

/// Queries and subscriptions unused this long are closed.
const IDLE: Duration = Duration::from_secs(10 * 60);
/// Per owner; opening one more closes the least recently used.
const MAX_QUERIES: usize = 32;
const MAX_SUBSCRIPTIONS: usize = 16;
const DEFAULT_MAX: u32 = 200;
const MAX_EVENTS: u32 = 1000;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventPage {
    /// for eventlog_more; None once the query is finished (or closed meanwhile)
    cursor: Option<u32>,
    events: Vec<String>,
    done: bool,
    scanned: u32,
}

/// Query cursors and subscriptions by id (one sequence for both), each tagged with its owner.
#[derive(Default)]
pub struct EventLogs {
    inner: Mutex<Tables>,
}

#[derive(Default)]
struct Tables {
    last_id: u32,
    queries: Table<Query>,
    subscriptions: Table<Subscription>,
}

/// What was removed under the lock, closed once it's released (EvtClose talks to the
/// event log service).
#[derive(Default)]
struct Trash {
    queries: Vec<Query>,
    subscriptions: Vec<Subscription>,
}

struct Slot<T> {
    owner: String,
    used: Instant,
    /// None while a call works with it, outside the lock
    item: Option<T>,
}

struct Table<T> {
    slots: HashMap<u32, Slot<T>>,
}

impl<T> Default for Table<T> {
    fn default() -> Self {
        Self { slots: HashMap::new() }
    }
}

enum Missing {
    Unknown,
    Busy,
}

impl<T> Table<T> {
    fn sweep(&mut self, trash: &mut Vec<T>) {
        self.slots.retain(|_, s| {
            let keep = s.used.elapsed() < IDLE;
            if !keep {
                trash.extend(s.item.take());
            }
            keep
        });
    }

    fn add(&mut self, id: u32, owner: &str, item: T, cap: usize, trash: &mut Vec<T>) {
        loop {
            let mine = self.slots.iter().filter(|(_, s)| s.owner == owner);
            if mine.clone().count() < cap {
                break;
            }
            let Some(oldest) = mine.min_by_key(|(_, s)| s.used).map(|(&id, _)| id) else { break };
            if let Some(s) = self.slots.remove(&oldest) {
                trash.extend(s.item);
            }
        }
        self.slots.insert(id, Slot { owner: owner.to_string(), used: Instant::now(), item: Some(item) });
    }

    /// Borrow an item out of the table; `put_back` returns it.
    fn take(&mut self, owner: &str, id: u32) -> Result<T, Missing> {
        let slot = self.slots.get_mut(&id).filter(|s| s.owner == owner).ok_or(Missing::Unknown)?;
        slot.used = Instant::now();
        slot.item.take().ok_or(Missing::Busy)
    }

    /// Back into its slot, unless it was closed (or its pane released) meanwhile.
    fn put_back(&mut self, id: u32, item: T, trash: &mut Vec<T>) -> bool {
        match self.slots.get_mut(&id).filter(|s| s.item.is_none()) {
            Some(slot) => {
                slot.item = Some(item);
                slot.used = Instant::now();
                true
            }
            None => {
                trash.push(item);
                false
            }
        }
    }

    fn remove(&mut self, owner: &str, id: u32, trash: &mut Vec<T>) -> bool {
        if self.slots.get(&id).map_or(true, |s| s.owner != owner) {
            return false;
        }
        trash.extend(self.slots.remove(&id).and_then(|s| s.item));
        true
    }

    fn release(&mut self, owner: &str, trash: &mut Vec<T>) {
        self.slots.retain(|_, s| {
            if s.owner == owner {
                trash.extend(s.item.take());
            }
            s.owner != owner
        });
    }
}

fn page_size(max: Option<u32>) -> usize {
    max.unwrap_or(DEFAULT_MAX).clamp(1, MAX_EVENTS) as usize
}

impl EventLogs {
    /// Run `f` under the lock, after the idle sweep; what it removed is closed after unlocking.
    fn with<R>(&self, f: impl FnOnce(&mut Tables, &mut Trash) -> R) -> R {
        let mut trash = Trash::default();
        let r = {
            let mut t = self.inner.lock();
            t.queries.sweep(&mut trash.queries);
            t.subscriptions.sweep(&mut trash.subscriptions);
            f(&mut t, &mut trash)
        };
        drop(trash);
        r
    }

    /// Close every cursor and subscription of a pane (closed, reloaded or moved).
    pub fn release(&self, owner: &str) {
        self.with(|t, trash| {
            t.queries.release(owner, &mut trash.queries);
            t.subscriptions.release(owner, &mut trash.subscriptions);
        });
    }

    /// Run a query and return its first page; a cursor stays open for the rest.
    pub fn query(
        &self,
        owner: &str,
        channel: &str,
        xpath: Option<&str>,
        reverse: bool,
        text: Option<&str>,
        max: Option<u32>,
    ) -> Result<EventPage, String> {
        let mut query = Query::open(channel, xpath, reverse, text)?;
        let page = query.next_page(page_size(max))?;
        let cursor = self.with(|t, trash| {
            if page.done {
                trash.queries.push(query);
                return None;
            }
            let id = t.new_id();
            t.queries.add(id, owner, query, MAX_QUERIES, &mut trash.queries);
            Some(id)
        });
        Ok(EventPage { cursor, events: page.events, done: page.done, scanned: page.scanned })
    }

    pub fn more(&self, owner: &str, cursor: u32, max: Option<u32>) -> Result<EventPage, String> {
        let mut query = self.with(|t, _| t.queries.take(owner, cursor)).map_err(|m| match m {
            Missing::Unknown => "Unknown query",
            Missing::Busy => "This query is still loading its previous page",
        })?;
        // the lock isn't held while scanning
        let result = query.next_page(page_size(max));
        let done = result.as_ref().is_ok_and(|p| p.done);
        let open = self.with(|t, trash| {
            if done {
                t.queries.remove(owner, cursor, &mut trash.queries);
                trash.queries.push(query);
                false
            } else {
                t.queries.put_back(cursor, query, &mut trash.queries)
            }
        });
        let page = result?;
        Ok(EventPage { cursor: open.then_some(cursor), events: page.events, done: page.done, scanned: page.scanned })
    }

    pub fn close(&self, owner: &str, cursor: u32) -> Result<(), String> {
        if self.with(|t, trash| t.queries.remove(owner, cursor, &mut trash.queries)) {
            Ok(())
        } else {
            Err("Unknown query".into())
        }
    }

    pub fn subscribe(&self, owner: &str, channel: &str, xpath: Option<&str>, text: Option<&str>) -> Result<u32, String> {
        let sub = Subscription::open(channel, xpath, text)?;
        Ok(self.with(|t, trash| {
            let id = t.new_id();
            t.subscriptions.add(id, owner, sub, MAX_SUBSCRIPTIONS, &mut trash.subscriptions);
            id
        }))
    }

    pub fn poll(&self, owner: &str, subscription: u32, max: Option<u32>) -> Result<Vec<String>, String> {
        let mut sub = self.with(|t, _| t.subscriptions.take(owner, subscription)).map_err(|m| match m {
            Missing::Unknown => "Unknown subscription",
            Missing::Busy => "This subscription is still being polled",
        })?;
        let result = sub.poll(page_size(max));
        self.with(|t, trash| t.subscriptions.put_back(subscription, sub, &mut trash.subscriptions));
        result
    }

    pub fn unsubscribe(&self, owner: &str, subscription: u32) -> Result<(), String> {
        if self.with(|t, trash| t.subscriptions.remove(owner, subscription, &mut trash.subscriptions)) {
            Ok(())
        } else {
            Err("Unknown subscription".into())
        }
    }
}

impl Tables {
    fn new_id(&mut self) -> u32 {
        self.last_id = self.last_id.wrapping_add(1).max(1);
        self.last_id
    }
}
