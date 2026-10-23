use std::collections::HashMap;

use crate::error::{Errno, Result, SysError};
use crate::storage::Storage;

/// In-memory `Storage`, with an optional capacity to exercise `ENOSPC`.
#[derive(Debug, Clone, Default)]
pub struct MemStorage {
    blobs: HashMap<String, Vec<u8>>,
    capacity: Option<u64>,
}

impl MemStorage {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_capacity(bytes: u64) -> Self {
        MemStorage { blobs: HashMap::new(), capacity: Some(bytes) }
    }

    pub fn set_capacity(&mut self, bytes: Option<u64>) {
        self.capacity = bytes;
    }

    pub fn keys(&self) -> Vec<String> {
        let mut k: Vec<String> = self.blobs.keys().cloned().collect();
        k.sort();
        k
    }

    fn check_room(&self, growth: u64) -> Result<()> {
        if let Some(cap) = self.capacity {
            if self.used() + growth > cap {
                return Err(SysError::new(Errno::ENOSPC));
            }
        }
        Ok(())
    }
}

impl Storage for MemStorage {
    fn len(&self, key: &str) -> Result<Option<u64>> {
        Ok(self.blobs.get(key).map(|b| b.len() as u64))
    }

    fn read_at(&self, key: &str, offset: u64, buf: &mut [u8]) -> Result<usize> {
        let Some(blob) = self.blobs.get(key) else { return Ok(0) };
        let offset = offset as usize;
        if offset >= blob.len() {
            return Ok(0);
        }
        let n = buf.len().min(blob.len() - offset);
        buf[..n].copy_from_slice(&blob[offset..offset + n]);
        Ok(n)
    }

    fn write_at(&mut self, key: &str, offset: u64, data: &[u8]) -> Result<()> {
        let cur = self.blobs.get(key).map_or(0, |b| b.len() as u64);
        let end = offset + data.len() as u64;
        self.check_room(end.saturating_sub(cur))?;
        let blob = self.blobs.entry(key.to_string()).or_default();
        if blob.len() < end as usize {
            blob.resize(end as usize, 0);
        }
        blob[offset as usize..end as usize].copy_from_slice(data);
        Ok(())
    }

    fn truncate(&mut self, key: &str, size: u64) -> Result<()> {
        let cur = self.blobs.get(key).map_or(0, |b| b.len() as u64);
        self.check_room(size.saturating_sub(cur))?;
        self.blobs.entry(key.to_string()).or_default().resize(size as usize, 0);
        Ok(())
    }

    fn delete(&mut self, key: &str) -> Result<()> {
        self.blobs.remove(key);
        Ok(())
    }

    fn list_keys(&self) -> Result<Vec<String>> {
        Ok(self.keys())
    }

    fn flush(&mut self) -> Result<()> {
        Ok(())
    }

    fn used(&self) -> u64 {
        self.blobs.values().map(|b| b.len() as u64).sum()
    }

    fn quota(&self) -> Option<u64> {
        self.capacity
    }
}
