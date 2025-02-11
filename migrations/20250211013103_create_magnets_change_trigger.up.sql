CREATE OR REPLACE FUNCTION notify_change() RETURNS TRIGGER AS $$
  DECLARE
    payload TEXT;
  BEGIN
    payload := json_build_object(
      'id', NEW.id,
      'old_x', OLD.coords[0],
      'old_y', OLD.coords[1],
      'new_x', NEW.coords[0],
      'new_y', NEW.coords[1],
      'rotation', NEW.rotation,
      'z_index', NEW.z_index,
      'word', NEW.word
    );
    PERFORM pg_notify('magnet_updates', payload);
    RETURN NULL;
  END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER table_change
  AFTER UPDATE ON magnets
  FOR EACH ROW EXECUTE PROCEDURE notify_change();