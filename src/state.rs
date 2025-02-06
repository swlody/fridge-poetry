#[derive(Clone, Debug)]
pub struct AppState {
    pub postgres: sqlx::PgPool,
    pub magnet_updates: tokio::sync::broadcast::Sender<String>,
}
