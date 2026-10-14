-- Up Migration
-- Which buses a driver may take out. POST /trips/start checks this, so a driver cannot report for someone else's bus.
CREATE TABLE driver_buses (
  driver_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bus_id    text   NOT NULL REFERENCES buses(id) ON DELETE CASCADE,
  PRIMARY KEY (driver_id, bus_id)
);

-- Refresh tokens are stored hashed (SHA-256), so a database leak does not leak sessions.
-- Each use revokes the token and issues a new one; presenting a revoked one revokes the whole user's sessions.
CREATE TABLE refresh_tokens (
  id         bigserial PRIMARY KEY,
  user_id    bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text   NOT NULL UNIQUE,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX refresh_tokens_active_idx ON refresh_tokens (user_id) WHERE revoked_at IS NULL;

-- Emails are compared case-insensitively
CREATE UNIQUE INDEX users_email_lower_idx ON users (lower(email));

-- Down Migration
DROP INDEX users_email_lower_idx;
DROP TABLE refresh_tokens, driver_buses;
