import { query, withTransaction } from '../db/postgres.mjs';
import { buildBitrixEntityPatch, normalizeBitrixEvent } from '../services/bitrix-ingest-service.mjs';
import { evaluateOpportunityState } from '../dss/state-engine.mjs';
import { decideNextAction } from '../dss/decision-engine.mjs';

function toNormalization(row, prefix) {
  const raw = row[`${prefix}_raw_value`];
  const normalized = row[`${prefix}_normalized_value`];

  if (!raw && !normalized) {
    return null;
  }

  return {
    raw_value: raw ?? '',
    normalized_value: normalized ?? null,
    confidence_score: row[`${prefix}_confidence_score`] !== null && row[`${prefix}_confidence_score`] !== undefined
      ? Number(row[`${prefix}_confidence_score`])
      : null,
    resolved_entity_id: row[`${prefix}_resolved_entity_id`] ?? null,
  };
}

function mapOpportunityRow(row, communicationEvents = []) {
  const competitorPresent = communicationEvents.some((event) => event.extraction_json?.competitor?.mentioned === true);
  const subrentRequiredFromEvents = communicationEvents.some((event) => event.extraction_json?.supply_mode === 'subrent');
  const debtRiskFromEvents = communicationEvents.some((event) => event.extraction_json?.debt_risk?.mentioned === true);
  const creditLimitFromEvents = communicationEvents.some((event) =>
    (event.extraction_json?.debt_risk?.markers ?? []).some((marker) => marker.includes('лимит')));
  return {
    id: row.external_opportunity_id || row.id,
    bitrix_deal_id: row.bitrix_deal_id,
    company: toNormalization(row, 'company'),
    contact_person: row.person_raw_value
      ? {
          raw_value: row.person_raw_value,
          normalized_value: row.person_normalized_value,
          role: row.person_role_name,
          influence_score: row.person_influence_score !== null ? Number(row.person_influence_score) : null,
          trust_score: row.person_trust_score !== null ? Number(row.person_trust_score) : null,
          confidence_score: row.person_confidence_score !== null ? Number(row.person_confidence_score) : null,
          resolved_entity_id: row.person_resolved_entity_id,
        }
      : null,
    project_object: toNormalization(row, 'project_object'),
    address: row.project_object_address_raw
      ? {
          raw_value: row.project_object_address_raw,
          normalized_value: row.project_object_address_normalized,
          confidence_score: row.project_object_confidence_score !== null ? Number(row.project_object_confidence_score) : null,
          resolved_entity_id: row.project_object_resolved_entity_id,
        }
      : null,
    equipment_type: row.equipment_type_name
      ? {
          raw_value: row.equipment_type_name,
          normalized_value: row.equipment_type_name,
          confidence_score: 1,
          resolved_entity_id: `equipment_type:${row.equipment_type_code}`,
        }
      : null,
    equipment_model: row.equipment_model ?? null,
    time_window: {
      start_at: row.requested_start_at,
      duration_days: row.requested_duration_days,
    },
    commercial_scenario: row.commercial_scenario,
    decision_access_status: row.decision_access_status,
    commercial_stage: row.commercial_stage,
    payment_readiness: row.payment_readiness,
    technical_requirements: row.technical_requirements ?? [],
    work_conditions: row.work_conditions_json ?? [],
    price_context: row.price_context_json ?? null,
    client_expected_next_step: row.client_expected_next_step ?? null,
    geo_hint: row.geo_hint_json ?? null,
    readiness_signals: row.readiness_signals_json ?? {
      contract_ready: false,
      payment_ready: false,
      urgency_high: false,
    },
    economic_assessment: {
      expected_margin_percent: row.expected_margin_percent !== null ? Number(row.expected_margin_percent) : null,
      own_equipment_available: row.own_equipment_available,
      subrent_required: row.subrent_required ?? subrentRequiredFromEvents,
    },
    financial_risk: {
      debt_overdue_days: row.debt_overdue_days ?? (debtRiskFromEvents ? 1 : null),
      credit_limit_blocked: row.credit_limit_blocked || creditLimitFromEvents,
      client_blacklisted: row.client_blacklisted,
    },
    owner_manager: row.owner_manager_full_name
      ? {
          external_id: row.owner_manager_external_id,
          full_name: row.owner_manager_full_name,
          role_code: row.owner_manager_role_code,
        }
      : null,
    next_step: {
      code: row.next_step_code,
      due_at: row.next_step_due_at,
      description: row.next_step_description,
    },
    source_scores: {
      need: row.need_score !== null ? Number(row.need_score) : null,
      time: row.time_score !== null ? Number(row.time_score) : null,
      spec: row.spec_score !== null ? Number(row.spec_score) : null,
      access: row.access_score !== null ? Number(row.access_score) : null,
      money: row.money_score !== null ? Number(row.money_score) : null,
      fit: row.fit_score !== null ? Number(row.fit_score) : null,
    },
    last_touch_at: row.last_touch_at,
    strategy_weight: row.strategy_weight !== null ? Number(row.strategy_weight) : 1,
    sla_hours: row.sla_hours,
    graph_signals: {
      cross_sell_open: false,
      competitor_present: competitorPresent,
    },
    communication_events: communicationEvents,
  };
}

async function fetchCommunicationEvents(opportunityId) {
  const { rows } = await query(
    `
      SELECT
        id,
        event_type AS type,
        channel,
        summary_text AS summary,
        raw_text AS text,
        event_datetime AS datetime,
        extraction_json
      FROM communication_events
      WHERE opportunity_id = $1
      ORDER BY event_datetime DESC
    `,
    [opportunityId],
  );
  return rows.map((row) => ({
    ...row,
    author_name: row.extraction_json?.author_name ?? null,
    author_external_id: row.extraction_json?.author_external_id ?? null,
  }));
}

function roundRate(value) {
  return Number(value.toFixed(3));
}

function buildLearningInsight(metric) {
  const learningScore = Number((((metric.accepted_rate ?? 0) * 0.35) + ((metric.executed_rate ?? 0) * 0.5) - ((metric.rejected_rate ?? 0) * 0.4)).toFixed(3));
  let learningState = 'observe';
  let guidance = 'Недостаточно устойчивого сигнала, продолжаем копить обратную связь.';

  if ((metric.total ?? 0) >= 3 && learningScore >= 0.45) {
    learningState = 'promote';
    guidance = 'Действие можно смелее поднимать в приоритете при похожих состояниях.';
  } else if ((metric.total ?? 0) >= 3 && learningScore <= 0.05) {
    learningState = 'suppress';
    guidance = 'Действие стоит ослабить или чаще заменять альтернативой.';
  } else if ((metric.total ?? 0) >= 2) {
    learningState = 'watch';
    guidance = 'Сигнал есть, но пока рано менять политику выбора радикально.';
  }

  return {
    ...metric,
    learning_score: learningScore,
    learning_state: learningState,
    guidance,
  };
}

let auditSchemaEnsured = false;
let normalizationDecisionSchemaEnsured = false;
let opportunityEnrichmentSchemaEnsured = false;

async function ensureAuditSchema() {
  if (auditSchemaEnsured) return;

  await query(`
    CREATE TABLE IF NOT EXISTS audit_logs (
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
    )
  `);
  await query('CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at DESC)');
  auditSchemaEnsured = true;
}

