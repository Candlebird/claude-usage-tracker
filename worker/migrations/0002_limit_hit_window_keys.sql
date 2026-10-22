-- Limit-hit kinds use the snapshot window keys: transcript `seven_day_opus` -> `seven_day:opus`.
-- substr() instead of LIKE because `_` is a LIKE wildcard. A row whose normalized twin already
-- exists is left by UPDATE OR IGNORE and then deleted. Same for hit alert dedupe keys.
UPDATE OR IGNORE limit_hits SET kind = 'seven_day:' || substr(kind, 11)
  WHERE substr(kind, 1, 10) = 'seven_day_' AND length(kind) > 10;
DELETE FROM limit_hits WHERE substr(kind, 1, 10) = 'seven_day_' AND length(kind) > 10;

UPDATE OR IGNORE alert_state SET alert_key = 'hit:seven_day:' || substr(alert_key, 15)
  WHERE substr(alert_key, 1, 14) = 'hit:seven_day_' AND length(alert_key) > 14;
DELETE FROM alert_state WHERE substr(alert_key, 1, 14) = 'hit:seven_day_' AND length(alert_key) > 14;
