//! In-process token-bucket rate limiter.
//!
//! Stateless-friendly: buckets live in instance memory keyed by API key (or
//! IP for public routes). Horizontal deployments scale limits linearly with
//! instances; per-key global limits belong at the edge (Cloudflare / nginx)
//! or in the future, in the FeeVault metering contract.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Instant;

struct Bucket {
    tokens: f64,
    last: Instant,
}

/// Token bucket pool. Capacity = burst, refill = rate/60 per second.
pub struct RateLimiter {
    buckets: Mutex<HashMap<String, Bucket>>,
    rate_per_min: u32,
    burst: u32,
}

impl RateLimiter {
    pub fn new(rate_per_min: u32) -> Self {
        let burst = (rate_per_min / 2).max(10);
        Self { buckets: Mutex::new(HashMap::new()), rate_per_min, burst }
    }

    /// Consume 1 token for `key`. Returns false when the caller is over limit.
    pub fn check(&self, key: &str) -> bool {
        let rate_per_sec = self.rate_per_min as f64 / 60.0;
        let mut buckets = self.buckets.lock().unwrap();
        let now = Instant::now();
        let bucket = buckets.entry(key.to_string()).or_insert(Bucket {
            tokens: self.burst as f64,
            last: now,
        });
        let elapsed = now.duration_since(bucket.last).as_secs_f64();
        bucket.tokens = (bucket.tokens + elapsed * rate_per_sec).min(self.burst as f64);
        bucket.last = now;
        if bucket.tokens >= 1.0 {
            bucket.tokens -= 1.0;
            true
        } else {
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn burst_then_reject() {
        let rl = RateLimiter::new(60); // burst 30
        for _ in 0..30 {
            assert!(rl.check("k"));
        }
        assert!(!rl.check("k"));
        assert!(rl.check("other"), "independent buckets");
    }
}
