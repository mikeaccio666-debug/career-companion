-- Historical money is not re-priced. New admissions require all four explicit server prices.
ALTER TABLE platform_model_prices DROP CONSTRAINT platform_model_prices_unit_check;
ALTER TABLE platform_model_prices ADD CONSTRAINT platform_model_prices_unit_check
  CHECK(unit IN ('input_token','cached_input_token','cache_write_input_token','output_token','audio_second','character','session_minute'));
ALTER TABLE platform_cost_reservations
  ADD COLUMN pricing_revision integer NOT NULL DEFAULT 1 CHECK(pricing_revision IN (1,2)),
  ADD COLUMN cached_input_price_id uuid REFERENCES platform_model_prices(id),
  ADD COLUMN cache_write_input_price_id uuid REFERENCES platform_model_prices(id),
  ADD COLUMN cached_input_micros_per_unit numeric(20,6),
  ADD COLUMN cache_write_input_micros_per_unit numeric(20,6),
  ADD CONSTRAINT platform_cost_cache_prices CHECK(
    (pricing_revision=1 AND cached_input_price_id IS NULL AND cache_write_input_price_id IS NULL
      AND cached_input_micros_per_unit IS NULL AND cache_write_input_micros_per_unit IS NULL)
    OR (pricing_revision=2 AND cached_input_price_id IS NOT NULL AND cache_write_input_price_id IS NOT NULL
      AND cached_input_micros_per_unit IS NOT NULL AND cached_input_micros_per_unit>0
      AND cache_write_input_micros_per_unit IS NOT NULL AND cache_write_input_micros_per_unit>0)
  );
-- Reported totals can still have an unknown cache breakdown. Such costs remain estimates.
ALTER TABLE platform_cost_ledger DROP CONSTRAINT platform_cost_ledger_check;
ALTER TABLE platform_cost_ledger ADD CONSTRAINT platform_cost_estimate_status CHECK(usage_status='reported' OR estimated);
-- Only existing rows receive revision 1. An old writer must fail after cutover,
-- rather than silently creating a new two-price reservation under the new schema.
ALTER TABLE platform_cost_reservations ALTER COLUMN pricing_revision DROP DEFAULT;
