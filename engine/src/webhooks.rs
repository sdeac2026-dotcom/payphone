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
use std::net::IpAddr;
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

/// Egress guard — the engine POSTs to merchant-supplied URLs, which is a
/// classic SSRF surface (cloud metadata `169.254.169.254`, internal admin
/// panels, localhost services). The target host is resolved and refused when
/// it points at private/loopback/link-local/CGNAT space; DNS failures are
/// fail-closed. Loopback receivers stay usable on local dev nodes
/// (`production = false`). Known residual risk: DNS rebinding between this
/// check and the actual request (documented in the security audit — full
/// fix is a pinned-IP resolver).
pub async fn ensure_egress_target_allowed(raw_url: &str, production: bool) -> Result<(), String> {
    let url = reqwest::Url::parse(raw_url).map_err(|_| "webhook url is not a valid URL".to_string())?;
    match url.scheme() {
        "http" | "https" => {}
        _ => return Err("webhook url must be http(s)".to_string()),
    }
    let Some(host) = url.host_str().map(str::to_string) else {
        return Err("webhook url has no host".to_string());
    };
    let host = host.trim_start_matches('[').trim_end_matches(']');
    if let Ok(ip) = host.parse::<IpAddr>() {
        return if ip_allowed(ip, production) {
            Ok(())
        } else {
            Err(format!("webhook host {ip} is a private/reserved address"))
        };
    }
    if host.eq_ignore_ascii_case("localhost") || host.eq_ignore_ascii_case("localhost.localdomain") {
        return if production {
            Err("webhook host 'localhost' is not allowed in production".to_string())
        } else {
            Ok(())
        };
    }
    let port = url.port_or_known_default().unwrap_or(80);
    let addrs = tokio::net::lookup_host((host, port))
        .await
        .map_err(|_| format!("webhook host '{host}' does not resolve"))?;
    for a in addrs {
        if !ip_allowed(a.ip(), production) {
            return Err(format!(
                "webhook host '{host}' resolves to a private/reserved address ({})",
                a.ip()
            ));
        }
    }
    Ok(())
}

/// Allow-list test for a resolved target. Production refuses loopback too;
/// dev nodes keep `http://localhost` receivers usable.
fn ip_allowed(ip: IpAddr, production: bool) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            let loopback = o[0] == 127;
            if loopback && !production {
                return true;
            }
            let reserved = matches!(o[0], 0 | 10 | 127)
                || (o[0] == 172 && (o[1] & 0xf0) == 16)
                || (o[0] == 192 && o[1] == 168)
                || (o[0] == 169 && o[1] == 254)
                || (o[0] == 100 && (o[1] & 0xfc) == 64)
                || o[0] >= 224; // multicast + reserved
            !reserved
        }
        IpAddr::V6(v6) => {
            // IPv4-mapped addresses are judged by their IPv4 half.
            let seg = v6.segments();
            if seg[0] == 0 && seg[1] == 0 && seg[2] == 0 && seg[3] == 0 && seg[4] == 0 && seg[5] == 0xffff {
                return ip_allowed(IpAddr::V4(std::net::Ipv4Addr::new(
                    (seg[6] >> 8) as u8,
                    (seg[6] & 0xff) as u8,
                    (seg[7] >> 8) as u8,
                    (seg[7] & 0xff) as u8,
                )), production);
            }
            if v6.is_loopback() && !production {
                return true;
            }
            let reserved = v6.is_unspecified()
                || v6.is_loopback()
                || (seg[0] & 0xfe00) == 0xfc00 // ULA fc00::/7
                || (seg[0] & 0xffc0) == 0xfe80 // link-local fe80::/10
                || seg[0] == 0x2001 && seg[1] == 0xdb8; // documentation
            !reserved
        }
    }
}

