#[derive(Clone, Debug)]
pub struct AppState {
    pub postgres: sqlx::PgPool,
}
