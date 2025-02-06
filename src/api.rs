use anyhow::Context as _;
use axum::{
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::{get, put},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{error::FridgeError, geometry::Window, state::AppState};

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Magnet {
    id: i32,
    x: i32,
    y: i32,
    rotation: i32,
    word: Option<String>,
}

#[tracing::instrument]
async fn magnets(
    State(state): State<AppState>,
    Query(window): Query<Window>,
) -> Result<impl IntoResponse, FridgeError> {
    let magnets: Vec<Magnet> = sqlx::query_as!(
        Magnet,
        r#"SELECT id, ST_X(coords)::INTEGER AS "x!", ST_Y(coords)::INTEGER AS "y!", rotation, word
           FROM magnets
           WHERE coords && ST_MakeEnvelope($1::INTEGER, $2::INTEGER, $3::INTEGER, $4::INTEGER)"#,
        window.min_x,
        window.min_y,
        window.max_x,
        window.max_y
    )
    .fetch_all(&state.postgres)
    .await?;

    Ok(Json(magnets))
}

#[tracing::instrument]
async fn update_magnet(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(magnet): Json<Magnet>,
) -> Result<impl IntoResponse, FridgeError> {
    let request_id: Uuid = headers
        .get("x-request-id")
        .and_then(|h| h.to_str().ok())
        .and_then(|s| s.parse().ok())
        .context("Invalid x-request-id header")?;

    sqlx::query!(
        r#"UPDATE magnets
           SET coords = ST_MakePoint($1::INTEGER, $2::INTEGER), rotation = $3, last_modifier = $4
           WHERE id = $5"#,
        magnet.x,
        magnet.y,
        magnet.rotation,
        request_id,
        magnet.id
    )
    .execute(&state.postgres)
    .await?;

    Ok(StatusCode::OK)
}

#[tracing::instrument]
async fn health_check(State(state): State<AppState>) -> impl IntoResponse {
    if state.postgres.is_closed() {
        StatusCode::INTERNAL_SERVER_ERROR
    } else {
        StatusCode::OK
    }
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/magnets", get(magnets))
        .route("/magnet", put(update_magnet))
        .route("/health", get(health_check))
}
