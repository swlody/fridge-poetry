use std::{str::FromStr as _, time::Duration};

use secrecy::SecretString;
use tracing::Level;

pub struct Config {
    pub log_level: Option<tracing::metadata::Level>,
    pub trace_sample_rate: Option<f32>,
    pub error_sample_rate: Option<f32>,
    pub request_timeout_seconds: Option<Duration>,

    pub sentry_dsn: Option<SecretString>,
    pub postgres_url: SecretString,
    pub cors_origin: Option<String>,
}

impl Config {
    pub fn from_environment() -> Self {
        Self {
            log_level: std::env::var("FRIDGE_LOG_LEVEL").ok().map(|level| {
                Level::from_str(level.as_str())
                    .unwrap_or_else(|_| panic!("Invalid value for FRIDGE_LOG_LEVEL: {level}"))
            }),

            trace_sample_rate: std::env::var("FRIDGE_SENTRY_TRACING_SAMPLE_RATE").ok().map(
                |rate| {
                    let rate = rate.parse().unwrap_or_else(|_| {
                        panic!("Invalid value for FRIDGE_SENTRY_TRACING_SAMPLE_RATE: {rate}")
                    });
                    assert!((0.0..=1.0).contains(&rate));
                    rate
                },
            ),

            error_sample_rate: std::env::var("FRIDGE_SENTRY_ERROR_SAMPLE_RATE")
                .ok()
                .map(|rate| {
                    let rate = rate.parse().unwrap_or_else(|_| {
                        panic!("Invalid value for FRIDGE_SENTRY_TRACING_SAMPLE_RATE: {rate}")
                    });
                    assert!((0.0..=1.0).contains(&rate));
                    rate
                }),

            request_timeout_seconds: std::env::var("FRIDGE_REQUEST_TIMEOUT_SECONDS")
                .ok()
                .map(|timeout| {
                    timeout
                        .parse()
                        .unwrap_or_else(|_| panic!("Invalid request timeout: {timeout}"))
                })
                .map(Duration::from_secs),

            sentry_dsn: std::env::var("FRIDGE_SENTRY_DSN")
                .ok()
                .map(SecretString::from),

            postgres_url: SecretString::from(
                std::env::var("DATABASE_URL").expect("Missing required DATABASE_URL"),
            ),

            cors_origin: std::env::var("FRIDGE_CORS_ORIGIN").ok(),
        }
    }
}
