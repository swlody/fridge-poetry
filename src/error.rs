use thiserror::Error;

#[derive(Error, Debug)]
pub enum FridgeError {
    #[error(transparent)]
    Sqlx(#[from] sqlx::Error),

    #[error(transparent)]
    Axum(#[from] axum::Error),
}
