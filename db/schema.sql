CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TYPE opportunity_status AS ENUM (
  'new',
  'qualified',
  'offer_requested',
  'contract_requested',
  'won',
  'lost',
  'on_hold'
);

CREATE TYPE recommendation_status AS ENUM (
  'draft',
  'shown',
  'accepted',
  'rejected',
  'executed',
  'expired'
);

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  external_id TEXT UNIQUE,
  full_name TEXT NOT NULL,
  role_code TEXT NOT NULL,
  email TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE companies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bitrix_company_id TEXT UNIQUE,
  raw_name TEXT NOT NULL,
  normalized_name TEXT,
  inn TEXT,
  ogrn TEXT,
  client_type TEXT,
  priority_level INTEGER NOT NULL DEFAULT 0,
  credit_risk_level TEXT,
  segment TEXT,
  confidence_score NUMERIC(4, 3),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE persons (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bitrix_contact_id TEXT UNIQUE,
  company_id UUID REFERENCES companies(id),
  raw_name TEXT NOT NULL,
  normalized_name TEXT,
  phone TEXT,
  role_name TEXT,
  influence_score NUMERIC(4, 3),
  trust_score NUMERIC(4, 3),
  confidence_score NUMERIC(4, 3),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE project_objects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  external_object_id TEXT UNIQUE,
  raw_name TEXT NOT NULL,
  normalized_name TEXT,
  address_raw TEXT,
  address_normalized TEXT,
  geo_lat NUMERIC(10, 7),
  geo_lon NUMERIC(10, 7),
  region TEXT,
  object_type TEXT,
  stage TEXT,
  confidence_score NUMERIC(4, 3),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE equipment_types (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT UNIQUE NOT NULL,
  type_name TEXT NOT NULL,
  category TEXT,
  own_or_subrent_possible BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE opportunities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  external_opportunity_id TEXT UNIQUE,
  bitrix_deal_id TEXT UNIQUE,
  status opportunity_status NOT NULL DEFAULT 'new',
  company_id UUID REFERENCES companies(id),
  person_id UUID REFERENCES persons(id),
  project_object_id UUID REFERENCES project_objects(id),
  equipment_type_id UUID REFERENCES equipment_types(id),
  equipment_model TEXT,
  owner_manager_id UUID REFERENCES users(id),
  commercial_scenario TEXT,
  decision_access_status TEXT,
  commercial_stage TEXT,
  payment_readiness TEXT,
  requested_start_at TIMESTAMPTZ,
  requested_duration_days INTEGER,
  work_conditions_json JSONB,
  price_context_json JSONB,
  client_expected_next_step TEXT,
  geo_hint_json JSONB,
  readiness_signals_json JSONB,
  strategy_weight NUMERIC(6, 3) NOT NULL DEFAULT 1,
  sla_hours INTEGER NOT NULL DEFAULT 4,
  expected_margin_percent NUMERIC(6, 2),
  own_equipment_available BOOLEAN,
  subrent_required BOOLEAN,
  debt_overdue_days INTEGER,
  credit_limit_blocked BOOLEAN NOT NULL DEFAULT FALSE,
  client_blacklisted BOOLEAN NOT NULL DEFAULT FALSE,
  last_touch_at TIMESTAMPTZ,
  next_step_code TEXT,
  next_step_due_at TIMESTAMPTZ,
  next_step_description TEXT,
  priority_score NUMERIC(10, 2),
  need_score NUMERIC(4, 2),
  time_score NUMERIC(4, 2),
  spec_score NUMERIC(4, 2),
  access_score NUMERIC(4, 2),
  money_score NUMERIC(4, 2),
  fit_score NUMERIC(4, 2),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE opportunity_technical_requirements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id UUID NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  requirement_value TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE communication_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  external_event_id TEXT UNIQUE,
  opportunity_id UUID REFERENCES opportunities(id) ON DELETE SET NULL,
  company_id UUID REFERENCES companies(id) ON DELETE SET NULL,
  person_id UUID REFERENCES persons(id) ON DELETE SET NULL,
  project_object_id UUID REFERENCES project_objects(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  event_datetime TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  channel TEXT NOT NULL,
  transcript_ref TEXT,
  summary_text TEXT,
  raw_text TEXT,
  extraction_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE normalization_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_kind TEXT NOT NULL,
  source_record_type TEXT NOT NULL,
  source_record_id TEXT NOT NULL,
  raw_value TEXT NOT NULL,
  normalized_value TEXT,
  confidence_score NUMERIC(4, 3),
  resolved_entity_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE state_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id UUID NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  state_code TEXT NOT NULL,
  confidence_score NUMERIC(4, 3) NOT NULL,
  reason TEXT NOT NULL,
  snapshot_time TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE recommendations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id UUID NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  action_code TEXT NOT NULL,
  target_role TEXT NOT NULL,
  responsible_user_id UUID REFERENCES users(id),
  deadline_at TIMESTAMPTZ,
  escalation_action_code TEXT,
  explainability_json JSONB NOT NULL,
  status recommendation_status NOT NULL DEFAULT 'draft',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE recommendation_feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recommendation_id UUID NOT NULL REFERENCES recommendations(id) ON DELETE CASCADE,
  shown BOOLEAN NOT NULL DEFAULT TRUE,
  shown_to_user_id UUID REFERENCES users(id),
  accepted BOOLEAN NOT NULL DEFAULT FALSE,
  rejected BOOLEAN NOT NULL DEFAULT FALSE,
  rejection_reason TEXT,
  executed BOOLEAN NOT NULL DEFAULT FALSE,
  deal_result TEXT,
  effect_after_1_day TEXT,
  effect_after_3_days TEXT,
  effect_after_7_days TEXT,
  effect_after_30_days TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE ingest_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_system TEXT NOT NULL,
  source_event_type TEXT NOT NULL,
  source_event_id TEXT,
  payload JSONB NOT NULL,
  processing_status TEXT NOT NULL DEFAULT 'pending',
  error_message TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  actor_external_id TEXT,
  actor_name TEXT,
  actor_role TEXT,
  action_code TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  outcome_code TEXT NOT NULL DEFAULT 'success',
  details_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_opportunities_bitrix_deal_id ON opportunities(bitrix_deal_id);
CREATE INDEX idx_opportunities_company_id ON opportunities(company_id);
CREATE INDEX idx_opportunities_project_object_id ON opportunities(project_object_id);
CREATE INDEX idx_communication_events_opportunity_id ON communication_events(opportunity_id);
CREATE INDEX idx_communication_events_event_datetime ON communication_events(event_datetime DESC);
CREATE INDEX idx_state_snapshots_opportunity_id ON state_snapshots(opportunity_id, snapshot_time DESC);
CREATE INDEX idx_recommendations_opportunity_id ON recommendations(opportunity_id, created_at DESC);
CREATE INDEX idx_recommendation_feedback_recommendation_id ON recommendation_feedback(recommendation_id);
CREATE INDEX idx_ingest_events_status ON ingest_events(processing_status, created_at);
CREATE INDEX idx_audit_logs_created_at ON audit_logs(created_at DESC);
