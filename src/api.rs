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

use crate::{error::FridgeError, state::AppState};

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Magnet {
    id: i32,
    x: i32,
    y: i32,
    rotation: i32,
    word: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Window {
    min_x: i32,
    min_y: i32,
    max_x: i32,
    max_y: i32,
}

#[tracing::instrument]
async fn magnets(
    State(state): State<AppState>,
    Query(window): Query<Window>,
) -> Result<impl IntoResponse, FridgeError> {
    let magnets = sqlx::query_as!(
        Magnet,
        r#"SELECT id, x, y, rotation, word
        FROM magnets
        WHERE x >= $1 AND x <= $2 AND y >= $3 AND y <= $4"#,
        window.min_x,
        window.max_x,
        window.min_y,
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
        "UPDATE magnets SET x = $1, y = $2, rotation = $3, last_modifier = $4 WHERE id = $5",
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

async fn health_check(State(_state): State<AppState>) -> Result<impl IntoResponse, FridgeError> {
    Ok(StatusCode::OK)
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/magnets", get(magnets))
        .route("/magnet", put(update_magnet))
        .route("/health", get(health_check))
}
