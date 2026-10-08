-- Private retrieval only. Original words, revisions, timestamps and citations
-- are untouched. This backfill mirrors application Han tokenization exactly.
-- Unicode 17 Han script ranges are frozen with Node 24.21.0 (see knowledge-tokenization.ts).
CREATE FUNCTION platform_knowledge_han_terms(raw text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $function$
  SELECT coalesce(string_agg(substring(r.run[1] FROM point.i FOR 2), ' ' ORDER BY r.ordinality,point.i),'')
  FROM regexp_matches(raw,U&'[\2e80-\2e99\2e9b-\2ef3\2f00-\2fd5\3005\3007\3021-\3029\3038-\303b\3400-\4dbf\4e00-\9fff\f900-\fa6d\fa70-\fad9\+016fe2-\+016fe3\+016ff0-\+016ff6\+020000-\+02a6df\+02a700-\+02b81d\+02b820-\+02cead\+02ceb0-\+02ebe0\+02ebf0-\+02ee5d\+02f800-\+02fa1d\+030000-\+03134a\+031350-\+033479]+','g') WITH ORDINALITY AS r(run,ordinality)
  CROSS JOIN LATERAL generate_series(1,char_length(r.run[1])-1) AS point(i)
$function$;
ALTER TABLE platform_knowledge_passages ADD COLUMN han_search_vector tsvector NOT NULL DEFAULT ''::tsvector;
UPDATE platform_knowledge_passages SET han_search_vector=to_tsvector('simple'::regconfig,platform_knowledge_han_terms(content));
CREATE INDEX platform_knowledge_passages_han_search ON platform_knowledge_passages USING gin(han_search_vector);
