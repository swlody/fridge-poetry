use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
};
use thiserror::Error;

#[derive(Error, Debug)]
pub enum FridgeError {
    #[error(transparent)]
    Sqlx(#[from] sqlx::Error),

    #[error(transparent)]
    Other(#[from] anyhow::Error),

    #[error("Not found")]
    NotFound,
}

impl IntoResponse for FridgeError {
    fn into_response(self) -> Response {
        match self {
            Self::NotFound => StatusCode::NOT_FOUND.into_response(),

            Self::Sqlx(e) => {
                tracing::error!("{e:?}");
                StatusCode::INTERNAL_SERVER_ERROR.into_response()
            }

            Self::Other(e) => {
                tracing::error!("{e:?}");
                StatusCode::INTERNAL_SERVER_ERROR.into_response()
            }
        }
    }
}
