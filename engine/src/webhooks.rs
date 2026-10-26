//! Signed webhooks.
//!
//! When an invoice is observed `paid` / `underpaid` / `expired`, the engine
//! emits an event to the merchant's webhook endpoint:
//!
//! ```text
//! POST {merchant_url}
//! X-PayPhone-Event: invoice.paid
//! X-PayPhone-Timestamp: 1730000000
//! X-PayPhone-Signature: hex(HMAC-SHA256(webhook_secret, "{ts}.{raw_body}"))
//! ```
//!
//! The merchant verifies with 3 lines of code (see SDKs). Delivery runs in a
//! detached task with 3 retries (1s/3s backoff). v1 delivery is poll-driven:
//! state transitions are detected when the merchant (or checkout page) polls
//! invoice status — documented honestly; the production deployment wires the
//! same emit path into a background watcher loop.

use crate::config::Config;
use crate::keys;
use serde_json::json;
use std::time::Duration;

/// Build the canonical event payload for an invoice transition.
pub fn build_event(event: &str, invoice_id: &str, extra: serde_json::Value) -> serde_json::Value {
    let mut data = serde_json::Map::new();
    data.insert("invoice_id".into(), json!(invoice_id));
    if let serde_json::Value::Object(map) = extra {
        for (k, v) in map {
            data.insert(k, v);
        }
    }
    json!({
        "id": format!("evt_{}", hex::encode(rand_bytes(8))),
        "type": event,
        "api_version": "v1",
        "created_at": now_secs(),
        "data": data,
    })
}

/// Deliver an event with retries. Returns (attempt, status_code, error?).
pub async fn deliver(
    url: &str,
    webhook_secret: &str,
    event: &str,
    payload: &serde_json::Value,
) -> Result<(u32, u16), String> {
    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| e.to_string())?;
    let body = serde_json::to_string(payload).map_err(|e| e.to_string())?;

    for attempt in 1..=3 {
        let ts = now_secs();
        let sig = keys::compute_event_signature(webhook_secret, ts, &body);
        let resp = http
            .post(url)
            .header("Content-Type", "application/json")
            .header("X-PayPhone-Event", event)
            .header("X-PayPhone-Timestamp", ts.to_string())
            .header("X-PayPhone-Signature", sig)
            .body(body.clone())
            .send()
            .await;
        match resp {
            Ok(r) => {
                let status = r.status().as_u16();
                if r.status().is_success() {
                    return Ok((attempt, status));
                }
                tracing::warn!(attempt, status, "webhook non-2xx");
            }
            Err(e) => tracing::warn!(attempt, error = %e, "webhook delivery failed"),
        }
        tokio::time::sleep(Duration::from_secs(attempt as u64 * 2)).await;
    }
    Err("delivery failed after 3 attempts".into())
}

/// Emit-and-log helper used by status endpoints (v1 poll-driven emission).
pub fn spawn_emit(config: &Config, url: Option<&str>, event: &str, invoice_id: &str, extra: serde_json::Value) {
    let Some(url) = url.filter(|u| !u.is_empty()).map(str::to_string) else { return };
    let config = config.clone();
    let event = event.to_string();
    let invoice_id = invoice_id.to_string();
    let payload = build_event(&event, &invoice_id, extra);
    tokio::spawn(async move {
        match deliver(&url, &config.signing_key, &event, &payload).await {
            Ok((attempts, status)) => {
                tracing::info!(event, invoice_id, attempts, status, "webhook delivered")
            }
            Err(e) => tracing::error!(event, invoice_id, error = %e, "webhook failed"),
        }
    });
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
}

fn rand_bytes(n: usize) -> Vec<u8> {
    use rand::RngCore;
    let mut buf = vec![0u8; n];
    rand::thread_rng().fill_bytes(&mut buf);
    buf
}
