-- Up Migration
-- Progress along the route is computed on the server for every fix (Phase 6) and stored with it.
ALTER TABLE gps_locations
  ADD COLUMN route_progress_m double precision,  -- metres from the start of the route loop
  ADD COLUMN off_route_m      real,              -- distance from the snapped point on the route
  ADD COLUMN speed_est_mps    real;              -- smoothed cruising speed used for ETA

-- Down Migration
ALTER TABLE gps_locations DROP COLUMN route_progress_m, DROP COLUMN off_route_m, DROP COLUMN speed_est_mps;
