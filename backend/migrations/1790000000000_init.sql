-- Up Migration
CREATE TYPE user_role AS ENUM ('DRIVER', 'ADMIN');

CREATE TABLE users (
  id            bigserial PRIMARY KEY,
  role          user_role NOT NULL,
  name          text NOT NULL,
  email         text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE buses (
  id                  text PRIMARY KEY,
  name                text NOT NULL,
  registration_number text UNIQUE,
  active              boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE routes (
  id             text PRIMARY KEY,
  name           text NOT NULL,
  color          text NOT NULL DEFAULT '#2563eb',
  total_length_m double precision NOT NULL CHECK (total_length_m > 0),
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE route_points (
  route_id text NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  seq      integer NOT NULL,
  lat      double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lng      double precision NOT NULL CHECK (lng BETWEEN -180 AND 180),
  PRIMARY KEY (route_id, seq)
);

CREATE TABLE stops (
  id   text PRIMARY KEY,
  name text NOT NULL,
  lat  double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lng  double precision NOT NULL CHECK (lng BETWEEN -180 AND 180)
);

-- One row per time a route passes a stop (an out-and-back route passes most stops twice).
CREATE TABLE route_stops (
  route_id           text NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  seq                integer NOT NULL,
  stop_id            text NOT NULL REFERENCES stops(id),
  dist_along_route_m double precision NOT NULL CHECK (dist_along_route_m >= 0),
  PRIMARY KEY (route_id, seq)
);
CREATE INDEX route_stops_stop_idx ON route_stops (stop_id);

CREATE TABLE landmarks (
  id       text PRIMARY KEY,
  name     text NOT NULL,
  category text NOT NULL,
  lat      double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lng      double precision NOT NULL CHECK (lng BETWEEN -180 AND 180)
);

CREATE TABLE trips (
  id         bigserial PRIMARY KEY,
  bus_id     text   NOT NULL REFERENCES buses(id),
  driver_id  bigint NOT NULL REFERENCES users(id),
  route_id   text   NOT NULL REFERENCES routes(id),
  status     text   NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'COMPLETED')),
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at   timestamptz,
  CHECK ((status = 'ACTIVE') = (ended_at IS NULL))
);
-- The database itself guarantees: one live trip per bus, one per driver.
CREATE UNIQUE INDEX one_active_trip_per_bus    ON trips (bus_id)    WHERE status = 'ACTIVE';
CREATE UNIQUE INDEX one_active_trip_per_driver ON trips (driver_id) WHERE status = 'ACTIVE';

CREATE TABLE gps_locations (
  id          bigserial PRIMARY KEY,
  trip_id     bigint NOT NULL REFERENCES trips(id),
  bus_id      text   NOT NULL REFERENCES buses(id),
  lat         double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lng         double precision NOT NULL CHECK (lng BETWEEN -180 AND 180),
  speed       real,
  accuracy    real,
  heading     real,
  recorded_at timestamptz NOT NULL,                  -- device clock
  received_at timestamptz NOT NULL DEFAULT now()     -- server clock (used for staleness)
);
CREATE INDEX gps_trip_time_idx    ON gps_locations (trip_id, recorded_at);
CREATE INDEX gps_bus_received_idx ON gps_locations (bus_id, received_at DESC);

-- Down Migration
DROP TABLE gps_locations, trips, landmarks, route_stops, stops, route_points, routes, buses, users;
DROP TYPE user_role;
