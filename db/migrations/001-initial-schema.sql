-- Place-bot platform schema.
--
-- Two people who want the same feed share one topic, one rebuild, and one
-- diff render; they differ only in their subscription. That is the whole
-- reason topics and subscriptions are separate tables.
--
-- utf8mb4 throughout: article titles are arbitrary Unicode.

CREATE TABLE IF NOT EXISTS topics (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  region_qid      VARCHAR(32)     NOT NULL,
  filters_hash    CHAR(64)        NOT NULL,
  entity_filters  JSON            NULL,
  languages       JSON            NULL,
  strategy        VARCHAR(16)     NOT NULL DEFAULT 'auto',
  generation      BIGINT UNSIGNED NOT NULL DEFAULT 0,
  display_name    VARCHAR(255)    NULL,
  last_built_at   DATETIME        NULL,
  created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  -- The dedup key. Hash is over NORMALIZED inputs, so "Mission+places+en"
  -- and "Mission+en+places" collide into one row rather than two feeds.
  UNIQUE KEY uq_topic_region_filters (region_qid, filters_hash),
  KEY idx_topic_region (region_qid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS articles (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  wikipedia     VARCHAR(32)     NOT NULL,
  title         VARCHAR(512)    NOT NULL,
  wikidata_qid  VARCHAR(32)     NULL,
  PRIMARY KEY (id),
  -- Identity is the QID, but the hot path matches on title, so both are
  -- indexed. utf8mb4_bin collation because MediaWiki titles are
  -- case-sensitive after the first character.
  -- NULL wikidata_qid bypasses this constraint entirely (SQL treats NULLs as
  -- distinct). Nothing in Plan A inserts a QID-less article, and identity in
  -- this design IS the QID - but if a later phase needs QID-less rows, it must
  -- add a new migration with a different uniqueness strategy rather than
  -- assuming this one covers them.
  UNIQUE KEY uq_article_wiki_qid (wikipedia, wikidata_qid),
  KEY idx_article_wiki_title (wikipedia, title(191))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS topic_articles (
  topic_id    BIGINT UNSIGNED NOT NULL,
  article_id  BIGINT UNSIGNED NOT NULL,
  source      VARCHAR(32)     NOT NULL,
  score       FLOAT           NULL,
  added_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  removed_at  DATETIME        NULL,
  PRIMARY KEY (topic_id, article_id, source),
  KEY idx_ta_article (article_id),
  KEY idx_ta_live (topic_id, removed_at),
  CONSTRAINT fk_ta_topic FOREIGN KEY (topic_id)
    REFERENCES topics (id) ON DELETE CASCADE,
  CONSTRAINT fk_ta_article FOREIGN KEY (article_id)
    REFERENCES articles (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS subscriptions (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  topic_id         BIGINT UNSIGNED NOT NULL,
  owner_user       VARCHAR(255)    NOT NULL,
  delivery_type    VARCHAR(32)     NOT NULL,
  delivery_config  JSON            NOT NULL,
  display_name     VARCHAR(255)    NULL,
  status           VARCHAR(16)     NOT NULL DEFAULT 'active',
  created_at       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_sub_topic (topic_id),
  KEY idx_sub_owner (owner_user),
  CONSTRAINT fk_sub_topic FOREIGN KEY (topic_id)
    REFERENCES topics (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version    VARCHAR(64) NOT NULL,
  applied_at DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
