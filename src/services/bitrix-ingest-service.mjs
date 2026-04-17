import {
  normalizeAddress,
  normalizeCompanyName,
  normalizeEquipmentType,
  normalizeObjectName,
  normalizePersonName,
} from '../dss/normalization.mjs';
import { extractEntitiesFromText } from '../dss/nlp-extraction.mjs';

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value !== null && value !== undefined && String(value).trim() !== '') {
      return value;
    }
  }

  return null;
}

function asArray(value) {
  if (!value) {
    return [];
  }

  return Array.isArray(value) ? value : [value];
}

function cleanupNumber(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function toIsoDate(value) {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed.toISOString();
}

function getRecord(event) {
  return event.payload?.fields
    ?? event.payload?.data?.FIELDS
    ?? event.payload?.data
    ?? event.payload;
}

function getContactRawName(record) {
  return firstNonEmpty(
    record.FULL_NAME,
    [record.NAME, record.LAST_NAME].filter(Boolean).join(' ').trim(),
    record.TITLE,
  );
}

function isDealOwnerType(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  return normalized === 'deal' || normalized === '2';
}

function deriveCommercialStage(stageId, textSignals) {
  const stage = String(stageId ?? '').toLowerCase();
  if (stage.includes('won')) return 'won';
  if (stage.includes('lose')) return 'lost';
  if (textSignals.money_readiness.value === 'commercial' && textSignals.next_touch_hint?.toLowerCase().includes('договор')) {
    return 'contract_requested';
  }
  if (textSignals.money_readiness.value === 'commercial') {
    return 'offer_requested';
  }
  return 'qualified';
}

function buildFallbackCompanyName(record, event) {
  const maturityStage = firstNonEmpty(record.UF_CRM_MATURITY_STAGE, 'Без стадии');
  return `Тестовый клиент Bitrix (${maturityStage})`;
}

function mapEventTypeToChannel(entityType) {
  if (entityType === 'comment') return 'bitrix_comment';
  if (entityType === 'activity') return 'bitrix_activity';
  if (entityType === 'task') return 'bitrix_task';
  return 'bitrix_event';
}

export function normalizeBitrixEvent(payload) {
  return {
    source: payload.source ?? 'bitrix24',
    entity_type: payload.entity_type,
    entity_id: String(payload.entity_id),
    event_type: payload.event_type ?? 'updated',
    occurred_at: payload.occurred_at ?? new Date().toISOString(),
    payload: payload.payload ?? {},
  };
}

export function buildBitrixEntityPatch(event) {
  const record = getRecord(event);

  if (event.entity_type === 'company') {
    const companyName = normalizeCompanyName(firstNonEmpty(record.TITLE, record.COMPANY_TITLE, `Компания ${event.entity_id}`));
    return {
      kind: 'company',
      external_id: String(record.ID ?? event.entity_id),
      company: companyName,
    };
  }

  if (event.entity_type === 'contact') {
    const person = normalizePersonName(firstNonEmpty(getContactRawName(record), `Контакт ${event.entity_id}`));
    return {
      kind: 'contact',
      external_id: String(record.ID ?? event.entity_id),
      company_external_id: firstNonEmpty(record.COMPANY_ID, record.COMPANY?.ID),
      person: {
        ...person,
        role: firstNonEmpty(record.POST, record.ROLE),
        phone: firstNonEmpty(asArray(record.PHONE)[0]?.VALUE, record.PHONE),
      },
    };
  }

  if (event.entity_type === 'deal') {
    const freeText = [record.TITLE, record.COMMENTS, record.SOURCE_DESCRIPTION].filter(Boolean).join('\n');
    const extracted = extractEntitiesFromText(freeText);
    const companyName = record.COMPANY_TITLE
      ? normalizeCompanyName(record.COMPANY_TITLE)
      : (extracted.company ?? normalizeCompanyName(buildFallbackCompanyName(record, event)));
    const objectName = firstNonEmpty(
      record.UF_CRM_OBJECT_NAME,
      record.OBJECT,
      extracted.project_object?.raw_value,
      record.TITLE,
    );
    const equipmentName = firstNonEmpty(
      record.UF_CRM_EQUIPMENT_TYPE,
      record.EQUIPMENT_TYPE,
      extracted.equipment_type?.raw_value,
    );

    return {
      kind: 'deal',
      external_id: String(record.ID ?? event.entity_id),
      bitrix_deal_id: String(record.ID ?? event.entity_id),
      company_external_id: firstNonEmpty(record.COMPANY_ID, record.COMPANY?.ID),
      contact_external_id: firstNonEmpty(record.CONTACT_ID, record.CONTACT?.ID),
      owner_manager_external_id: firstNonEmpty(record.ASSIGNED_BY_ID, record.CREATED_BY_ID),
      owner_manager_name: firstNonEmpty(record.ASSIGNED_BY_NAME),
      company: companyName,
      person: extracted.person
        ? {
            ...extracted.person,
            role: extracted.person.raw_value?.toLowerCase().includes('лпр') ? 'ЛПР' : null,
          }
        : null,
      project_object: objectName ? normalizeObjectName(objectName) : null,
      address: firstNonEmpty(record.ADDRESS, record.UF_CRM_OBJECT_ADDRESS, extracted.address?.raw_value)
        ? normalizeAddress(firstNonEmpty(record.ADDRESS, record.UF_CRM_OBJECT_ADDRESS, extracted.address?.raw_value))
        : null,
      equipment_type: equipmentName ? normalizeEquipmentType(equipmentName) : null,
      title: firstNonEmpty(record.TITLE, `Сделка ${event.entity_id}`),
      commercial_scenario: record.TYPE_ID?.toLowerCase() === 'sale' ? 'rental' : 'mixed',
      decision_access_status: extracted.person?.raw_value?.toLowerCase().includes('лпр') ? 'decision_maker' : 'influencer',
      commercial_stage: deriveCommercialStage(record.STAGE_ID, extracted),
      payment_readiness: extracted.money_readiness.value === 'commercial' ? 'ready' : 'early',
      requested_start_at: toIsoDate(firstNonEmpty(record.BEGINDATE, record.UF_CRM_START_DATE, record.CLOSEDATE)),
      requested_duration_days: cleanupNumber(firstNonEmpty(record.UF_CRM_DURATION_DAYS, record.DURATION_DAYS)),
      expected_margin_percent: cleanupNumber(firstNonEmpty(record.UF_CRM_MARGIN_PCT, record.UF_CRM_EXPECTED_MARGIN)),
      own_equipment_available: record.UF_CRM_OWN_EQUIPMENT_AVAILABLE === 'Y' ? true : null,
      subrent_required: extracted.supply_mode === 'subrent' ? true : null,
      debt_overdue_days: cleanupNumber(record.UF_CRM_DEBT_OVERDUE_DAYS),
      credit_limit_blocked: record.UF_CRM_CREDIT_BLOCKED === 'Y',
      client_blacklisted: record.UF_CRM_BLACKLISTED === 'Y',
      last_touch_at: toIsoDate(firstNonEmpty(record.DATE_MODIFY, event.occurred_at)),
      next_step_code: extracted.next_touch_hint ? 'follow_up_reminder' : null,
      next_step_due_at: null,
      next_step_description: extracted.next_touch_hint,
      technical_requirements: [record.UF_CRM_TECH_SPECS, record.UF_CRM_WORK_CONDITIONS].filter(Boolean),
      score_overrides: {
        need: cleanupNumber(record.UF_CRM_NEED_SCORE),
        time: cleanupNumber(record.UF_CRM_TIME_SCORE),
        spec: cleanupNumber(record.UF_CRM_SPEC_SCORE),
        access: cleanupNumber(record.UF_CRM_ACCESS_SCORE),
        money: cleanupNumber(record.UF_CRM_MONEY_SCORE),
        fit: cleanupNumber(record.UF_CRM_FIT_SCORE),
        maturity_percent: cleanupNumber(record.UF_CRM_MATURITY_PERCENT),
        maturity_stage: firstNonEmpty(record.UF_CRM_MATURITY_STAGE),
      },
      extracted_signals: extracted,
    };
  }

  if (event.entity_type === 'comment' || event.entity_type === 'activity' || event.entity_type === 'task') {
    const text = firstNonEmpty(record.COMMENT, record.DESCRIPTION, record.SUBJECT, record.TEXT, '');
    const extracted = extractEntitiesFromText(text);
    const ownerType = firstNonEmpty(record.OWNER_TYPE_ID, record.ENTITY_TYPE, '');
    const explicitDealId = firstNonEmpty(record.DEAL_ID, isDealOwnerType(ownerType) ? record.OWNER_ID : null);
    return {
      kind: 'communication_event',
      external_id: String(record.ID ?? event.entity_id),
      opportunity_external_id: explicitDealId ? String(explicitDealId) : null,
      company_external_id: firstNonEmpty(record.COMPANY_ID),
      contact_external_id: firstNonEmpty(record.CONTACT_ID),
      author_external_id: firstNonEmpty(record.AUTHOR_ID, record.CREATED_BY_ID, record.RESPONSIBLE_ID),
      author_name: firstNonEmpty(record.AUTHOR_NAME),
      company: extracted.company,
      person: extracted.person,
      project_object: extracted.project_object,
      event_type: event.entity_type,
      event_datetime: toIsoDate(firstNonEmpty(record.CREATED, record.CREATED_AT, event.occurred_at)),
      channel: mapEventTypeToChannel(event.entity_type),
      summary_text: firstNonEmpty(record.SUBJECT, record.COMMENT, record.DESCRIPTION),
      raw_text: text,
      extraction_json: {
        ...extracted,
        author_external_id: firstNonEmpty(record.AUTHOR_ID, record.CREATED_BY_ID, record.RESPONSIBLE_ID),
        author_name: firstNonEmpty(record.AUTHOR_NAME),
      },
    };
  }

  return {
    kind: 'unknown',
    external_id: String(event.entity_id),
  };
}
