CREATE TABLE platform_knowledge_sources (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  content text CHECK (octet_length(content) BETWEEN 1 AND 65536),
  source_label text CHECK (char_length(source_label) BETWEEN 1 AND 200),
  source_url text CHECK (char_length(source_url) BETWEEN 1 AND 2048),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  passage_count integer NOT NULL CHECK (passage_count BETWEEN 0 AND 128),
  byte_size integer NOT NULL CHECK (byte_size BETWEEN 0 AND 65536),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CHECK ((deleted_at IS NULL) = (content IS NOT NULL)),
  UNIQUE (id, revision)
);
CREATE INDEX platform_knowledge_sources_owner ON platform_knowledge_sources(user_id, updated_at DESC, id) WHERE deleted_at IS NULL;
CREATE TABLE platform_knowledge_passages (
  source_id uuid NOT NULL,
  revision integer NOT NULL,
  passage_id text NOT NULL,
  passage_index integer NOT NULL CHECK (passage_index BETWEEN 0 AND 127),
  content text NOT NULL CHECK (char_length(content) BETWEEN 1 AND 1200),
  search_vector tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, content)) STORED,
  PRIMARY KEY (source_id, revision, passage_index),
  UNIQUE (source_id, passage_id),
  FOREIGN KEY (source_id, revision) REFERENCES platform_knowledge_sources(id, revision) ON DELETE CASCADE,
  CHECK (passage_id = revision::text || ':' || passage_index::text)
);
CREATE INDEX platform_knowledge_passages_search ON platform_knowledge_passages USING gin(search_vector);
