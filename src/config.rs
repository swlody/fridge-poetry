use std::{str::FromStr as _, time::Duration};

use axum::http::HeaderValue;
use secrecy::SecretString;
use tower_http::cors::{AllowOrigin, Any};
use tracing::Level;

#[derive(Debug)]
pub struct Config {
    pub log_level: tracing::metadata::Level,
    pub trace_sample_rate: f32,
    pub error_sample_rate: f32,
    pub request_timeout: Duration,

    pub sentry_dsn: Option<SecretString>,
    pub postgres_url: SecretString,
    pub cors_origin: tower_http::cors::AllowOrigin,

    pub ws_heartbeat_interval: Duration,
}

impl Config {
    pub fn from_environment() -> Self {
        Self {
            log_level: std::env::var("FRIDGE_LOG_LEVEL")
                .ok()
                .map(|level| {
                    Level::from_str(level.as_str())
                        .unwrap_or_else(|_| panic!("Invalid value for FRIDGE_LOG_LEVEL: {level}"))
                })
                .unwrap_or(Level::DEBUG),

            trace_sample_rate: std::env::var("FRIDGE_SENTRY_TRACING_SAMPLE_RATE")
                .ok()
                .map(|rate| {
                    let rate = rate.parse().unwrap_or_else(|_| {
                        panic!("Invalid value for FRIDGE_SENTRY_TRACING_SAMPLE_RATE: {rate}")
                    });
                    assert!((0.0..=1.0).contains(&rate));
                    rate
                })
                .unwrap_or(0.1),

            error_sample_rate: std::env::var("FRIDGE_SENTRY_ERROR_SAMPLE_RATE")
                .ok()
                .map(|rate| {
                    let rate = rate.parse().unwrap_or_else(|_| {
                        panic!("Invalid value for FRIDGE_SENTRY_TRACING_SAMPLE_RATE: {rate}")
                    });
                    assert!((0.0..=1.0).contains(&rate));
                    rate
                })
                .unwrap_or(1.0),

            request_timeout: std::env::var("FRIDGE_REQUEST_TIMEOUT_SECONDS")
                .ok()
                .map(|timeout| {
                    timeout
                        .parse()
                        .unwrap_or_else(|_| panic!("Invalid request timeout: {timeout}"))
                })
                .map(Duration::from_secs)
                .unwrap_or(Duration::from_secs(2)),

            sentry_dsn: std::env::var("FRIDGE_SENTRY_DSN")
                .ok()
                .map(SecretString::from),

            postgres_url: SecretString::from(
                std::env::var("DATABASE_URL").expect("Missing required DATABASE_URL"),
            ),

            cors_origin: std::env::var("FRIDGE_CORS_ORIGIN")
                .ok()
                .and_then(|s| HeaderValue::from_str(s.as_str()).ok())
                .map(AllowOrigin::from)
                .unwrap_or(Any.into()),

            ws_heartbeat_interval: std::env::var("FRIDGE_WS_HEARTBEAT_INTERVAL_SECONDS")
                .ok()
                .map(|i| {
                    i.parse().unwrap_or_else(|i| {
                        panic!("Invalid value for FRIDGE_WS_HEARTBEAT_INTERVAL_SECONDS: {i}")
                    })
                })
                .map(Duration::from_secs)
                .unwrap_or(Duration::from_secs(5)),
        }
    }
}
