FROM lukemathwalker/cargo-chef:latest-rust-1 AS chef
WORKDIR /app

FROM chef AS planner
COPY . .
RUN cargo chef prepare --recipe-path recipe.json

FROM chef AS builder
COPY --from=planner /app/recipe.json recipe.json
# Build dependencies - this is the caching Docker layer!
RUN cargo chef cook --release --recipe-path recipe.json
# Build application
COPY . .
RUN cargo build --release --bin fridge-poetry

# Create debug info
RUN objcopy --only-keep-debug --compress-debug-sections=zlib /app/target/release/fridge-poetry /app/target/release/fridge-poetry.debug
RUN objcopy --strip-debug --strip-unneeded /app/target/release/fridge-poetry
RUN objcopy --add-gnu-debuglink=/app/target/release/fridge-poetry.debug /app/target/release/fridge-poetry

RUN curl -sL https://sentry.io/get-cli | bash

RUN mv /app/target/release/fridge-poetry.debug /app
RUN --mount=type=secret,id=sentry_auth_token \
    sentry-cli debug-files upload --include-sources --org sam-wlody --project fridge-poetry --auth-token $(cat /run/secrets/sentry_auth_token) /app/fridge-poetry.debug
RUN rm /app/fridge-poetry.debug

# We do not need the Rust toolchain to run the binary!
FROM debian:bookworm-slim AS runtime
WORKDIR /app
COPY --from=builder /app/target/release/fridge-poetry /usr/local/bin

COPY migrations /app/migrations

ENTRYPOINT ["/usr/local/bin/fridge-poetry"]