/// Deliver an event with retries. Returns (attempt, status_code, error?).
/// Delivery is guarded (`ensure_egress_target_allowed`) and does NOT follow
/// redirects — a merchant endpoint that moves should be re-registered with
/// its final URL, because every hop is otherwise a second SSRF chance.
pub async fn deliver(
    config: &Config,
    url: &str,
    event: &str,
    payload: &serde_json::Value,
) -> Result<(u32, u16), String> {
    ensure_egress_target_allowed(url, config.production)
        .await
        .map_err(|e| format!("blocked: {e}"))?;
    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())?;
    let body = serde_json::to_string(payload).map_err(|e| e.to_string())?;

    for attempt in 1..=3 {
        let ts = now_secs();
        let sig = keys::compute_event_signature(&config.signing_key, ts, &body);
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
        match deliver(&config, &url, &event, &payload).await {
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

    fn v4(a: u8, b: u8, c: u8, d: u8) -> IpAddr {
        IpAddr::V4(Ipv4Addr::new(a, b, c, d))
    }

    #[test]
    fn private_and_reserved_v4_targets_refused() {
        // In production even loopback is out.
        assert!(!ip_allowed(v4(127, 0, 0, 1), true));
        assert!(!ip_allowed(v4(10, 1, 2, 3), true));
        assert!(!ip_allowed(v4(172, 16, 0, 9), true));
        assert!(!ip_allowed(v4(172, 31, 255, 1), true));
        assert!(!ip_allowed(v4(192, 168, 1, 1), true));
        assert!(!ip_allowed(v4(169, 254, 169, 254), true), "cloud metadata");
        assert!(!ip_allowed(v4(100, 64, 1, 1), true), "CGNAT");
        assert!(!ip_allowed(v4(0, 0, 0, 0), true));
        assert!(!ip_allowed(v4(224, 0, 0, 1), true), "multicast");
        // Public addresses pass.
        assert!(ip_allowed(v4(1, 1, 1, 1), true));
        assert!(ip_allowed(v4(93, 184, 216, 34), true));
    }

    #[test]
    fn loopback_allowed_only_on_dev_nodes() {
        assert!(ip_allowed(v4(127, 0, 0, 1), false), "dev nodes keep localhost receivers");
        assert!(ip_allowed(IpAddr::V6(Ipv6Addr::LOCALHOST), false));
        assert!(!ip_allowed(IpAddr::V6(Ipv6Addr::LOCALHOST), true));
    }

    #[test]
    fn v6_reserved_ranges_refused_and_mapped_v4_judged() {
        assert!(!ip_allowed(IpAddr::V6(Ipv6Addr::UNSPECIFIED), true));
        assert!(!ip_allowed(IpAddr::V6("fc00::1".parse::<Ipv6Addr>().unwrap()), true), "ULA");
        assert!(!ip_allowed(IpAddr::V6("fe80::1".parse::<Ipv6Addr>().unwrap()), true), "link-local");
        // ::ffff:169.254.169.254 — metadata behind an IPv4-mapped mask.
        let mapped = Ipv6Addr::new(0, 0, 0, 0, 0, 0xffff, 0xa9fe, 0xa9fe);
        assert!(!ip_allowed(IpAddr::V6(mapped), true));
        assert!(ip_allowed(IpAddr::V6("2606:4700::1111".parse::<Ipv6Addr>().unwrap()), true));
    }

    #[tokio::test]
    async fn guard_rejects_bad_shapes_without_network() {
        // These fail on URL/scheme/literal-IP checks — no DNS involved.
        assert!(ensure_egress_target_allowed("not a url", true).await.is_err());
        assert!(ensure_egress_target_allowed("ftp://example.com/x", true).await.is_err());
        assert!(ensure_egress_target_allowed("http://127.0.0.1:8080/hook", true)
            .await
            .is_err());
        assert!(ensure_egress_target_allowed("http://localhost/hook", true).await.is_err());
        assert!(ensure_egress_target_allowed("http://localhost/hook", false).await.is_ok());
        assert!(ensure_egress_target_allowed("http://[::1]/hook", true).await.is_err());
        assert!(ensure_egress_target_allowed("http://169.254.169.254/latest/meta-data", true)
            .await
            .is_err());
    }
}

fn rand_bytes(n: usize) -> Vec<u8> {
    use rand::RngCore;
    let mut buf = vec![0u8; n];
    rand::thread_rng().fill_bytes(&mut buf);
    buf
}
