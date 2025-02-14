use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PgMagnetUpdate {
    pub id: i32,
    pub old_x: i32,
    pub old_y: i32,
    pub new_x: i32,
    pub new_y: i32,
    pub rotation: i32,
    pub z_index: i64,
    pub word: String,
    pub session_id: Uuid,
}

#[derive(Clone, Debug)]
pub struct AppState {
    pub postgres: sqlx::PgPool,
    pub magnet_updates: tokio::sync::broadcast::Sender<PgMagnetUpdate>,
    pub token: tokio_util::sync::CancellationToken,
}