async function ensureNormalizationDecisionSchema() {
  if (normalizationDecisionSchemaEnsured) return;

  await query(`
    CREATE TABLE IF NOT EXISTS normalization_decisions (
      candidate_key TEXT PRIMARY KEY,
      decision_status TEXT NOT NULL,
      note TEXT,
      actor_name TEXT,
      actor_role TEXT,
      decided_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  normalizationDecisionSchemaEnsured = true;
}

async function ensureOpportunityEnrichmentSchema() {
  if (opportunityEnrichmentSchemaEnsured) return;

  await query(`
    ALTER TABLE opportunities
    ADD COLUMN IF NOT EXISTS equipment_model TEXT,
    ADD COLUMN IF NOT EXISTS work_conditions_json JSONB,
    ADD COLUMN IF NOT EXISTS price_context_json JSONB,
    ADD COLUMN IF NOT EXISTS client_expected_next_step TEXT,
    ADD COLUMN IF NOT EXISTS geo_hint_json JSONB,
    ADD COLUMN IF NOT EXISTS readiness_signals_json JSONB
  `);

  opportunityEnrichmentSchemaEnsured = true;
}

async function listAcceptedNormalizationAliases() {
  await ensureNormalizationDecisionSchema();
  const { rows } = await query(
    `
      SELECT candidate_key
      FROM normalization_decisions
      WHERE decision_status = 'accepted'
    `,
  );

  return rows
    .map((row) => String(row.candidate_key ?? '').split('::'))
    .filter((parts) => parts.length === 3)
    .map(([entity_kind, left_label, right_label]) => ({
      entity_kind,
      left_label,
      right_label,
    }));
}

function matchAcceptedAlias(aliases, entityKind, leftValue, rightValue) {
  if (!leftValue || !rightValue) return false;
  const normalizedLeft = String(leftValue).toLowerCase();
  const normalizedRight = String(rightValue).toLowerCase();
  return aliases.some((item) =>
    item.entity_kind === entityKind
    && (
      (item.left_label === normalizedLeft && item.right_label === normalizedRight)
      || (item.left_label === normalizedRight && item.right_label === normalizedLeft)
    ));
}

async function fetchOpportunityRows(optionalExternalId = null) {
  await ensureOpportunityEnrichmentSchema();
  const conditions = optionalExternalId ? 'WHERE o.external_opportunity_id = $1 OR o.id::text = $1' : '';
  const params = optionalExternalId ? [optionalExternalId] : [];

  const { rows } = await query(
    `
      SELECT
        o.*,
        c.raw_name AS company_raw_value,
        c.normalized_name AS company_normalized_value,
        c.confidence_score AS company_confidence_score,
        CONCAT('company:', c.normalized_name) AS company_resolved_entity_id,
        p.raw_name AS person_raw_value,
        p.normalized_name AS person_normalized_value,
        p.role_name AS person_role_name,
        p.influence_score AS person_influence_score,
        p.trust_score AS person_trust_score,
        p.confidence_score AS person_confidence_score,
        CONCAT('person:', p.normalized_name) AS person_resolved_entity_id,
        po.raw_name AS project_object_raw_value,
        po.normalized_name AS project_object_normalized_value,
        po.confidence_score AS project_object_confidence_score,
        CONCAT('object:', po.normalized_name) AS project_object_resolved_entity_id,
        po.address_raw AS project_object_address_raw,
        po.address_normalized AS project_object_address_normalized,
        et.code AS equipment_type_code,
        et.type_name AS equipment_type_name,
        u.external_id AS owner_manager_external_id,
        u.full_name AS owner_manager_full_name,
        u.role_code AS owner_manager_role_code,
        COALESCE(
          ARRAY(
            SELECT otr.requirement_value
            FROM opportunity_technical_requirements otr
            WHERE otr.opportunity_id = o.id
            ORDER BY otr.created_at ASC
          ),
          ARRAY[]::text[]
        ) AS technical_requirements
      FROM opportunities o
      LEFT JOIN companies c ON c.id = o.company_id
      LEFT JOIN persons p ON p.id = o.person_id
      LEFT JOIN project_objects po ON po.id = o.project_object_id
      LEFT JOIN equipment_types et ON et.id = o.equipment_type_id
      LEFT JOIN users u ON u.id = o.owner_manager_id
      ${conditions}
      ORDER BY o.created_at DESC
    `,
    params,
  );

  return rows;
}

async function insertNormalizationResults(client, patch, event) {
  const entries = [
    patch.company ? ['company', patch.company] : null,
    patch.person ? ['person', patch.person] : null,
    patch.project_object ? ['project_object', patch.project_object] : null,
    patch.address ? ['address', patch.address] : null,
    patch.equipment_type ? ['equipment_type', patch.equipment_type] : null,
  ].filter(Boolean);

  for (const [entityKind, result] of entries) {
    await client.query(
      `
        INSERT INTO normalization_results (
          entity_kind,
          source_record_type,
          source_record_id,
          raw_value,
          normalized_value,
          confidence_score,
          resolved_entity_id
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `,
      [
        entityKind,
        event.entity_type,
        String(event.entity_id),
        result.raw_value,
        result.normalized_value ?? null,
        result.confidence_score ?? null,
        result.resolved_entity_id ?? null,
      ],
    );
  }
}

async function resolveOpportunityDbId(client, patch) {
  const acceptedAliases = await listAcceptedNormalizationAliases();
  if (patch.opportunity_external_id) {
    const direct = await client.query(
      `
        SELECT id
        FROM opportunities
        WHERE external_opportunity_id = $1 OR bitrix_deal_id = $1
        LIMIT 1
      `,
      [String(patch.opportunity_external_id)],
    );

    if (direct.rows[0]?.id) {
      return {
        id: direct.rows[0].id,
        match_type: 'direct_opportunity',
        match_score: 1,
        suspicious: false,
      };
    }
  }

  if (patch.contact_external_id) {
    const byContact = await client.query(
      `
        SELECT o.id
        FROM opportunities o
        JOIN persons p ON p.id = o.person_id
        WHERE p.bitrix_contact_id = $1
        ORDER BY o.updated_at DESC
        LIMIT 1
      `,
      [String(patch.contact_external_id)],
    );

    if (byContact.rows[0]?.id) {
      return {
        id: byContact.rows[0].id,
        match_type: 'bitrix_contact',
        match_score: 1,
        suspicious: false,
      };
    }
  }

  if (patch.company_external_id) {
    const byCompany = await client.query(
      `
        SELECT o.id
        FROM opportunities o
        JOIN companies c ON c.id = o.company_id
        WHERE c.bitrix_company_id = $1
        ORDER BY o.updated_at DESC
        LIMIT 1
      `,
      [String(patch.company_external_id)],
    );

    if (byCompany.rows[0]?.id) {
      return {
        id: byCompany.rows[0].id,
        match_type: 'bitrix_company',
        match_score: 1,
        suspicious: false,
      };
    }
  }

  if (patch.project_object?.normalized_value) {
    const byObject = await client.query(
      `
        SELECT o.id
        FROM opportunities o
        JOIN project_objects po ON po.id = o.project_object_id
        WHERE po.normalized_name = $1
        ORDER BY o.updated_at DESC
        LIMIT 1
      `,
      [patch.project_object.normalized_value],
    );

    if (byObject.rows[0]?.id) {
      return {
        id: byObject.rows[0].id,
        match_type: 'normalized_object',
        match_score: 0.85,
        suspicious: false,
      };
    }
  }

  const contextual = await client.query(
    `
      SELECT
        o.id,
        c.normalized_name AS company_normalized_value,
        po.normalized_name AS project_object_normalized_value,
        p.normalized_name AS person_normalized_value,
        (
          CASE WHEN $1::text IS NOT NULL AND c.normalized_name = $1 THEN 3 ELSE 0 END +
          CASE WHEN $2::text IS NOT NULL AND po.normalized_name = $2 THEN 3 ELSE 0 END +
          CASE WHEN $3::text IS NOT NULL AND po.address_normalized = $3 THEN 2 ELSE 0 END +
          CASE WHEN $4::text IS NOT NULL AND et.type_name = $4 THEN 2 ELSE 0 END +
          CASE WHEN $5::text IS NOT NULL AND p.normalized_name = $5 THEN 2 ELSE 0 END
        ) AS match_score
      FROM opportunities o
      LEFT JOIN companies c ON c.id = o.company_id
      LEFT JOIN project_objects po ON po.id = o.project_object_id
      LEFT JOIN equipment_types et ON et.id = o.equipment_type_id
      LEFT JOIN persons p ON p.id = o.person_id
      WHERE (
        CASE WHEN $1::text IS NOT NULL AND c.normalized_name = $1 THEN 3 ELSE 0 END +
        CASE WHEN $2::text IS NOT NULL AND po.normalized_name = $2 THEN 3 ELSE 0 END +
        CASE WHEN $3::text IS NOT NULL AND po.address_normalized = $3 THEN 2 ELSE 0 END +
        CASE WHEN $4::text IS NOT NULL AND et.type_name = $4 THEN 2 ELSE 0 END +
        CASE WHEN $5::text IS NOT NULL AND p.normalized_name = $5 THEN 2 ELSE 0 END
      ) >= 4
      ORDER BY match_score DESC, o.updated_at DESC
      LIMIT 1
    `,
    [
      patch.company?.normalized_value ?? null,
      patch.project_object?.normalized_value ?? null,
      patch.address?.normalized_value ?? null,
      patch.equipment_type?.normalized_value ?? null,
      patch.person?.normalized_value ?? null,
    ],
  );

  if (contextual.rows[0]?.id) {
    const matchScore = Number(contextual.rows[0].match_score ?? 0);
    const aliasMatches = [
      ...(matchAcceptedAlias(acceptedAliases, 'company', patch.company?.normalized_value, contextual.rows[0].company_normalized_value) ? ['company'] : []),
      ...(matchAcceptedAlias(acceptedAliases, 'object', patch.project_object?.normalized_value, contextual.rows[0].project_object_normalized_value) ? ['object'] : []),
      ...(matchAcceptedAlias(acceptedAliases, 'person', patch.person?.normalized_value, contextual.rows[0].person_normalized_value) ? ['person'] : []),
    ];
    const aliasBonus =
      (aliasMatches.includes('company') ? 0.2 : 0)
      + (aliasMatches.includes('object') ? 0.2 : 0)
      + (aliasMatches.includes('person') ? 0.15 : 0);
    const boostedScore = matchScore + aliasBonus;
    return {
      id: contextual.rows[0].id,
      match_type: 'contextual',
      match_score: boostedScore,
      suspicious: boostedScore < 5,
      alias_matches: aliasMatches,
    };
  }

  return null;
}

async function upsertCompanyFromPatch(client, patch, fallbackRef) {
  if (!patch.company_external_id && !patch.company?.raw_value) {
    return null;
  }

  const companyName = patch.company ?? {
    raw_value: `Компания ${patch.company_external_id ?? fallbackRef}`,
    normalized_value: `компания ${patch.company_external_id ?? fallbackRef}`,
    confidence_score: 0.3,
  };
  const { rows } = await client.query(
    `
      INSERT INTO companies (bitrix_company_id, raw_name, normalized_name, confidence_score)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (bitrix_company_id)
      DO UPDATE SET
        raw_name = EXCLUDED.raw_name,
        normalized_name = EXCLUDED.normalized_name,
        confidence_score = GREATEST(companies.confidence_score, EXCLUDED.confidence_score),
        updated_at = NOW()
      RETURNING id
    `,
    [
      String(patch.company_external_id ?? patch.company?.resolved_entity_id ?? `derived-company:${fallbackRef}`),
      companyName.raw_value,
      companyName.normalized_value,
      companyName.confidence_score ?? 0.3,
    ],
  );
  return rows[0]?.id ?? null;
}

async function upsertPersonFromPatch(client, patch, companyId, fallbackRef) {
  if (!patch.contact_external_id && !patch.person?.raw_value) {
    return null;
  }

  const { rows } = await client.query(
    `
      INSERT INTO persons (
        bitrix_contact_id,
        company_id,
        raw_name,
        normalized_name,
        role_name,
        confidence_score
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (bitrix_contact_id)
      DO UPDATE SET
        company_id = COALESCE(EXCLUDED.company_id, persons.company_id),
        raw_name = COALESCE(EXCLUDED.raw_name, persons.raw_name),
        normalized_name = COALESCE(EXCLUDED.normalized_name, persons.normalized_name),
        role_name = COALESCE(EXCLUDED.role_name, persons.role_name),
        confidence_score = GREATEST(COALESCE(persons.confidence_score, 0), COALESCE(EXCLUDED.confidence_score, 0)),
        updated_at = NOW()
      RETURNING id
    `,
    [
      String(patch.contact_external_id ?? patch.person?.resolved_entity_id ?? `derived-contact:${fallbackRef}`),
      companyId,
      patch.person?.raw_value ?? `Контакт ${patch.contact_external_id ?? fallbackRef}`,
      patch.person?.normalized_value ?? `контакт ${patch.contact_external_id ?? fallbackRef}`,
      patch.person?.role ?? null,
      patch.person?.confidence_score ?? 0.25,
    ],
  );
  return rows[0]?.id ?? null;
}

async function upsertProjectObjectFromPatch(client, patch, fallbackRef) {
  if (!patch.project_object?.raw_value) {
    return null;
  }

  const { rows } = await client.query(
    `
      INSERT INTO project_objects (
        external_object_id,
        raw_name,
        normalized_name,
        address_raw,
        address_normalized,
        confidence_score
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (external_object_id)
      DO UPDATE SET
        raw_name = EXCLUDED.raw_name,
        normalized_name = EXCLUDED.normalized_name,
        address_raw = COALESCE(EXCLUDED.address_raw, project_objects.address_raw),
        address_normalized = COALESCE(EXCLUDED.address_normalized, project_objects.address_normalized),
        confidence_score = GREATEST(COALESCE(project_objects.confidence_score, 0), COALESCE(EXCLUDED.confidence_score, 0)),
        updated_at = NOW()
      RETURNING id
    `,
    [
      patch.project_object.resolved_entity_id ?? `bitrix-object:${fallbackRef}`,
      patch.project_object.raw_value,
      patch.project_object.normalized_value,
      patch.address?.raw_value ?? null,
      patch.address?.normalized_value ?? null,
      patch.project_object.confidence_score ?? 0.3,
    ],
  );
  return rows[0]?.id ?? null;
}

async function upsertEquipmentTypeFromPatch(client, patch) {
  if (!patch.equipment_type?.normalized_value) {
    return null;
  }

  const equipmentCode = patch.equipment_type.normalized_value.toLowerCase().replace(/\s+/g, '_');
  const { rows } = await client.query(
    `
      INSERT INTO equipment_types (code, type_name)
      VALUES ($1, $2)
      ON CONFLICT (code)
      DO UPDATE SET
        type_name = EXCLUDED.type_name,
        updated_at = NOW()
      RETURNING id
    `,
    [equipmentCode, patch.equipment_type.normalized_value],
  );
  return rows[0]?.id ?? null;
}

async function enrichOpportunityFromCommunicationPatch(client, opportunityId, patch) {
  if (!opportunityId) {
    return;
  }

  if (patch.extraction_json?.is_noise === true) {
    return;
  }

  const fallbackRef = patch.opportunity_external_id ?? patch.external_id;
  const companyId = await upsertCompanyFromPatch(client, patch, fallbackRef);
  const personId = await upsertPersonFromPatch(client, patch, companyId, fallbackRef);
  const projectObjectId = await upsertProjectObjectFromPatch(client, patch, fallbackRef);
  const equipmentTypeId = await upsertEquipmentTypeFromPatch(client, patch);

  await client.query(
    `
      UPDATE opportunities
      SET
        company_id = COALESCE(company_id, $2),
        person_id = COALESCE(person_id, $3),
        project_object_id = COALESCE(project_object_id, $4),
        equipment_type_id = COALESCE(equipment_type_id, $5),
        equipment_model = COALESCE(equipment_model, $6),
        decision_access_status = COALESCE(decision_access_status, $7),
        commercial_stage = COALESCE(commercial_stage, $8),
        payment_readiness = COALESCE(payment_readiness, $9),
        requested_start_at = COALESCE(requested_start_at, $10),
        requested_duration_days = COALESCE(requested_duration_days, $11),
        next_step_code = COALESCE(next_step_code, $12),
        next_step_due_at = COALESCE(next_step_due_at, $13),
        next_step_description = COALESCE(next_step_description, $14),
        last_touch_at = GREATEST(COALESCE(last_touch_at, '-infinity'::timestamptz), COALESCE($15, '-infinity'::timestamptz)),
        subrent_required = COALESCE(subrent_required, $16),
        credit_limit_blocked = COALESCE(credit_limit_blocked, $17),
        debt_overdue_days = CASE
          WHEN $18 THEN GREATEST(COALESCE(debt_overdue_days, 0), 1)
          ELSE debt_overdue_days
        END,
        work_conditions_json = COALESCE(work_conditions_json, $19::jsonb),
        price_context_json = COALESCE(price_context_json, $20::jsonb),
        client_expected_next_step = COALESCE(client_expected_next_step, $21),
        geo_hint_json = COALESCE(geo_hint_json, $22::jsonb),
        readiness_signals_json = COALESCE(readiness_signals_json, $23::jsonb),
        updated_at = NOW()
      WHERE id = $1
    `,
    [
      opportunityId,
      companyId,
      personId,
      projectObjectId,
      equipmentTypeId,
      patch.equipment_model ?? null,
      patch.decision_access_status ?? null,
      patch.commercial_stage ?? null,
      patch.payment_readiness ?? null,
      patch.requested_start_at ?? null,
      patch.requested_duration_days ?? null,
      patch.next_step_code ?? null,
      patch.next_step_due_at ?? null,
      patch.next_step_description ?? null,
      patch.event_datetime ?? null,
      patch.subrent_required ?? null,
      patch.credit_limit_blocked ?? null,
      patch.debt_risk_flag === true,
      JSON.stringify(patch.work_conditions ?? []),
      patch.price_context ? JSON.stringify(patch.price_context) : null,
      patch.client_expected_next_step ?? null,
      patch.geo_hint ? JSON.stringify(patch.geo_hint) : null,
      patch.readiness_signals ? JSON.stringify(patch.readiness_signals) : null,
    ],
  );

  for (const requirement of patch.technical_requirements ?? []) {
    await client.query(
      `
        INSERT INTO opportunity_technical_requirements (opportunity_id, requirement_value)
        SELECT $1, $2
        WHERE NOT EXISTS (
          SELECT 1
          FROM opportunity_technical_requirements
          WHERE opportunity_id = $1 AND requirement_value = $2
        )
      `,
      [opportunityId, requirement],
    );
  }
}

export class PostgresOpportunityRepository {
  async listOpportunities() {
    const rows = await fetchOpportunityRows();
    const items = [];

    for (const row of rows) {
      const communicationEvents = await fetchCommunicationEvents(row.id);
      items.push(mapOpportunityRow(row, communicationEvents));
    }

    return items;
  }

  async getOpportunityById(id) {
    const rows = await fetchOpportunityRows(id);
    const row = rows[0];
    if (!row) {
      return null;
    }

    const communicationEvents = await fetchCommunicationEvents(row.id);
    return mapOpportunityRow(row, communicationEvents);
  }

  async listStateSnapshots(opportunityId) {
    const { rows } = await query(
      `
        SELECT
          s.state_code,
          s.confidence_score,
          s.reason,
          s.snapshot_time,
          o.external_opportunity_id AS opportunity_id
        FROM state_snapshots s
        JOIN opportunities o ON o.id = s.opportunity_id
        WHERE o.external_opportunity_id = $1 OR o.id::text = $1
        ORDER BY s.snapshot_time DESC
      `,
      [opportunityId],
    );

    return rows;
  }

  async listRecommendations(opportunityId) {
    const { rows } = await query(
      `
        SELECT
          r.id,
          o.external_opportunity_id AS opportunity_id,
          r.action_code,
          r.target_role,
          r.deadline_at,
          r.escalation_action_code,
          r.explainability_json,
          r.status,
          r.created_at
        FROM recommendations r
        JOIN opportunities o ON o.id = r.opportunity_id
        WHERE o.external_opportunity_id = $1 OR o.id::text = $1
        ORDER BY r.created_at DESC
      `,
      [opportunityId],
    );

    return rows;
  }

  async listFailedIngestEvents(limit = 100) {
    const { rows } = await query(
      `
        SELECT *
        FROM ingest_events
        WHERE processing_status IN ('failed', 'suspicious')
        ORDER BY updated_at DESC
        LIMIT $1
      `,
      [limit],
    );

    return rows;
  }

  async getSystemDiagnostics() {
    const { rows } = await query(
      `
        SELECT
          (SELECT MAX(created_at) FROM ingest_events) AS latest_ingest_at,
          (
            SELECT MAX(updated_at)
            FROM ingest_events
            WHERE processing_status IN ('processed', 'suspicious', 'failed')
          ) AS latest_processed_ingest_at,
          (
            SELECT MAX(updated_at)
            FROM ingest_events
            WHERE processing_status IN ('failed', 'suspicious')
          ) AS latest_ingest_issue_at,
          (SELECT MAX(created_at) FROM recommendations) AS latest_recommendation_at,
          (SELECT MAX(created_at) FROM audit_logs) AS latest_audit_at
      `,
    );

    return rows[0] ?? {
      latest_ingest_at: null,
      latest_processed_ingest_at: null,
      latest_ingest_issue_at: null,
      latest_recommendation_at: null,
      latest_audit_at: null,
    };
  }

  async listNormalizationResults(limit = 500) {
    const { rows } = await query(
      `
        SELECT
          entity_kind,
          source_record_type,
          source_record_id,
          raw_value,
          normalized_value,
          confidence_score,
          resolved_entity_id,
          created_at
        FROM normalization_results
        ORDER BY created_at DESC
        LIMIT $1
      `,
      [limit],
    );

    return rows;
  }

  async saveNormalizationDecision(payload) {
    await ensureNormalizationDecisionSchema();
    const { rows } = await query(
      `
        INSERT INTO normalization_decisions (
          candidate_key,
          decision_status,
          note,
          actor_name,
          actor_role,
          decided_at
        )
        VALUES ($1, $2, $3, $4, $5, NOW())
        ON CONFLICT (candidate_key)
        DO UPDATE SET
          decision_status = EXCLUDED.decision_status,
          note = EXCLUDED.note,
          actor_name = EXCLUDED.actor_name,
          actor_role = EXCLUDED.actor_role,
          decided_at = NOW()
        RETURNING candidate_key, decision_status, note, actor_name, actor_role, decided_at
      `,
      [
        payload.candidate_key,
        payload.decision_status,
        payload.note ?? null,
        payload.actor_name ?? null,
        payload.actor_role ?? null,
      ],
    );
    return rows[0] ?? null;
  }

  async getNormalizationDecision(candidateKey) {
    await ensureNormalizationDecisionSchema();
    const { rows } = await query(
      `
        SELECT candidate_key, decision_status, note, actor_name, actor_role, decided_at
        FROM normalization_decisions
        WHERE candidate_key = $1
        LIMIT 1
      `,
      [candidateKey],
    );
    return rows[0] ?? null;
  }

  async upsertUserContext(user) {
    const { rows } = await query(
      `
        INSERT INTO users (external_id, full_name, role_code, active)
        VALUES ($1, $2, $3, true)
        ON CONFLICT (external_id)
        DO UPDATE SET
          full_name = EXCLUDED.full_name,
          role_code = EXCLUDED.role_code,
          updated_at = NOW()
        RETURNING id, external_id, full_name, role_code
      `,
      [user.external_id, user.full_name, user.role_code],
    );

    return rows[0] ?? null;
  }

  async saveAuditLog(entry) {
    await ensureAuditSchema();

    const actor = entry.actor_external_id
      ? await this.upsertUserContext({
          external_id: entry.actor_external_id,
          full_name: entry.actor_name ?? entry.actor_external_id,
          role_code: entry.actor_role ?? 'sales_manager',
        })
      : null;

    const { rows } = await query(
      `
        INSERT INTO audit_logs (
          actor_user_id,
          actor_external_id,
          actor_name,
          actor_role,
          action_code,
          resource_type,
          resource_id,
          outcome_code,
          details_json
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
        RETURNING
          id,
          actor_external_id,
          actor_name,
          actor_role,
          action_code,
          resource_type,
          resource_id,
          outcome_code,
          details_json,
          created_at
      `,
      [
        actor?.id ?? null,
        entry.actor_external_id ?? null,
        entry.actor_name ?? null,
        entry.actor_role ?? null,
        entry.action_code,
        entry.resource_type,
        entry.resource_id ?? null,
        entry.outcome_code ?? 'success',
        JSON.stringify(entry.details_json ?? {}),
      ],
    );

    return rows[0] ?? null;
  }

  async listAuditLogs(limit = 50) {
    await ensureAuditSchema();
    const { rows } = await query(
      `
        SELECT
          id,
          actor_external_id,
          actor_name,
          actor_role,
          action_code,
          resource_type,
          resource_id,
          outcome_code,
          details_json,
          created_at
        FROM audit_logs
        ORDER BY created_at DESC
        LIMIT $1
      `,
      [limit],
    );

    return rows;
  }

  async saveFeedback(actionId, payload) {
    return withTransaction(async (client) => {
      const shown = payload.shown ?? true;
      const accepted = payload.accepted ?? false;
      const rejected = payload.rejected ?? false;
      const executed = payload.executed ?? false;

      let nextStatus = 'shown';
      if (executed) {
        nextStatus = 'executed';
      } else if (accepted) {
        nextStatus = 'accepted';
      } else if (rejected) {
        nextStatus = 'rejected';
      }

      await client.query(
        `
          UPDATE recommendations
          SET
            status = $2,
            updated_at = NOW()
          WHERE id = $1::uuid
        `,
        [actionId, nextStatus],
      );

      const { rows } = await client.query(
        `
          INSERT INTO recommendation_feedback (
            recommendation_id,
            shown,
            accepted,
            rejected,
            rejection_reason,
            executed,
            deal_result,
            effect_after_1_day,
            effect_after_3_days,
            effect_after_7_days,
            effect_after_30_days
          )
          VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
          RETURNING
            recommendation_id AS action_id,
            shown,
            accepted,
            rejected,
            rejection_reason,
            executed,
            deal_result,
            effect_after_1_day,
            effect_after_3_days,
            effect_after_7_days,
            effect_after_30_days,
            deal_result AS result_after_days,
            created_at AS recorded_at
        `,
        [
          actionId,
          shown,
          accepted,
          rejected,
          payload.rejection_reason ?? null,
          executed,
          payload.deal_result ?? payload.result_after_days ?? null,
          payload.effect_after_1_day ?? null,
          payload.effect_after_3_days ?? null,
          payload.effect_after_7_days ?? null,
          payload.effect_after_30_days ?? null,
        ],
      );

      return rows[0] ?? null;
    });
  }

  async listFeedback() {
    const { rows } = await query(
      `
        SELECT
          recommendation_id AS action_id,
          shown,
          accepted,
          rejected,
          rejection_reason,
          executed,
          deal_result,
          effect_after_1_day,
          effect_after_3_days,
          effect_after_7_days,
          effect_after_30_days,
          deal_result AS result_after_days,
          created_at AS recorded_at
        FROM recommendation_feedback
        ORDER BY created_at DESC
      `,
    );

    return rows;
  }

  async listFeedbackForOpportunity(opportunityId) {
    const { rows } = await query(
      `
        SELECT
          rf.recommendation_id AS action_id,
          rf.recommendation_id,
          o.external_opportunity_id AS opportunity_id,
          r.action_code,
          rf.shown,
          rf.accepted,
          rf.rejected,
          rf.rejection_reason,
          rf.executed,
          rf.deal_result,
          rf.effect_after_1_day,
          rf.effect_after_3_days,
          rf.effect_after_7_days,
          rf.effect_after_30_days,
          rf.created_at AS recorded_at
        FROM recommendation_feedback rf
        JOIN recommendations r ON r.id = rf.recommendation_id
        JOIN opportunities o ON o.id = r.opportunity_id
        WHERE o.external_opportunity_id = $1 OR o.id::text = $1
        ORDER BY rf.created_at DESC
      `,
      [opportunityId],
    );

    return rows;
  }

  async getFeedbackLearningSummary(limit = 10) {
    const feedbackResult = await query(
      `
        SELECT
          rf.recommendation_id AS action_id,
          rf.shown,
          rf.accepted,
          rf.rejected,
          rf.rejection_reason,
          rf.executed,
          rf.created_at AS recorded_at,
          r.action_code,
          o.external_opportunity_id AS opportunity_id,
          c.raw_name AS company
        FROM recommendation_feedback rf
        JOIN recommendations r ON r.id = rf.recommendation_id
        JOIN opportunities o ON o.id = r.opportunity_id
        LEFT JOIN companies c ON c.id = o.company_id
        ORDER BY rf.created_at DESC
      `,
    );

    const recommendationCountResult = await query('SELECT COUNT(*)::int AS total FROM recommendations');
    const feedback = feedbackResult.rows;
    const totalFeedback = feedback.length;
    const totalRecommendations = recommendationCountResult.rows[0]?.total ?? 0;

    const accepted = feedback.filter((item) => item.accepted).length;
    const executed = feedback.filter((item) => item.executed).length;
    const rejected = feedback.filter((item) => item.rejected).length;

    const actionStats = new Map();
    const rejectionReasons = new Map();

    for (const item of feedback) {
      const actionCode = item.action_code ?? 'unknown';
      const current = actionStats.get(actionCode) ?? {
        action_code: actionCode,
        total: 0,
        accepted: 0,
        executed: 0,
        rejected: 0,
      };
      current.total += 1;
      if (item.accepted) current.accepted += 1;
      if (item.executed) current.executed += 1;
      if (item.rejected) current.rejected += 1;
      actionStats.set(actionCode, current);

      if (item.rejection_reason) {
        rejectionReasons.set(item.rejection_reason, (rejectionReasons.get(item.rejection_reason) ?? 0) + 1);
      }
    }

    const actionMetrics = Array.from(actionStats.values())
      .map((item) => ({
        ...item,
        accepted_rate: item.total ? roundRate(item.accepted / item.total) : 0,
        executed_rate: item.total ? roundRate(item.executed / item.total) : 0,
        rejected_rate: item.total ? roundRate(item.rejected / item.total) : 0,
      }))
      .map(buildLearningInsight)
      .sort((left, right) => right.total - left.total)
      .slice(0, limit);
    const rankedInsights = actionMetrics
      .slice()
      .sort((left, right) => right.learning_score - left.learning_score);
    const topPromote = rankedInsights.find((item) => item.learning_state === 'promote') ?? null;
    const topSuppress = rankedInsights
      .slice()
      .reverse()
      .find((item) => item.learning_state === 'suppress') ?? null;
    const learningReadiness = totalFeedback >= 8
      ? 'active'
      : totalFeedback >= 3
        ? 'warming'
        : 'cold';

    return {
      summary: {
        total_feedback: totalFeedback,
        accepted_rate: totalFeedback ? roundRate(accepted / totalFeedback) : 0,
        executed_rate: totalFeedback ? roundRate(executed / totalFeedback) : 0,
        rejected_rate: totalFeedback ? roundRate(rejected / totalFeedback) : 0,
        recommendation_coverage: totalRecommendations ? roundRate(totalFeedback / totalRecommendations) : 0,
        learning_readiness: learningReadiness,
        top_promote_action: topPromote?.action_code ?? null,
        top_suppress_action: topSuppress?.action_code ?? null,
      },
      action_metrics: actionMetrics,
      learning_insights: rankedInsights.slice(0, limit).map((item) => ({
        action_code: item.action_code,
        learning_state: item.learning_state,
        learning_score: item.learning_score,
        guidance: item.guidance,
      })),
      rejection_reasons: Array.from(rejectionReasons.entries())
        .map(([reason, total]) => ({ reason, total }))
        .sort((left, right) => right.total - left.total)
        .slice(0, limit),
      recent_feedback: feedback.slice(0, limit).map((item) => {
        let status = 'shown';
        if (item.executed) status = 'executed';
        else if (item.accepted) status = 'accepted';
        else if (item.rejected) status = 'rejected';

        return {
          action_id: item.action_id,
          action_code: item.action_code ?? null,
          opportunity_id: item.opportunity_id ?? null,
          company: item.company ?? null,
          status,
          recorded_at: item.recorded_at,
        };
      }),
    };
  }

  async persistStateEvaluation(opportunity, stateEvaluation) {
    return withTransaction(async (client) => {
      const { rows } = await client.query(
        `
          SELECT id
          FROM opportunities
          WHERE external_opportunity_id = $1 OR id::text = $1
          LIMIT 1
        `,
        [opportunity.id],
      );

      const opportunityRow = rows[0];
      if (!opportunityRow) {
        throw new Error(`Opportunity ${opportunity.id} not found in PostgreSQL.`);
      }

      const opportunityDbId = opportunityRow.id;

      await client.query(
        `
          UPDATE opportunities
          SET
            priority_score = $2,
            need_score = $3,
            time_score = $4,
            spec_score = $5,
            access_score = $6,
            money_score = $7,
            fit_score = $8,
            updated_at = NOW()
          WHERE id = $1
        `,
        [
          opportunityDbId,
          stateEvaluation.priority_score,
          stateEvaluation.scores.need,
          stateEvaluation.scores.time,
          stateEvaluation.scores.spec,
          stateEvaluation.scores.access,
          stateEvaluation.scores.money,
          stateEvaluation.scores.fit,
        ],
      );

      await client.query('DELETE FROM state_snapshots WHERE opportunity_id = $1', [opportunityDbId]);

      for (const state of stateEvaluation.states) {
        await client.query(
          `
            INSERT INTO state_snapshots (
              opportunity_id,
              state_code,
              confidence_score,
              reason,
              snapshot_time
            )
            VALUES ($1, $2, $3, $4, $5)
          `,
          [
            opportunityDbId,
            state.state_code,
            state.confidence_score,
            state.reason,
            state.timestamp,
          ],
        );
      }

      return {
        opportunity_id: opportunity.id,
        persisted: true,
        state_evaluation: stateEvaluation,
      };
    });
  }

  async persistDecisionEvaluation(opportunity, stateEvaluation, decisionEvaluation) {
    return withTransaction(async (client) => {
      const { rows } = await client.query(
        `
          SELECT id
          FROM opportunities
          WHERE external_opportunity_id = $1 OR id::text = $1
          LIMIT 1
        `,
        [opportunity.id],
      );

      const opportunityRow = rows[0];
      if (!opportunityRow) {
        throw new Error(`Opportunity ${opportunity.id} not found in PostgreSQL.`);
      }

      const opportunityDbId = opportunityRow.id;
      const actionCode = decisionEvaluation.recommended_action?.action_code ?? null;
      const targetRole = decisionEvaluation.recommended_action?.target_role ?? 'sales_manager';
      const explainabilityJson = JSON.stringify(decisionEvaluation.explainability);

      const existing = await client.query(
        `
          SELECT
            id,
            action_code,
            target_role,
            deadline_at,
            escalation_action_code,
            explainability_json,
            status
          FROM recommendations
          WHERE opportunity_id = $1
          ORDER BY created_at DESC
          LIMIT 1
        `,
        [opportunityDbId],
      );

      const latest = existing.rows[0];
      const sameRecommendation = latest
        && latest.action_code === actionCode
        && latest.escalation_action_code === (decisionEvaluation.escalation_action?.action_code ?? null)
        && JSON.stringify(latest.explainability_json) === explainabilityJson;

      if (sameRecommendation) {
        await client.query(
          `
            UPDATE recommendations
            SET
              deadline_at = $2,
              updated_at = NOW()
            WHERE id = $1
          `,
          [latest.id, decisionEvaluation.deadline_at],
        );

        return {
          recommendation_id: latest.id,
          status: latest.status,
          deadline_at: decisionEvaluation.deadline_at,
          state_evaluation: stateEvaluation,
          decision_evaluation: decisionEvaluation,
        };
      }

      const inserted = await client.query(
        `
          INSERT INTO recommendations (
            opportunity_id,
            action_code,
            target_role,
            deadline_at,
            escalation_action_code,
            explainability_json,
            status
          )
          VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'draft')
          RETURNING id, status, deadline_at
        `,
        [
          opportunityDbId,
          actionCode,
          targetRole,
          decisionEvaluation.deadline_at,
          decisionEvaluation.escalation_action?.action_code ?? null,
          explainabilityJson,
        ],
      );

      const created = inserted.rows[0];
      return {
        recommendation_id: created.id,
        status: created.status,
        deadline_at: created.deadline_at,
        state_evaluation: stateEvaluation,
        decision_evaluation: decisionEvaluation,
      };
    });
  }

  async seedFromSamples(sampleOpportunities) {
    return withTransaction(async (client) => {
      for (const sample of sampleOpportunities) {
        const companyResult = await client.query(
          `
            INSERT INTO companies (bitrix_company_id, raw_name, normalized_name, confidence_score)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (bitrix_company_id)
            DO UPDATE SET
              raw_name = EXCLUDED.raw_name,
              normalized_name = EXCLUDED.normalized_name,
              confidence_score = EXCLUDED.confidence_score,
              updated_at = NOW()
            RETURNING id
          `,
          [
            `bitrix-company-${sample.company?.resolved_entity_id ?? sample.id}`,
            sample.company?.raw_value ?? 'Unknown company',
            sample.company?.normalized_value ?? null,
            sample.company?.confidence_score ?? null,
          ],
        );
        const companyId = companyResult.rows[0].id;

        let personId = null;
        if (sample.contact_person?.raw_value) {
          const personResult = await client.query(
            `
              INSERT INTO persons (
                bitrix_contact_id,
                company_id,
                raw_name,
                normalized_name,
                role_name,
                influence_score,
                trust_score,
                confidence_score
              )
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
              ON CONFLICT (bitrix_contact_id)
              DO UPDATE SET
                company_id = EXCLUDED.company_id,
                raw_name = EXCLUDED.raw_name,
                normalized_name = EXCLUDED.normalized_name,
                role_name = EXCLUDED.role_name,
                influence_score = EXCLUDED.influence_score,
                trust_score = EXCLUDED.trust_score,
                confidence_score = EXCLUDED.confidence_score,
                updated_at = NOW()
              RETURNING id
            `,
            [
              `bitrix-contact-${sample.contact_person.resolved_entity_id ?? sample.id}`,
              companyId,
              sample.contact_person.raw_value,
              sample.contact_person.normalized_value,
              sample.contact_person.role ?? null,
              sample.contact_person.influence_score ?? null,
              sample.contact_person.trust_score ?? null,
              sample.contact_person.confidence_score ?? null,
            ],
          );
          personId = personResult.rows[0].id;
        }

        let projectObjectId = null;
        if (sample.project_object?.raw_value) {
          const objectResult = await client.query(
            `
              INSERT INTO project_objects (
                external_object_id,
                raw_name,
                normalized_name,
                address_raw,
                address_normalized,
                confidence_score
              )
              VALUES ($1, $2, $3, $4, $5, $6)
              ON CONFLICT (external_object_id)
              DO UPDATE SET
                raw_name = EXCLUDED.raw_name,
                normalized_name = EXCLUDED.normalized_name,
                address_raw = EXCLUDED.address_raw,
                address_normalized = EXCLUDED.address_normalized,
                confidence_score = EXCLUDED.confidence_score,
                updated_at = NOW()
              RETURNING id
            `,
            [
              sample.project_object.resolved_entity_id ?? `object-${sample.id}`,
              sample.project_object.raw_value,
              sample.project_object.normalized_value,
              sample.address?.raw_value ?? null,
              sample.address?.normalized_value ?? null,
              sample.project_object.confidence_score ?? null,
            ],
          );
          projectObjectId = objectResult.rows[0].id;
        }

        let equipmentTypeId = null;
        if (sample.equipment_type?.normalized_value) {
          const equipmentCode = sample.equipment_type.normalized_value.toLowerCase().replace(/\s+/g, '_');
          const equipmentResult = await client.query(
            `
              INSERT INTO equipment_types (code, type_name)
              VALUES ($1, $2)
              ON CONFLICT (code)
              DO UPDATE SET
                type_name = EXCLUDED.type_name,
                updated_at = NOW()
              RETURNING id
            `,
            [equipmentCode, sample.equipment_type.normalized_value],
          );
          equipmentTypeId = equipmentResult.rows[0].id;
        }

        const opportunityResult = await client.query(
          `
            INSERT INTO opportunities (
              external_opportunity_id,
              bitrix_deal_id,
              status,
              company_id,
              person_id,
              project_object_id,
              equipment_type_id,
              commercial_scenario,
              decision_access_status,
              commercial_stage,
              payment_readiness,
              requested_start_at,
              requested_duration_days,
              strategy_weight,
              sla_hours,
              expected_margin_percent,
              own_equipment_available,
              subrent_required,
              debt_overdue_days,
              credit_limit_blocked,
              client_blacklisted,
              last_touch_at,
              next_step_code,
              next_step_due_at,
              next_step_description
            )
            VALUES (
              $1, $2, 'qualified', $3, $4, $5, $6, $7, $8, $9, $10,
              $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24
            )
            ON CONFLICT (external_opportunity_id)
            DO UPDATE SET
              bitrix_deal_id = EXCLUDED.bitrix_deal_id,
              company_id = EXCLUDED.company_id,
              person_id = EXCLUDED.person_id,
              project_object_id = EXCLUDED.project_object_id,
              equipment_type_id = EXCLUDED.equipment_type_id,
              commercial_scenario = EXCLUDED.commercial_scenario,
              decision_access_status = EXCLUDED.decision_access_status,
              commercial_stage = EXCLUDED.commercial_stage,
              payment_readiness = EXCLUDED.payment_readiness,
              requested_start_at = EXCLUDED.requested_start_at,
              requested_duration_days = EXCLUDED.requested_duration_days,
              strategy_weight = EXCLUDED.strategy_weight,
              sla_hours = EXCLUDED.sla_hours,
              expected_margin_percent = EXCLUDED.expected_margin_percent,
              own_equipment_available = EXCLUDED.own_equipment_available,
              subrent_required = EXCLUDED.subrent_required,
              debt_overdue_days = EXCLUDED.debt_overdue_days,
              credit_limit_blocked = EXCLUDED.credit_limit_blocked,
              client_blacklisted = EXCLUDED.client_blacklisted,
              last_touch_at = EXCLUDED.last_touch_at,
              next_step_code = EXCLUDED.next_step_code,
              next_step_due_at = EXCLUDED.next_step_due_at,
              next_step_description = EXCLUDED.next_step_description,
              updated_at = NOW()
            RETURNING id
          `,
          [
            sample.id,
            sample.bitrix_deal_id,
            companyId,
            personId,
            projectObjectId,
            equipmentTypeId,
            sample.commercial_scenario ?? null,
            sample.decision_access_status ?? null,
            sample.commercial_stage ?? null,
            sample.payment_readiness ?? null,
            sample.time_window?.start_at ?? null,
            sample.time_window?.duration_days ?? null,
            sample.strategy_weight ?? 1,
            sample.sla_hours ?? 4,
            sample.economic_assessment?.expected_margin_percent ?? null,
            sample.economic_assessment?.own_equipment_available ?? null,
            sample.economic_assessment?.subrent_required ?? null,
            sample.financial_risk?.debt_overdue_days ?? null,
            sample.financial_risk?.credit_limit_blocked ?? false,
            sample.financial_risk?.client_blacklisted ?? false,
            sample.last_touch_at ?? null,
            sample.next_step?.code ?? null,
            sample.next_step?.due_at ?? null,
            sample.next_step?.description ?? null,
          ],
        );
        const opportunityId = opportunityResult.rows[0].id;

        await client.query('DELETE FROM opportunity_technical_requirements WHERE opportunity_id = $1', [opportunityId]);
        for (const requirement of sample.technical_requirements ?? []) {
          await client.query(
            'INSERT INTO opportunity_technical_requirements (opportunity_id, requirement_value) VALUES ($1, $2)',
            [opportunityId, requirement],
          );
        }

        await client.query('DELETE FROM communication_events WHERE opportunity_id = $1', [opportunityId]);
        for (const event of sample.communication_events ?? []) {
          await client.query(
            `
              INSERT INTO communication_events (
                external_event_id,
                opportunity_id,
                company_id,
                person_id,
                project_object_id,
                event_type,
                event_datetime,
                channel,
                summary_text,
                raw_text
              )
              VALUES ($1, $2, $3, $4, $5, $6, NOW(), $7, $8, $9)
            `,
            [
              event.id,
              opportunityId,
              companyId,
              personId,
              projectObjectId,
              event.type,
              event.channel,
              event.summary ?? null,
              event.text ?? null,
            ],
          );
        }
      }
    });
  }

  async saveIngestEvent(payload) {
    const normalized = normalizeBitrixEvent(payload);
    const sourceEventId = `${normalized.entity_type}:${normalized.entity_id}:${normalized.event_type}`;
    const { rows } = await query(
      `
        INSERT INTO ingest_events (
          source_system,
          source_event_type,
          source_event_id,
          payload,
          processing_status
        )
        VALUES ($1, $2, $3, $4::jsonb, 'pending')
        RETURNING *
      `,
      [
        normalized.source,
        normalized.event_type,
        sourceEventId,
        JSON.stringify(normalized),
      ],
    );

    return rows[0];
  }

  async listPendingIngestEvents(limit = 50) {
    const { rows } = await query(
      `
        SELECT *
        FROM ingest_events
        WHERE processing_status = 'pending'
        ORDER BY created_at ASC
        LIMIT $1
      `,
      [limit],
    );

    return rows;
  }

  async retryIngestEvents({ statuses = ['failed', 'suspicious'], limit = 50 } = {}) {
    const { rows } = await query(
      `
        WITH picked AS (
          SELECT id
          FROM ingest_events
          WHERE processing_status = ANY($1::text[])
          ORDER BY updated_at DESC
          LIMIT $2
        )
        UPDATE ingest_events ie
        SET
          processing_status = 'pending',
          error_message = NULL,
          retry_count = retry_count + 1,
          updated_at = NOW()
        FROM picked
        WHERE ie.id = picked.id
        RETURNING ie.*
      `,
      [statuses, limit],
    );

    return {
      retried_count: rows.length,
      items: rows,
    };
  }

  async processPendingIngestEvents(limit = 50) {
    await ensureOpportunityEnrichmentSchema();
    const pending = await this.listPendingIngestEvents(limit);
    const processed = [];

    for (const ingestEvent of pending) {
      try {
        const result = await this.applyBitrixEntityPatch(ingestEvent);
        const recalculated = result.opportunity_external_id
          ? await this.refreshOpportunityAfterIngest(result.opportunity_external_id)
          : null;
        const suspicious = result.match_diagnostics?.suspicious === true;
        await query(
          `
            UPDATE ingest_events
            SET
              processing_status = $2,
              error_message = $3,
              updated_at = NOW()
            WHERE id = $1
          `,
          [
            ingestEvent.id,
            suspicious ? 'suspicious' : 'processed',
            suspicious
              ? `Suspicious ${result.match_diagnostics.match_type} match (score=${result.match_diagnostics.match_score})${(result.match_diagnostics.alias_matches ?? []).length ? ` · accepted normalization alias: ${(result.match_diagnostics.alias_matches ?? []).join(', ')}` : ''}`
              : (result.match_diagnostics.alias_matches ?? []).length
                ? `Accepted normalization alias used: ${(result.match_diagnostics.alias_matches ?? []).join(', ')}`
                : null,
          ],
        );

        processed.push({
          ingest_event_id: ingestEvent.id,
          ...result,
          recalculated,
          suspicious,
        });
      } catch (error) {
        await query(
          `
            UPDATE ingest_events
            SET
              processing_status = 'failed',
              error_message = $2,
              retry_count = retry_count + 1,
              updated_at = NOW()
            WHERE id = $1
          `,
          [ingestEvent.id, error instanceof Error ? error.message : String(error)],
        );
      }
    }

    return {
      processed_count: processed.length,
      processed,
    };
  }

  async applyBitrixEntityPatch(ingestEvent) {
    const event = ingestEvent.payload;
    const patch = buildBitrixEntityPatch(event);

    return withTransaction(async (client) => {
      await insertNormalizationResults(client, patch, event);

      if (patch.kind === 'company') {
        await client.query(
          `
            INSERT INTO companies (
              bitrix_company_id,
              raw_name,
              normalized_name,
              confidence_score
            )
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (bitrix_company_id)
            DO UPDATE SET
              raw_name = EXCLUDED.raw_name,
              normalized_name = EXCLUDED.normalized_name,
              confidence_score = EXCLUDED.confidence_score,
              updated_at = NOW()
          `,
          [
            patch.external_id,
            patch.company.raw_value,
            patch.company.normalized_value,
            patch.company.confidence_score,
          ],
        );

        return { kind: patch.kind, external_id: patch.external_id, opportunity_external_id: null };
      }

      if (patch.kind === 'contact') {
        let companyId = null;
        if (patch.company_external_id) {
          const company = await client.query(
            `
              INSERT INTO companies (bitrix_company_id, raw_name, normalized_name, confidence_score)
              VALUES ($1, $2, $3, $4)
              ON CONFLICT (bitrix_company_id)
              DO UPDATE SET updated_at = NOW()
              RETURNING id
            `,
            [
              String(patch.company_external_id),
              `Компания ${patch.company_external_id}`,
              `компания ${patch.company_external_id}`,
              0.3,
            ],
          );
          companyId = company.rows[0].id;
        }

        await client.query(
          `
            INSERT INTO persons (
              bitrix_contact_id,
              company_id,
              raw_name,
              normalized_name,
              phone,
              role_name,
              confidence_score
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (bitrix_contact_id)
            DO UPDATE SET
              company_id = EXCLUDED.company_id,
              raw_name = EXCLUDED.raw_name,
              normalized_name = EXCLUDED.normalized_name,
              phone = EXCLUDED.phone,
              role_name = EXCLUDED.role_name,
              confidence_score = EXCLUDED.confidence_score,
              updated_at = NOW()
          `,
          [
            patch.external_id,
            companyId,
            patch.person.raw_value,
            patch.person.normalized_value,
            patch.person.phone ?? null,
            patch.person.role ?? null,
            patch.person.confidence_score,
          ],
        );

        return { kind: patch.kind, external_id: patch.external_id, opportunity_external_id: null };
      }

      if (patch.kind === 'deal') {
        let companyId = null;
        if (patch.company_external_id || patch.company?.raw_value) {
          const companyName = patch.company ?? {
            raw_value: `Компания ${patch.company_external_id}`,
            normalized_value: `компания ${patch.company_external_id}`,
            confidence_score: 0.3,
          };
          const company = await client.query(
            `
              INSERT INTO companies (bitrix_company_id, raw_name, normalized_name, confidence_score)
              VALUES ($1, $2, $3, $4)
              ON CONFLICT (bitrix_company_id)
              DO UPDATE SET
                raw_name = EXCLUDED.raw_name,
                normalized_name = EXCLUDED.normalized_name,
                confidence_score = EXCLUDED.confidence_score,
                updated_at = NOW()
              RETURNING id
            `,
            [
              String(patch.company_external_id ?? patch.company?.resolved_entity_id ?? `derived-company:${patch.external_id}`),
              companyName.raw_value,
              companyName.normalized_value,
              companyName.confidence_score,
            ],
          );
          companyId = company.rows[0].id;
        }

        let personId = null;
        if (patch.contact_external_id) {
          const person = await client.query(
            `
              INSERT INTO persons (bitrix_contact_id, company_id, raw_name, normalized_name, confidence_score)
              VALUES ($1, $2, $3, $4, $5)
              ON CONFLICT (bitrix_contact_id)
              DO UPDATE SET
                company_id = EXCLUDED.company_id,
                updated_at = NOW()
              RETURNING id
            `,
            [
              String(patch.contact_external_id),
              companyId,
              `Контакт ${patch.contact_external_id}`,
              `контакт ${patch.contact_external_id}`,
              0.25,
            ],
          );
          personId = person.rows[0].id;
        } else if (patch.person?.raw_value) {
          const person = await client.query(
            `
              INSERT INTO persons (
                bitrix_contact_id,
                company_id,
                raw_name,
                normalized_name,
                role_name,
                confidence_score
              )
              VALUES ($1, $2, $3, $4, $5, $6)
              ON CONFLICT (bitrix_contact_id)
              DO UPDATE SET
                company_id = EXCLUDED.company_id,
                raw_name = EXCLUDED.raw_name,
                normalized_name = EXCLUDED.normalized_name,
                role_name = EXCLUDED.role_name,
                confidence_score = EXCLUDED.confidence_score,
                updated_at = NOW()
              RETURNING id
            `,
            [
              patch.person.resolved_entity_id ?? `derived-contact:${patch.external_id}`,
              companyId,
              patch.person.raw_value,
              patch.person.normalized_value,
              patch.person.role ?? null,
              patch.person.confidence_score ?? null,
            ],
          );
          personId = person.rows[0].id;
        }

        let projectObjectId = null;
        if (patch.project_object?.raw_value) {
          const object = await client.query(
            `
              INSERT INTO project_objects (
                external_object_id,
                raw_name,
                normalized_name,
                address_raw,
                address_normalized,
                confidence_score
              )
              VALUES ($1, $2, $3, $4, $5, $6)
              ON CONFLICT (external_object_id)
              DO UPDATE SET
                raw_name = EXCLUDED.raw_name,
                normalized_name = EXCLUDED.normalized_name,
                address_raw = EXCLUDED.address_raw,
                address_normalized = EXCLUDED.address_normalized,
                confidence_score = EXCLUDED.confidence_score,
                updated_at = NOW()
              RETURNING id
            `,
            [
              patch.project_object.resolved_entity_id ?? `bitrix-object:${patch.external_id}`,
              patch.project_object.raw_value,
              patch.project_object.normalized_value,
              patch.address?.raw_value ?? null,
              patch.address?.normalized_value ?? null,
              patch.project_object.confidence_score,
            ],
          );
          projectObjectId = object.rows[0].id;
        }

        let equipmentTypeId = null;
        if (patch.equipment_type?.normalized_value) {
          const equipmentCode = patch.equipment_type.normalized_value.toLowerCase().replace(/\s+/g, '_');
          const equipment = await client.query(
            `
              INSERT INTO equipment_types (code, type_name)
              VALUES ($1, $2)
              ON CONFLICT (code)
              DO UPDATE SET
                type_name = EXCLUDED.type_name,
                updated_at = NOW()
              RETURNING id
            `,
            [equipmentCode, patch.equipment_type.normalized_value],
          );
          equipmentTypeId = equipment.rows[0].id;
        }

        let ownerManagerId = null;
        if (patch.owner_manager_external_id) {
          const manager = await client.query(
            `
              INSERT INTO users (external_id, full_name, role_code, active)
              VALUES ($1, $2, $3, true)
              ON CONFLICT (external_id)
              DO UPDATE SET
                full_name = EXCLUDED.full_name,
                role_code = EXCLUDED.role_code,
                updated_at = NOW()
              RETURNING id
            `,
            [
              String(patch.owner_manager_external_id),
              patch.owner_manager_name ?? `Менеджер Bitrix ${patch.owner_manager_external_id}`,
              'sales_manager',
            ],
          );
          ownerManagerId = manager.rows[0].id;
        }

        const opportunity = await client.query(
          `
            INSERT INTO opportunities (
              external_opportunity_id,
              bitrix_deal_id,
              status,
              company_id,
              person_id,
              project_object_id,
              equipment_type_id,
              equipment_model,
              owner_manager_id,
              commercial_scenario,
              decision_access_status,
              commercial_stage,
              payment_readiness,
              requested_start_at,
              requested_duration_days,
              work_conditions_json,
              price_context_json,
              client_expected_next_step,
              geo_hint_json,
              readiness_signals_json,
              expected_margin_percent,
              own_equipment_available,
              subrent_required,
              debt_overdue_days,
              credit_limit_blocked,
              client_blacklisted,
              last_touch_at,
              next_step_code,
              next_step_due_at,
              next_step_description,
              need_score,
              time_score,
              spec_score,
              access_score,
              money_score,
              fit_score
            )
            VALUES (
              $1, $2, 'qualified', $3, $4, $5, $6, $7, $8, $9, $10, $11,
              $12, $13, $14, $15::jsonb, $16::jsonb, $17, $18::jsonb, $19::jsonb,
              $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31,
              $32, $33, $34, $35
            )
            ON CONFLICT (external_opportunity_id)
            DO UPDATE SET
              company_id = EXCLUDED.company_id,
              person_id = EXCLUDED.person_id,
              project_object_id = EXCLUDED.project_object_id,
              equipment_type_id = EXCLUDED.equipment_type_id,
              equipment_model = EXCLUDED.equipment_model,
              owner_manager_id = EXCLUDED.owner_manager_id,
              commercial_scenario = EXCLUDED.commercial_scenario,
              decision_access_status = EXCLUDED.decision_access_status,
              commercial_stage = EXCLUDED.commercial_stage,
              payment_readiness = EXCLUDED.payment_readiness,
              requested_start_at = EXCLUDED.requested_start_at,
              requested_duration_days = EXCLUDED.requested_duration_days,
              work_conditions_json = EXCLUDED.work_conditions_json,
              price_context_json = EXCLUDED.price_context_json,
              client_expected_next_step = EXCLUDED.client_expected_next_step,
              geo_hint_json = EXCLUDED.geo_hint_json,
              readiness_signals_json = EXCLUDED.readiness_signals_json,
              expected_margin_percent = EXCLUDED.expected_margin_percent,
              own_equipment_available = EXCLUDED.own_equipment_available,
              subrent_required = EXCLUDED.subrent_required,
              debt_overdue_days = EXCLUDED.debt_overdue_days,
              credit_limit_blocked = EXCLUDED.credit_limit_blocked,
              client_blacklisted = EXCLUDED.client_blacklisted,
              last_touch_at = EXCLUDED.last_touch_at,
              next_step_code = EXCLUDED.next_step_code,
              next_step_due_at = EXCLUDED.next_step_due_at,
              next_step_description = EXCLUDED.next_step_description,
              need_score = EXCLUDED.need_score,
              time_score = EXCLUDED.time_score,
              spec_score = EXCLUDED.spec_score,
              access_score = EXCLUDED.access_score,
              money_score = EXCLUDED.money_score,
              fit_score = EXCLUDED.fit_score,
              updated_at = NOW()
            RETURNING id
          `,
          [
            patch.external_id,
            patch.bitrix_deal_id,
            companyId,
            personId,
            projectObjectId,
            equipmentTypeId,
            patch.equipment_model ?? null,
            ownerManagerId,
            patch.commercial_scenario ?? null,
            patch.decision_access_status ?? null,
            patch.commercial_stage ?? null,
            patch.payment_readiness ?? null,
            patch.requested_start_at ?? null,
            patch.requested_duration_days ?? null,
            JSON.stringify(patch.work_conditions ?? []),
            patch.price_context ? JSON.stringify(patch.price_context) : null,
            patch.client_expected_next_step ?? null,
            patch.geo_hint ? JSON.stringify(patch.geo_hint) : null,
            patch.readiness_signals ? JSON.stringify(patch.readiness_signals) : null,
            patch.expected_margin_percent ?? null,
            patch.own_equipment_available ?? null,
            patch.subrent_required ?? null,
            patch.debt_overdue_days ?? null,
            patch.credit_limit_blocked ?? false,
            patch.client_blacklisted ?? false,
            patch.last_touch_at ?? null,
            patch.next_step_code ?? null,
            patch.next_step_due_at ?? null,
            patch.next_step_description ?? null,
            patch.score_overrides?.need ?? null,
            patch.score_overrides?.time ?? null,
            patch.score_overrides?.spec ?? null,
            patch.score_overrides?.access ?? null,
            patch.score_overrides?.money ?? null,
            patch.score_overrides?.fit ?? null,
          ],
        );

        const opportunityId = opportunity.rows[0].id;
        await client.query('DELETE FROM opportunity_technical_requirements WHERE opportunity_id = $1', [opportunityId]);
        for (const requirement of patch.technical_requirements ?? []) {
          await client.query(
            'INSERT INTO opportunity_technical_requirements (opportunity_id, requirement_value) VALUES ($1, $2)',
            [opportunityId, requirement],
          );
        }

        return {
          kind: patch.kind,
          external_id: patch.external_id,
          opportunity_external_id: patch.external_id,
        };
      }

      if (patch.kind === 'communication_event') {
        const resolution = await resolveOpportunityDbId(client, patch);
        const opportunityId = resolution?.id ?? null;

        if (!opportunityId) {
          throw new Error(`Unable to resolve opportunity for communication event ${patch.external_id}`);
        }

        await client.query(
          `
            INSERT INTO communication_events (
              external_event_id,
              opportunity_id,
              event_type,
              event_datetime,
              channel,
              summary_text,
              raw_text,
              extraction_json
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
            ON CONFLICT (external_event_id)
            DO UPDATE SET
              opportunity_id = EXCLUDED.opportunity_id,
              event_type = EXCLUDED.event_type,
              event_datetime = EXCLUDED.event_datetime,
              channel = EXCLUDED.channel,
              summary_text = EXCLUDED.summary_text,
              raw_text = EXCLUDED.raw_text,
              extraction_json = EXCLUDED.extraction_json
          `,
          [
            patch.external_id,
            opportunityId,
            patch.event_type,
            patch.event_datetime ?? new Date().toISOString(),
            patch.channel,
            patch.summary_text ?? null,
            patch.raw_text ?? null,
            JSON.stringify(patch.extraction_json ?? {}),
          ],
        );

        await enrichOpportunityFromCommunicationPatch(client, opportunityId, patch);

        return {
          kind: patch.kind,
          external_id: patch.external_id,
          opportunity_external_id: patch.opportunity_external_id ? String(patch.opportunity_external_id) : null,
          match_diagnostics: resolution,
        };
      }

      return { kind: patch.kind, external_id: patch.external_id, opportunity_external_id: null };
    });
  }

  async refreshOpportunityAfterIngest(opportunityExternalId) {
    if (!opportunityExternalId) {
      return null;
    }

    const opportunity = await this.getOpportunityById(opportunityExternalId);
    if (!opportunity) {
      return null;
    }

    const stateEvaluation = evaluateOpportunityState(opportunity);
    await this.persistStateEvaluation(opportunity, stateEvaluation);
    const decisionEvaluation = decideNextAction(stateEvaluation);
    await this.persistDecisionEvaluation(opportunity, stateEvaluation, decisionEvaluation);

    return {
      opportunity_id: opportunity.id,
      priority_score: stateEvaluation.priority_score,
      recommended_action: decisionEvaluation.recommended_action?.action_code ?? null,
    };
  }
}
