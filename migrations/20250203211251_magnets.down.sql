DROP TABLE IF EXISTS magnets;
DROP INDEX IF EXISTS idx_magnets_geom;
DROP FUNCTION IF EXISTS notify_change();
DROP TRIGGER IF EXISTS notify_change_trigger ON magnets;