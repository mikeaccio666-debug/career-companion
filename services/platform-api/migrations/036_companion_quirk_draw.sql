-- One best-effort quirk redraw before the first preview (02 §2.4). Existing
-- zero-draw encrypted seeds retain their exact old shape; no decrypt/rewrite.
-- The companion fingerprint remains an ordinary, non-unique index.
ALTER TABLE platform_companion_generation_tasks ADD COLUMN quirk_draw integer NOT NULL DEFAULT 0 CHECK (quirk_draw IN (0,1));
