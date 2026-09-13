PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  institution TEXT NOT NULL,
  domain TEXT NOT NULL,
  base_url TEXT NOT NULL,
  auth_kind TEXT NOT NULL,
  automatic INTEGER NOT NULL DEFAULT 0,
  metadata_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ingest_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL REFERENCES sources(id),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  message TEXT,
  records_seen INTEGER NOT NULL DEFAULT 0,
  records_written INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS raw_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL REFERENCES sources(id),
  ingest_run_id INTEGER REFERENCES ingest_runs(id),
  fetched_at TEXT NOT NULL,
  source_url TEXT NOT NULL,
  content_type TEXT,
  sha256 TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  local_path TEXT,
  http_status INTEGER,
  UNIQUE(source_id, sha256)
);

CREATE TABLE IF NOT EXISTS organizations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  canonical_name TEXT NOT NULL,
  rut TEXT,
  organization_type TEXT,
  source_id TEXT,
  external_id TEXT,
  metadata_json TEXT,
  UNIQUE(source_id, external_id)
);

CREATE TABLE IF NOT EXISTS persons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  canonical_name TEXT NOT NULL,
  source_id TEXT,
  external_id TEXT,
  metadata_json TEXT,
  UNIQUE(source_id, external_id)
);

CREATE TABLE IF NOT EXISTS political_parties (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  canonical_name TEXT NOT NULL,
  acronym TEXT,
  founded_at TEXT,
  dissolved_at TEXT,
  source_id TEXT,
  external_id TEXT,
  metadata_json TEXT,
  UNIQUE(source_id, external_id)
);

CREATE TABLE IF NOT EXISTS geo_areas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  geo_type TEXT NOT NULL,
  code TEXT,
  name TEXT NOT NULL,
  parent_id INTEGER REFERENCES geo_areas(id),
  centroid_lat REAL,
  centroid_lon REAL,
  geometry_json TEXT,
  source_id TEXT,
  external_id TEXT,
  UNIQUE(source_id, external_id)
);

CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL REFERENCES sources(id),
  external_id TEXT NOT NULL,
  project_type TEXT,
  title TEXT,
  description TEXT,
  status TEXT,
  started_at TEXT,
  ended_at TEXT,
  geo_area_id INTEGER REFERENCES geo_areas(id),
  raw_snapshot_id INTEGER REFERENCES raw_snapshots(id),
  metadata_json TEXT,
  UNIQUE(source_id, external_id)
);

CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL REFERENCES sources(id),
  external_id TEXT NOT NULL,
  transaction_type TEXT NOT NULL,
  occurred_at TEXT,
  published_at TEXT,
  amount REAL,
  currency TEXT,
  title TEXT,
  description TEXT,
  category TEXT,
  subcategory TEXT,
  project_id INTEGER REFERENCES projects(id),
  geo_area_id INTEGER REFERENCES geo_areas(id),
  raw_snapshot_id INTEGER REFERENCES raw_snapshots(id),
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(source_id, external_id, transaction_type)
);

CREATE TABLE IF NOT EXISTS transaction_parties (
  transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  organization_id INTEGER REFERENCES organizations(id),
  person_id INTEGER REFERENCES persons(id),
  raw_name TEXT,
  raw_id TEXT,
  metadata_json TEXT,
  PRIMARY KEY(transaction_id, role, raw_name)
);

CREATE TABLE IF NOT EXISTS observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL REFERENCES sources(id),
  external_id TEXT NOT NULL,
  observed_at TEXT,
  metric TEXT NOT NULL,
  value_number REAL,
  value_text TEXT,
  unit TEXT,
  geo_area_id INTEGER REFERENCES geo_areas(id),
  subject_type TEXT,
  subject_id TEXT,
  raw_snapshot_id INTEGER REFERENCES raw_snapshots(id),
  payload_json TEXT,
  UNIQUE(source_id, external_id, metric)
);

CREATE TABLE IF NOT EXISTS relationships (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT,
  from_type TEXT NOT NULL,
  from_id TEXT NOT NULL,
  relation_type TEXT NOT NULL,
  to_type TEXT NOT NULL,
  to_id TEXT NOT NULL,
  valid_from TEXT,
  valid_to TEXT,
  confidence REAL,
  asserted_by TEXT NOT NULL DEFAULT 'source',
  metadata_json TEXT
);

CREATE TABLE IF NOT EXISTS source_catalog_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL REFERENCES sources(id),
  external_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  publisher TEXT,
  page_url TEXT,
  metadata_json TEXT NOT NULL,
  updated_at TEXT,
  UNIQUE(source_id, external_id)
);

CREATE TABLE IF NOT EXISTS source_resources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  catalog_item_id INTEGER NOT NULL REFERENCES source_catalog_items(id) ON DELETE CASCADE,
  external_id TEXT NOT NULL,
  name TEXT,
  format TEXT,
  url TEXT NOT NULL,
  datastore_active INTEGER NOT NULL DEFAULT 0,
  metadata_json TEXT NOT NULL,
  UNIQUE(catalog_item_id, external_id)
);


CREATE TABLE IF NOT EXISTS source_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL REFERENCES sources(id),
  resource_id INTEGER NOT NULL REFERENCES source_resources(id) ON DELETE CASCADE,
  raw_snapshot_id INTEGER REFERENCES raw_snapshots(id),
  ordinal INTEGER NOT NULL,
  record_hash TEXT NOT NULL,
  record_json TEXT NOT NULL,
  imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(resource_id, record_hash)
);
CREATE INDEX IF NOT EXISTS idx_source_records_resource ON source_records(resource_id);
CREATE INDEX IF NOT EXISTS idx_source_records_source ON source_records(source_id);

CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(occurred_at);
CREATE INDEX IF NOT EXISTS idx_transactions_type ON transactions(transaction_type);
CREATE INDEX IF NOT EXISTS idx_transactions_category ON transactions(category);
CREATE INDEX IF NOT EXISTS idx_transactions_source ON transactions(source_id);
CREATE INDEX IF NOT EXISTS idx_observations_metric_date ON observations(metric, observed_at);
CREATE INDEX IF NOT EXISTS idx_resources_format ON source_resources(format);
