-- Applied once, after the first `prisma migration` run creates the tables.
--
-- Prisma models tables, not triggers or rules, so this is raw SQL by necessity.
-- It is also the reason the event store is PostgreSQL rather than SQLite: with
-- NOTIFY, `interval` stops being a configuration value at all — the conductor
-- and the board wake on an append instead of on a timer.

-- The payload is the seq only. NOTIFY caps at 8000 bytes and an event body can
-- exceed that, so a listener reads the row it is told about.
CREATE OR REPLACE FUNCTION escapement_notify_event() RETURNS TRIGGER AS $$
BEGIN
  PERFORM pg_notify('escapement', NEW.seq::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS escapement_events_notify ON events;
CREATE TRIGGER escapement_events_notify
  AFTER INSERT ON events
  FOR EACH ROW EXECUTE FUNCTION escapement_notify_event();

-- Append-only enforced by the database rather than by convention. A correction
-- is a new event; there is no legitimate UPDATE or DELETE against this table.
CREATE OR REPLACE RULE escapement_events_no_update AS
  ON UPDATE TO events DO INSTEAD NOTHING;
CREATE OR REPLACE RULE escapement_events_no_delete AS
  ON DELETE TO events DO INSTEAD NOTHING;
