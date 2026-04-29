import { extractEntitiesFromText } from './nlp-extraction.mjs';
import { normalizeCommunicationEvent } from './normalization.mjs';

const SAMPLE_EVENT_TEXT = `
Клиент: ООО Строй Альянс
Контакт: Иван Петров, ЛПР
Объект: ЖК Северный Берег
Адрес: Москва, Ленинградский проспект, 37
Техника: автокран 25т
Следующий шаг: отправить КП сегодня до 16:00
Клиент просит договор и готов обсуждать аванс. Срочно, мобилизация завтра утром.
`;

const extracted = extractEntitiesFromText(SAMPLE_EVENT_TEXT);

export const opportunityStore = new Map([
  ['opp-1001', {
    id: 'opp-1001',
    bitrix_deal_id: '542',
    company: extracted.company,
    contact_person: {
      ...extracted.person,
      role: 'ЛПР',
      influence_score: 0.82,
      trust_score: 0.7,
    },
    project_object: extracted.project_object,
    address: extracted.address,
    equipment_type: extracted.equipment_type,
    equipment_model: 'Автокран 25т',
    time_window: {
      start_at: new Date(Date.now() + 18 * 3_600_000).toISOString(),
      duration_days: 10,
    },
    commercial_scenario: 'rental',
    decision_access_status: 'decision_maker',
    commercial_stage: 'contract_requested',
    payment_readiness: 'ready',
    technical_requirements: ['25т', 'вылет стрелы 28м'],
    work_conditions: ['Ночная смена', 'Пропуск на объект'],
    price_context: {
      raw_value: 'Бюджет клиента 145000 руб/смена, готовы обсуждать аванс.',
      markers: ['бюджет', 'руб', 'аванс'],
      confidence: 0.82,
    },
    client_expected_next_step: 'Ждет договор и подтверждение резерва техники.',
    geo_hint: extracted.address
      ? {
          raw_value: extracted.address.raw_value,
          normalized_value: extracted.address.normalized_value,
          confidence: extracted.address.confidence_score,
        }
      : null,
    readiness_signals: {
      contract_ready: true,
      payment_ready: true,
      urgency_high: true,
    },
    economic_assessment: {
      expected_margin_percent: 29,
      own_equipment_available: true,
      subrent_required: false,
      expected_revenue_amount: 1450000,
      own_cost_amount: 980000,
      subrent_cost_amount: 1180000,
      mobilization_distance_km: 18,
    },
    financial_risk: {
      debt_overdue_days: 0,
      credit_limit_blocked: false,
      client_blacklisted: false,
    },
    owner_manager: {
      external_id: 'mgr-100',
      full_name: 'Иван Петров',
      role_code: 'sales_manager',
    },
    graph_signals: {
      cross_sell_open: true,
      competitor_present: false,
    },
    last_touch_at: new Date(Date.now() - 6 * 3_600_000).toISOString(),
    next_step: {
      code: 'send_offer',
      due_at: new Date(Date.now() - 1 * 3_600_000).toISOString(),
      description: 'Отправить КП и подтвердить бронь.',
    },
    strategy_weight: 1.15,
    sla_hours: 4,
    communication_events: [
      normalizeCommunicationEvent({
        id: 'comm-1',
        type: 'call',
        channel: 'phone',
        summary: 'Клиент подтверждает срочность и просит договор.',
        text: SAMPLE_EVENT_TEXT,
      }),
      normalizeCommunicationEvent({
        id: 'comm-2',
        type: 'comment',
        channel: 'bitrix_comment',
        summary: 'Нужна быстрая реакция, техника из своего парка подходит.',
        text: 'Менеджер отметил высокий шанс закрытия при ответе в течение 30 минут.',
      }),
    ],
  }],
  ['opp-1002', {
    id: 'opp-1002',
    bitrix_deal_id: '877',
    company: extracted.company,
    contact_person: {
      ...extracted.person,
      role: 'Прораб',
      influence_score: 0.5,
      trust_score: 0.55,
    },
    project_object: {
      raw_value: 'Складской комплекс Южный',
      normalized_value: 'складской комплекс южный',
      confidence_score: 0.88,
      resolved_entity_id: 'object:складской комплекс южный',
    },
    equipment_type: {
      raw_value: 'манипулятор',
      normalized_value: 'Манипулятор',
      confidence_score: 0.92,
      resolved_entity_id: 'equipment_type:манипулятор',
    },
    equipment_model: 'Манипулятор 10т',
    time_window: {
      start_at: new Date(Date.now() + 48 * 3_600_000).toISOString(),
      duration_days: 3,
    },
    commercial_scenario: 'subrent_support',
    decision_access_status: 'influencer',
    commercial_stage: 'offer_requested',
    payment_readiness: 'commercial',
    technical_requirements: ['длина борта 6м'],
    work_conditions: ['Стесненные условия', 'Заезд только утром'],
    price_context: {
      raw_value: 'Клиент жалуется, что у конкурента дешевле на 12%.',
      markers: ['дешевле', 'цена'],
      confidence: 0.77,
    },
    client_expected_next_step: 'Ждет уточнение цены и доступности субаренды.',
    geo_hint: {
      raw_value: 'МО, Южный кластер',
      normalized_value: 'мо южный кластер',
      confidence: 0.62,
    },
    readiness_signals: {
      contract_ready: false,
      payment_ready: false,
      urgency_high: true,
    },
    economic_assessment: {
      expected_margin_percent: 8,
      own_equipment_available: false,
      subrent_required: true,
      expected_revenue_amount: 420000,
      own_cost_amount: null,
      subrent_cost_amount: 386000,
      mobilization_distance_km: 42,
    },
    financial_risk: {
      debt_overdue_days: 24,
      credit_limit_blocked: false,
      client_blacklisted: false,
    },
    owner_manager: {
      external_id: 'mgr-101',
      full_name: 'Мария Смирнова',
      role_code: 'sales_manager',
    },
    graph_signals: {
      cross_sell_open: false,
      competitor_present: true,
    },
    last_touch_at: new Date(Date.now() - 10 * 3_600_000).toISOString(),
    next_step: {
      code: 'clarify_specs',
      due_at: new Date(Date.now() + 2 * 3_600_000).toISOString(),
      description: 'Уточнить длину борта и режим работы.',
    },
    strategy_weight: 0.9,
    sla_hours: 4,
    communication_events: [
      normalizeCommunicationEvent({
        id: 'comm-3',
        type: 'chat',
        channel: 'whatsapp',
        summary: 'Запрос есть, но параметры плавают и упомянут конкурент.',
        text: 'Срочно нужен манипулятор, но пока без точных параметров. На объекте уже стоят люди конкурента.',
      }),
    ],
  }],
]);

export const feedbackStore = [];
export const ingestEventStore = [];
export const recommendationStore = new Map();
export const stateSnapshotStore = new Map();
export const auditLogStore = [];
export const normalizationDecisionStore = new Map();
