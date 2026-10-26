//! Unified API error envelope.
//!
//! Every error returned by the engine has the same shape, so clients can
//! branch on `error.type` without string-matching messages:
//!
//! ```json
//! {
//!   "error": {
//!     "type": "invalid_signature",
//!     "message": "signature does not match request",
//!     "code": 401
//!   }
//! }
//! ```

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;

/// Convenience alias used across the engine.
pub type ApiResult<T> = Result<T, AppError>;

/// A structured API error.
#[derive(Debug, thiserror::Error)]
#[error("{message}")]
pub struct AppError {
    /// Stable machine-readable type (`invalid_signature`, `not_found`, …).
    pub err_type: String,
    /// Human-readable explanation, safe to display.
    pub message: String,
    /// HTTP status code.
    pub status: StatusCode,
}

impl AppError {
    pub fn new(status: StatusCode, err_type: &str, message: impl Into<String>) -> Self {
        Self { status, err_type: err_type.to_string(), message: message.into() }
    }

    pub fn bad_request(msg: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, "bad_request", msg)
    }
    pub fn unauthorized(msg: impl Into<String>) -> Self {
        Self::new(StatusCode::UNAUTHORIZED, "invalid_signature", msg)
    }
    pub fn missing_auth() -> Self {
        Self::new(
            StatusCode::UNAUTHORIZED,
            "missing_credentials",
            "include X-PayPhone-Key / Timestamp / Signature headers",
        )
    }
    pub fn forbidden(msg: impl Into<String>) -> Self {
        Self::new(StatusCode::FORBIDDEN, "forbidden", msg)
    }
    pub fn not_found(msg: impl Into<String>) -> Self {
        Self::new(StatusCode::NOT_FOUND, "not_found", msg)
    }
    pub fn rate_limited() -> Self {
        Self::new(StatusCode::TOO_MANY_REQUESTS, "rate_limited", "too many requests, slow down")
    }
    pub fn upstream(msg: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_GATEWAY, "upstream_unavailable", msg)
    }
    pub fn internal(msg: impl Into<String>) -> Self {
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, "internal_error", msg)
    }
    pub fn unavailable(msg: impl Into<String>) -> Self {
        Self::new(StatusCode::SERVICE_UNAVAILABLE, "unavailable", msg)
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let body = json!({
            "error": {
                "type": self.err_type,
                "message": self.message,
                "code": self.status.as_u16(),
            }
        });
        (self.status, Json(body)).into_response()
    }
}
