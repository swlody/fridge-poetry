CREATE TABLE IF NOT EXISTS magnets (
    id SERIAL PRIMARY KEY,
    coords POINT NOT NULL,
    rotation INTEGER NOT NULL,
    z_index BIGSERIAL NOT NULL,
    word TEXT NOT NULL,
    last_modifier UUID
);