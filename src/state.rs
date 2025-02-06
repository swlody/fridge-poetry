use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct MagnetUpdate {
    pub id: i32,
    pub x: i32,
    pub y: i32,
    pub rotation: f32,
}

#[derive(Clone, Debug)]
pub struct AppState {
    pub postgres: sqlx::PgPool,
    pub magnet_updates: tokio::sync::broadcast::Sender<MagnetUpdate>,
}
