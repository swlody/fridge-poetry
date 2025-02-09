use axum::{extract::State, http::StatusCode, response::IntoResponse, routing::get, Router};

use crate::state::AppState;

#[tracing::instrument]
async fn health_check(State(state): State<AppState>) -> impl IntoResponse {
    if state.postgres.is_closed() {
        StatusCode::INTERNAL_SERVER_ERROR
    } else {
        StatusCode::OK
    }
}

pub fn routes() -> Router<AppState> {
    Router::new().route("/health", get(health_check))
}
