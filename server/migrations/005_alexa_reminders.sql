-- Alexa reminders, read on each sync and shown in Finta (read-only). JSON: [{ id, label, at, repeats }].
ALTER TABLE alexa_links ADD COLUMN reminders TEXT;
