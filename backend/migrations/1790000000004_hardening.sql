-- Up Migration
-- Why a trip ended: the driver pressed End, an admin forced it, or the janitor closed it after the driver went silent.
ALTER TABLE trips ADD COLUMN end_reason text CHECK (end_reason IN ('DRIVER', 'ADMIN', 'AUTO_TIMEOUT'));

-- Down Migration
ALTER TABLE trips DROP COLUMN end_reason;
