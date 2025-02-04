mod api;
mod config;
mod error;
mod middleware;
mod state;
mod websocket;

use std::{net::SocketAddr, time::Duration};

use anyhow::Result;
use axum::{
    http::{HeaderValue, Method},
    Router,
};
use error::FridgeError;
use secrecy::ExposeSecret as _;
use sentry::integrations::tower::{NewSentryLayer, SentryHttpLayer};
use state::AppState;
use tokio::net::TcpListener;
use tower::ServiceBuilder;
use tower_http::{
    cors::{AllowOrigin, Any, CorsLayer},
    limit::RequestBodyLimitLayer,
    timeout::TimeoutLayer,
    trace::{DefaultMakeSpan, DefaultOnResponse, TraceLayer},
    ServiceBuilderExt as _,
};
use tracing::Level;
use tracing_subscriber::{layer::SubscriberExt as _, util::SubscriberInitExt as _};

use crate::{
    config::Config,
    middleware::{MakeRequestUuidV7, SentryReportRequestInfoLayer},
};

fn main() -> Result<()> {
    rubenvy::rubenvy_auto()?;

    let config = Config::from_environment();

    tracing_subscriber::fmt()
        .with_target(true)
        .with_max_level(config.log_level.unwrap_or(Level::DEBUG))
        .pretty()
        .finish()
        .with(sentry::integrations::tracing::layer())
        .try_init()?;

    let _sentry_guard = config.sentry_dsn.as_ref().map(|dsn| {
        tracing::info!("Initializing Sentry client");
        sentry::init((
            dsn.expose_secret(),
            sentry::ClientOptions {
                release: sentry::release_name!(),
                sample_rate: config.error_sample_rate.unwrap_or(1.0),
                traces_sample_rate: config.trace_sample_rate.unwrap_or(0.1),
                attach_stacktrace: true,
                ..Default::default()
            },
        ))
    });

    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?
        .block_on(run(config))
}

async fn run(config: Config) -> Result<()> {
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(5)
        .connect(config.postgres_url.expose_secret())
        .await?;

    // TEMPORARY LOL
    sqlx::query("DROP TABLE IF EXISTS magnets")
        .execute(&pool)
        .await?;
    sqlx::query("DROP TABLE IF EXISTS _sqlx_migrations")
        .execute(&pool)
        .await?;
    sqlx::migrate!("./migrations").run(&pool).await?;

    let timeout = config
        .request_timeout_seconds
        .unwrap_or(Duration::from_secs(2));

    let service_builder = ServiceBuilder::new()
        .set_x_request_id(MakeRequestUuidV7)
        .layer(NewSentryLayer::new_from_top())
        .layer(SentryHttpLayer::with_transaction())
        .layer(SentryReportRequestInfoLayer)
        .layer(
            TraceLayer::new_for_http()
                .make_span_with(DefaultMakeSpan::new().include_headers(true))
                .on_response(DefaultOnResponse::new().include_headers(true)),
        )
        .propagate_x_request_id()
        .layer(RequestBodyLimitLayer::new(1024))
        .layer(TimeoutLayer::new(timeout))
        .layer(
            CorsLayer::new()
                .allow_methods([Method::GET, Method::PUT, Method::OPTIONS])
                .allow_origin(
                    config
                        .cors_origin
                        .and_then(|s| HeaderValue::from_str(s.as_str()).ok())
                        .map(AllowOrigin::from)
                        .unwrap_or(Any.into()),
                )
                .allow_headers(Any),
        );

    let app_state = AppState { postgres: pool };

    let app = Router::new()
        .merge(api::routes())
        .nest("/ws", websocket::routes())
        .fallback(|| async { FridgeError::NotFound })
        .layer(service_builder)
        .with_state(app_state);

    let listener = TcpListener::bind("0.0.0.0:8080").await?;
    tracing::info!("Listening on {}", listener.local_addr()?);
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await?;

    Ok(())
}
