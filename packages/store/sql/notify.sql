-- Applied once, after the first `prisma migration` run creates the tables.
--
-- Prisma models tables, not triggers or rules, so this is raw SQL by necessity.
-- It is also the reason the event store is PostgreSQL rather than SQLite: with
-- NOTIFY, `interval` stops being a configuration value at all — the conductor
-- and the board wake on an append instead of on a timer.

-- The payload is the seq only. NOTIFY caps at 8000 bytes and an event body can
-- exceed that, so a listener reads the row it is told about.
CREATE OR REPLACE FUNCTION lingtai_notify_event() RETURNS TRIGGER AS $$
BEGIN
  PERFORM pg_notify('lingtai', NEW.seq::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lingtai_events_notify ON events;
CREATE TRIGGER lingtai_events_notify
  AFTER INSERT ON events
  FOR EACH ROW EXECUTE FUNCTION lingtai_notify_event();

-- Append-only enforced by the database rather than by convention. A correction
-- is a new event; there is no legitimate UPDATE or DELETE against this table.
CREATE OR REPLACE RULE lingtai_events_no_update AS
  ON UPDATE TO events DO INSTEAD NOTHING;
CREATE OR REPLACE RULE lingtai_events_no_delete AS
  ON DELETE TO events DO INSTEAD NOTHING;

-- The project was called Escapement until 2026-09-02 (ADR 0017), and a database
-- bootstrapped before that carries its objects under the old names. Dropped
-- here, at the end, so the replacements above already exist: an events table
-- briefly without its no-delete rule is not a window worth opening.
--
-- The trigger goes before the function it calls. The old trigger is the one
-- that matters: left in place it would keep notifying the `escapement` channel,
-- which nothing listens on any more, so every append would look silent and the
-- loop would wake on nothing.
DROP TRIGGER IF EXISTS escapement_events_notify ON events;
DROP FUNCTION IF EXISTS escapement_notify_event();
DROP RULE IF EXISTS escapement_events_no_update ON events;
DROP RULE IF EXISTS escapement_events_no_delete ON events;
