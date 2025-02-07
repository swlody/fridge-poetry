use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct MagnetUpdate {
    pub id: i32,
    pub old_x: i32,
    pub old_y: i32,
    pub new_x: i32,
    pub new_y: i32,
    pub rotation: f32,
    pub z_index: i64,
}

#[derive(Clone, Debug)]
pub struct AppState {
    pub postgres: sqlx::PgPool,
    pub magnet_updates: tokio::sync::broadcast::Sender<MagnetUpdate>,
}
