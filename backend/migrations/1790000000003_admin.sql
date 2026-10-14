-- Up Migration
-- Who changed what. user_name is kept so the entry still reads well after an account is deleted.
CREATE TABLE audit_log (
  id         bigserial PRIMARY KEY,
  user_id    bigint REFERENCES users(id) ON DELETE SET NULL,
  user_name  text,
  action     text NOT NULL,
  target     text,
  detail     jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_created_idx ON audit_log (created_at DESC);
CREATE INDEX trips_started_idx ON trips (started_at DESC);

-- Down Migration
DROP INDEX trips_started_idx;
DROP TABLE audit_log;
