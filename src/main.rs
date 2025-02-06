mod api;
mod config;
mod error;
mod middleware;
mod state;
mod websocket;

use std::{net::SocketAddr, sync::Arc};

use anyhow::Result;
use axum::{http::Method, Router};
use error::FridgeError;
use secrecy::ExposeSecret as _;
use sentry::integrations::tower::{NewSentryLayer, SentryHttpLayer};
use sqlx::postgres::PgListener;
use tokio::{net::TcpListener, select};
use tokio_util::sync::CancellationToken;
use tower::ServiceBuilder;
use tower_http::{
    cors::{Any, CorsLayer},
    limit::RequestBodyLimitLayer,
    timeout::TimeoutLayer,
    trace::{DefaultMakeSpan, DefaultOnResponse, TraceLayer},
    ServiceBuilderExt as _,
};
use tracing_subscriber::{layer::SubscriberExt as _, util::SubscriberInitExt as _};

use crate::{
    config::Config,
    middleware::{MakeRequestUuidV7, SentryReportRequestInfoLayer},
    state::AppState,
};

fn main() -> Result<()> {
    rubenvy::rubenvy_auto()?;

    let config = Config::from_environment();

    tracing_subscriber::fmt()
        .with_target(true)
        .with_max_level(config.log_level)
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
                sample_rate: config.error_sample_rate,
                traces_sample_rate: config.trace_sample_rate,
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

    let token = CancellationToken::new();
    let mut listener = PgListener::connect_with(&pool)
        .await
        .expect("Unable to initialize PgListener");
    listener
        .listen("magnet_updates")
        .await
        .expect("Unable to listen to magnet_updates");
    // TODO configurably channel size
    let (tx, _rx) = tokio::sync::broadcast::channel(10);

    let pubsub_task = {
        let tx = tx.clone();
        let token = token.clone();

        tokio::task::spawn(async move {
            loop {
                select! {
                    _ = token.cancelled() => break,
                    res = listener.recv() => {
                        match res {
                            Ok(msg) => {
                                tx.send(msg.payload().to_string()).unwrap();
                            }
                            Err(e) => {
                                tracing::error!("Error from listener: {}", e);
                            }
                        }
                    }
                }
            }
        })
    };

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
        .layer(TimeoutLayer::new(config.request_timeout))
        .layer(
            CorsLayer::new()
                .allow_methods([Method::GET, Method::PUT, Method::OPTIONS])
                .allow_origin(config.cors_origin.clone())
                .allow_headers(Any),
        );

    let app_state = AppState {
        postgres: pool,
        magnet_updates: tx,
        config: Arc::new(config),
    };

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

    token.cancel();
    pubsub_task.await.unwrap();

    Ok(())
}
