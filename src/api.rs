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
    x: Option<i32>,
    y: Option<i32>,
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
    let magnets: Vec<Magnet> = sqlx::query_as!(
        Magnet,
        r#"SELECT id, ST_X(geom)::INTEGER AS x, ST_Y(geom)::INTEGER AS y, rotation, word
        FROM magnets
        WHERE geom && ST_MakeEnvelope($1::INTEGER, $2::INTEGER, $3::INTEGER, $4::INTEGER, 0)"#,
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

    let x = magnet.x.context("Missing X")?;
    let y = magnet.y.context("Missing Y")?;

    sqlx::query!(
        "UPDATE magnets SET geom = ST_MakePoint($1::INTEGER, $2::INTEGER), rotation = $3, \
         last_modifier = $4 WHERE id = $5",
        x,
        y,
        magnet.rotation,
        request_id,
        magnet.id
    )
    .execute(&state.postgres)
    .await?;

    Ok(StatusCode::OK)
}

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
