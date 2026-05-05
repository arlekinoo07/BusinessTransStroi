import http from 'node:http';
import { execSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

import { getContractsOverview } from './dss/contracts.mjs';
import { getDictionariesOverview } from './dss/dictionaries.mjs';
import { adaptBitrixWebhookPayload } from './bitrix-webhook-adapter.mjs';
import { decideNextAction } from './dss/decision-engine.mjs';
import { extractEntitiesFromText } from './dss/nlp-extraction.mjs';
import { findContextualDuplicateCandidates, findDuplicateCandidates } from './dss/normalization.mjs';
import { buildBitrixEntityPatch } from './services/bitrix-ingest-service.mjs';
import { requirePermission, resolveAuthContext } from './services/auth-permissions-service.mjs';
import {
  getNeo4jStatus,
  getObjectGraphFromNeo4j,
  getOpportunityGraphFromNeo4j,
  syncRepositoryToNeo4j,
} from './services/neo4j-graph-service.mjs';
import { createRepository } from './repositories/opportunity-repository.mjs';
import { getQdrantStatus } from './services/qdrant-vector-service.mjs';
import { syncRepositoryToQdrant } from './services/qdrant-vector-service.mjs';
import { getSimilarCases } from './services/similar-cases-service.mjs';
import { evaluateOpportunityState } from './dss/state-engine.mjs';
import { hasPostgresConfig, query as pgQuery } from './db/postgres.mjs';

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const repository = createRepository();
const APP_STARTED_AT = new Date().toISOString();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.resolve(__dirname, '../public');
const packageJsonPath = path.resolve(__dirname, '../package.json');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

let appMetadataPromise = null;

function getAppGitSha() {
  try {
    return execSync('git rev-parse --short HEAD', {
      cwd: path.resolve(__dirname, '..'),
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    }).trim();
  } catch {
    return process.env.APP_GIT_SHA ?? 'unknown';
  }
}

async function getAppMetadata() {
  if (!appMetadataPromise) {
    appMetadataPromise = fs.readFile(packageJsonPath, 'utf8')
      .then((content) => {
        const parsed = JSON.parse(content);
        return {
          name: parsed.name ?? 'bts-dss',
          version: parsed.version ?? '0.0.0',
          git_sha: getAppGitSha(),
        };
      })
      .catch(() => ({
        name: 'bts-dss',
        version: 'unknown',
        git_sha: getAppGitSha(),
      }));
  }

  return appMetadataPromise;
}

function sendJson(response, statusCode, payload, options = {}) {
  response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  if (options.headOnly) {
    response.end();
    return;
  }
  response.end(JSON.stringify(payload, null, 2));
}

function notFound(response) {
  sendJson(response, 404, { error: 'Not found' });
}

async function writeAuditLog(auth, actionCode, resourceType, resourceId, details = {}, outcomeCode = 'success') {
  await repository.saveAuditLog({
    actor_external_id: auth?.user?.external_id ?? null,
    actor_name: auth?.user?.full_name ?? null,
    actor_role: auth?.user?.role_code ?? null,
    action_code: actionCode,
    resource_type: resourceType,
    resource_id: resourceId ?? null,
    outcome_code: outcomeCode,
    details_json: details,
  });
}

async function serveStaticFile(response, relativePath, options = {}) {
  const safePath = relativePath.replace(/^\/+/, '') || 'index.html';
  const filePath = path.resolve(publicDir, safePath);

  if (!filePath.startsWith(publicDir)) {
    notFound(response);
    return;
  }

  try {
    const content = await fs.readFile(filePath);
    const ext = path.extname(filePath);
    response.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] ?? 'application/octet-stream',
    });
    if (options.headOnly) {
      response.end();
      return;
    }
    response.end(content);
  } catch {
    notFound(response);
  }
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }

  if (!chunks.length) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function getOpportunity(id) {
  return repository.getOpportunityById(id);
}

async function evaluateAndPersistState(opportunity) {
  const state = evaluateOpportunityState(opportunity);
  await repository.persistStateEvaluation(opportunity, state);
  return state;
}

async function evaluateAndPersistDecision(opportunity, actionEffectiveness = null) {
  const state = await evaluateAndPersistState(opportunity);
  const effectivenessMap = actionEffectiveness ?? await getActionEffectivenessMap();
  const decision = decideNextAction(state, { action_effectiveness: effectivenessMap });
  const persistedDecision = await repository.persistDecisionEvaluation(opportunity, state, decision);

  return {
    ...decision,
    recommendation_id: persistedDecision.recommendation_id,
    recommendation_status: persistedDecision.status,
  };
}

function toPriorityBucket(priorityScore) {
  if (priorityScore >= 20) return 'critical';
  if (priorityScore >= 10) return 'high';
  if (priorityScore >= 3) return 'medium';
  return 'low';
}

function diffMinutesFromNow(value) {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) return null;
  return Math.max(0, Math.round((Date.now() - timestamp) / 60000));
}

function pickLatestTimestamp(...values) {
  const valid = values
    .filter(Boolean)
    .map((value) => {
      const timestamp = new Date(value).getTime();
      return Number.isNaN(timestamp) ? null : { value, timestamp };
    })
    .filter(Boolean)
    .sort((left, right) => right.timestamp - left.timestamp);

  return valid[0]?.value ?? null;
}

async function checkLocalHttpHealth() {
  const targetHost = HOST === '0.0.0.0' ? '127.0.0.1' : HOST;
  const startedAt = Date.now();

  return new Promise((resolve) => {
    const request = http.request(
      {
        host: targetHost,
        port: PORT,
        path: '/health',
        method: 'HEAD',
        timeout: 1500,
      },
      (response) => {
        response.resume();
        resolve({
          reachable: response.statusCode === 200,
          status_code: response.statusCode ?? null,
          latency_ms: Date.now() - startedAt,
        });
      },
    );

    request.on('timeout', () => {
      request.destroy();
      resolve({
        reachable: false,
        status_code: null,
        latency_ms: null,
      });
    });

    request.on('error', () => {
      resolve({
        reachable: false,
        status_code: null,
        latency_ms: null,
      });
    });

    request.end();
  });
}

function deriveReadiness(systemStatus) {
  const blockingWarnings = new Set([
    'postgres_unreachable',
    'qdrant_unreachable',
    'neo4j_unreachable',
    'app_http_unreachable',
  ]);

  const reasons = (systemStatus.warnings ?? []).filter((item) => blockingWarnings.has(item));
  const operationalGaps = [];

  if (systemStatus.ingest?.freshness_state !== 'active') {
    operationalGaps.push(`ingest_${systemStatus.ingest?.freshness_state ?? 'unknown'}`);
  }
  if ((systemStatus.app?.http_latency_ms ?? 0) > 500) {
    operationalGaps.push('http_latency_high');
  }
  if ((systemStatus.learning?.readiness ?? 'cold') === 'cold') {
    operationalGaps.push('learning_cold');
  }
  if ((systemStatus.live_support?.vector_live_share ?? 0) < 50) {
    operationalGaps.push('vector_support_low');
  }
  if ((systemStatus.live_support?.graph_live_share ?? 0) < 50) {
    operationalGaps.push('graph_support_low');
  }

  const ready = reasons.length === 0;
  const level = ready
    ? (operationalGaps.length === 0 ? 'production_ready' : 'pilot_ready')
    : 'not_ready';

  return {
    ready,
    state: ready ? 'ready' : 'not_ready',
    level,
    reasons,
    operational_gaps: operationalGaps,
  };
}

function buildOperationalChecklist(systemStatus) {
  const checklist = [];

  checklist.push({
    code: 'postgres',
    status: systemStatus.postgres?.reachable ? 'ready' : systemStatus.postgres?.configured ? 'attention' : 'missing',
    detail: systemStatus.postgres?.reachable ? 'PostgreSQL доступен.' : systemStatus.postgres?.configured ? 'PostgreSQL настроен, но недоступен.' : 'PostgreSQL не настроен.',
  });
  checklist.push({
    code: 'qdrant',
    status: systemStatus.qdrant?.reachable ? 'ready' : systemStatus.qdrant?.configured ? 'attention' : 'missing',
    detail: systemStatus.qdrant?.reachable
      ? `Qdrant доступен, коллекций: ${(systemStatus.qdrant?.collections ?? []).filter((item) => item.exists).length}.`
      : systemStatus.qdrant?.configured ? 'Qdrant настроен, но недоступен.' : 'Qdrant не настроен.',
  });
  checklist.push({
    code: 'neo4j',
    status: systemStatus.neo4j?.reachable ? 'ready' : systemStatus.neo4j?.configured ? 'attention' : 'missing',
    detail: systemStatus.neo4j?.reachable
      ? `Neo4j доступен, граф: ${systemStatus.neo4j?.nodes_count ?? 0}n/${systemStatus.neo4j?.edges_count ?? 0}e.`
      : systemStatus.neo4j?.configured ? 'Neo4j настроен, но недоступен.' : 'Neo4j не настроен.',
  });
  checklist.push({
    code: 'ingest',
    status: systemStatus.ingest?.freshness_state === 'active' ? 'ready' : systemStatus.ingest?.freshness_state === 'warming' ? 'attention' : 'missing',
    detail: `Freshness=${systemStatus.ingest?.freshness_state ?? 'unknown'}, pending=${systemStatus.ingest?.pending_count ?? 0}, failed=${systemStatus.ingest?.failed_count ?? 0}.`,
  });
  checklist.push({
    code: 'learning',
    status: systemStatus.learning?.readiness === 'active' ? 'ready' : systemStatus.learning?.readiness === 'warming' ? 'attention' : 'missing',
    detail: `Feedback=${systemStatus.learning?.total_feedback ?? 0}, readiness=${systemStatus.learning?.readiness ?? 'cold'}.`,
  });
  checklist.push({
    code: 'vector_support',
    status: (systemStatus.live_support?.vector_live_share ?? 0) >= 50 ? 'ready' : (systemStatus.live_support?.vector_live_share ?? 0) > 0 ? 'attention' : 'missing',
    detail: `Vector live share=${systemStatus.live_support?.vector_live_share ?? 0}%.`,
  });
  checklist.push({
    code: 'graph_support',
    status: (systemStatus.live_support?.graph_live_share ?? 0) >= 50 ? 'ready' : (systemStatus.live_support?.graph_live_share ?? 0) > 0 ? 'attention' : 'missing',
    detail: `Graph live share=${systemStatus.live_support?.graph_live_share ?? 0}%.`,
  });

  return checklist;
}

function buildLossRiskSummary(opportunity, state) {
  if (state.states.some((item) => item.state_code === 'hot_unworked')) {
    return {
      level: 'high',
      reason: 'Сделка горячая, но зависла без реакции в рабочем SLA.',
    };
  }
  if (state.states.some((item) => item.state_code === 'hot_urgent')) {
    return {
      level: 'high',
      reason: 'Окно мобилизации близко, клиент может уйти к конкуренту быстрее обычного.',
    };
  }
  if (state.states.some((item) => item.state_code === 'hot_subrent_only')) {
    return {
      level: 'medium',
      reason: 'Реальный спрос есть, но без решения по субаренде сделка быстро уходит.',
    };
  }
  if (state.states.some((item) => item.state_code === 'debt_risk')) {
    return {
      level: 'medium',
      reason: 'Есть риск потерять не сделку, а экономику сделки из-за условий оплаты.',
    };
  }
  if (state.states.some((item) => item.state_code === 'client_intent_confirmed')) {
    return {
      level: 'medium',
      reason: 'Клиент уже сформулировал следующий шаг, и промедление может сбить momentum сделки.',
    };
  }
  if (state.states.some((item) => item.state_code === 'noise_low_priority')) {
    return {
      level: 'low',
      reason: 'Пока мало предметности, поэтому риск потери низкий, но и атаковать рано.',
    };
  }
  if ((opportunity.economic_assessment?.expected_margin_percent ?? 0) < 15
    && opportunity.economic_assessment?.expected_margin_percent !== null) {
    return {
      level: 'low',
      reason: 'Даже при закрытии сделка пока не даёт нужной экономической ценности.',
    };
  }
  return {
    level: 'medium',
    reason: 'Сделка требует контроля, но критичных стоп-сигналов сейчас нет.',
  };
}

function buildAlternativeAction(opportunity, state, decision) {
  const currentActionCode = decision.recommended_action?.action_code ?? null;

  if (currentActionCode === 'send_offer') {
    if (opportunity.economic_assessment?.own_equipment_available) {
      return 'Зарезервировать свою технику';
    }
    if (state.states.some((item) => item.state_code === 'hot_subrent_only')) {
      return 'Передать в субаренду';
    }
  }

  if (currentActionCode === 'clarify_specs') {
    return 'Позвонить клиенту';
  }

  if (currentActionCode === 'request_subrent' && opportunity.economic_assessment?.own_equipment_available) {
    return 'Зарезервировать свою технику';
  }

  if (currentActionCode === 'sales_call' && opportunity.payment_readiness === 'ready_for_offer') {
    return 'Отправить КП';
  }

  if (currentActionCode === 'debt_control') {
    return 'Эскалировать на руководителя';
  }

  if (currentActionCode === 'stop_deal' && !state.states.some((item) => item.state_code === 'noise_low_priority')) {
    return 'Уточнить техпараметры';
  }

  return null;
}

function collectBlockingReasons(opportunity, state) {
  const blockingReasons = [];

  if (state.states.some((item) => item.state_code === 'spec_missing')) {
    blockingReasons.push('Нужны уточнения по техпараметрам.');
  }
  if (state.states.some((item) => item.state_code === 'debt_risk')) {
    blockingReasons.push('Есть риск по оплате или кредитным ограничениям.');
  }
  if (state.states.some((item) => item.state_code === 'hot_subrent_only')) {
    blockingReasons.push('Сделка зависит от субаренды.');
  }
  if (state.states.some((item) => item.state_code === 'extraction_low_confidence')) {
    blockingReasons.push('Низкая уверенность в объекте или технике, нужна ручная верификация.');
  }
  if (state.states.some((item) => item.state_code === 'negative_margin_blocked')) {
    blockingReasons.push('Сделка уходит в отрицательную маржу.');
  }
  if (state.states.some((item) => item.state_code === 'blacklist_blocked')) {
    blockingReasons.push('Клиент находится в стоп-контуре.');
  }

  return blockingReasons;
}

function collectLowPriorityReasons(opportunity, state) {
  const lowPriorityReasons = [];

  if ((opportunity.economic_assessment?.expected_margin_percent ?? 0) < 15
    && opportunity.economic_assessment?.expected_margin_percent !== null) {
    lowPriorityReasons.push('Маржа ниже рабочего порога.');
  }
  if (state.states.some((item) => item.state_code === 'noise_low_priority')) {
    lowPriorityReasons.push('Сделка пока шумовая и слабо конкретизирована.');
  }
  if (!opportunity.next_step?.code && !opportunity.next_step?.description) {
    lowPriorityReasons.push('Не зафиксирован следующий шаг.');
  }
  if (state.states.some((item) => item.state_code === 'extraction_low_confidence')) {
    lowPriorityReasons.push('Сделку пока рано агрессивно атаковать: ключевые сущности распознаны неуверенно.');
  }
  if (!opportunity.client_expected_next_step && !opportunity.next_step?.code) {
    lowPriorityReasons.push('Клиент не обозначил ожидаемый следующий шаг.');
  }

  return lowPriorityReasons;
}

function buildStopSignals(opportunity, state, decision) {
  const blockingReasons = collectBlockingReasons(opportunity, state);
  const lowPriorityReasons = collectLowPriorityReasons(opportunity, state);
  const strategyWarnings = [];
  const waitConditions = [];

  if ((opportunity.economic_assessment?.expected_margin_percent ?? 0) < 10
    && opportunity.economic_assessment?.expected_margin_percent !== null) {
    strategyWarnings.push('Экономика сделки близка к убыточной для текущей модели.');
  }
  if (opportunity.financial_risk?.client_blacklisted) {
    strategyWarnings.push('Клиент находится в стоп-контуре по политике компании.');
  }
  if (opportunity.financial_risk?.credit_limit_blocked) {
    strategyWarnings.push('Кредитный лимит клиента заблокирован.');
  }
  if (state.states.some((item) => item.state_code === 'spec_missing')) {
    waitConditions.push('Сначала дособрать технические параметры и условия заезда.');
  }
  if (state.states.some((item) => item.state_code === 'debt_risk')) {
    waitConditions.push('Сначала согласовать условия оплаты и снять финансовые ограничения.');
  }
  if (state.states.some((item) => item.state_code === 'noise_low_priority')) {
    waitConditions.push('Сначала подтвердить, что потребность реальная, а не шумовая.');
  }
  if (state.states.some((item) => item.state_code === 'hot_subrent_only')) {
    waitConditions.push('Сначала понять, доступна ли субаренда и укладывается ли она в маржу.');
  }
  if (state.states.some((item) => item.state_code === 'object_access_unclear')) {
    waitConditions.push('Сначала уточнить доступ на объект, окна заезда и ограничения по площадке.');
  }
  if (!opportunity.price_context?.raw_value && state.states.some((item) => item.state_code === 'low_margin_warning')) {
    waitConditions.push('Сначала уточнить ценовой контекст клиента, чтобы корректно пересчитать ставку.');
  }
  if (state.states.some((item) => item.state_code === 'extraction_low_confidence')) {
    waitConditions.push('Сначала вручную подтвердить объект, технику и базовые условия запроса.');
  }
  if (!waitConditions.length && decision.recommended_action?.action_code === 'stop_deal') {
    waitConditions.push('Сейчас лучше не тратить ресурс команды, пока не появится предметность.');
  }

  return {
    blocked_reasons: blockingReasons,
    low_priority_reasons: lowPriorityReasons,
    strategy_warnings: strategyWarnings,
    wait_conditions: waitConditions,
  };
}

function buildQueueItem(opportunity, state, decision) {
  const blockingReasons = collectBlockingReasons(opportunity, state);
  const lowPriorityReasons = collectLowPriorityReasons(opportunity, state);
  const lossRisk = buildLossRiskSummary(opportunity, state);
  const alternativeAction = buildAlternativeAction(opportunity, state, decision);
  const priorityReasons = [];
  const nextStepDueAt = opportunity.next_step?.due_at ?? null;
  const promiseOverdue = state.states.some((item) => item.state_code === 'manager_promise_overdue');
  const slaBreached = state.states.some((item) => item.state_code === 'hot_unworked');

  if ((state.scores.need ?? 0) >= 4) {
    priorityReasons.push('need strong');
  }
  if ((state.scores.time ?? 0) >= 4) {
    priorityReasons.push('time critical');
  }
  if ((state.scores.money ?? 0) >= 4) {
    priorityReasons.push('money ready');
  }
  if ((state.scores.fit ?? 0) >= 4) {
    priorityReasons.push('fit high');
  }

  const signalMarkers = [];
  if (state.states.some((item) => item.state_code === 'client_ready_for_contract')) {
    signalMarkers.push('contract ready');
  }
  if (state.states.some((item) => item.state_code === 'decision_maker_reached')) {
    signalMarkers.push('decision access');
  }
  if (state.states.some((item) => item.state_code === 'spec_strong')) {
    signalMarkers.push('spec strong');
  }
  if (state.states.some((item) => item.state_code === 'client_intent_confirmed')) {
    signalMarkers.push('client intent');
  }
  if (state.states.some((item) => item.state_code === 'price_context_known')) {
    signalMarkers.push('price context');
  }
  if (state.states.some((item) => item.state_code === 'logistics_context_ready')) {
    signalMarkers.push('logistics context');
  }
  if (state.states.some((item) => item.state_code === 'extraction_low_confidence')) {
    signalMarkers.push('verify extraction');
  }

  return {
    opportunity_id: opportunity.id,
    bitrix_deal_id: opportunity.bitrix_deal_id,
    company: opportunity.company?.raw_value ?? null,
    object: opportunity.project_object?.raw_value ?? null,
    priority_score: state.priority_score,
    priority_bucket: toPriorityBucket(state.priority_score),
    next_action: decision.recommended_action?.action_name ?? null,
    next_action_code: decision.recommended_action?.action_code ?? null,
    target_role: decision.recommended_action?.target_role ?? null,
    recommended_owner: opportunity.owner_manager?.full_name
      ?? opportunity.contact_person?.raw_value
      ?? null,
    why_now: decision.explainability.why_important[0] ?? null,
    risk_summary: decision.explainability.risk_if_ignored ?? null,
    loss_risk_level: lossRisk.level,
    loss_risk_reason: lossRisk.reason,
    alternative_action: alternativeAction,
    next_step_due_at: nextStepDueAt,
    promise_overdue: promiseOverdue,
    sla_breached: slaBreached,
    deadline_at: decision.deadline_at,
    state_codes: state.states.map((item) => item.state_code),
    score_vector: state.scores,
    priority_reasons: priorityReasons,
    signal_markers: signalMarkers,
    why_blocked: blockingReasons,
    why_low_priority: lowPriorityReasons,
  };
}

async function getActionEffectivenessMap() {
  const feedback = await repository.getFeedbackLearningSummary(50);
  return new Map((feedback.action_metrics ?? []).map((item) => [item.action_code, item]));
}

function collectSignalEvidence(opportunity) {
  const events = opportunity.communication_events ?? [];
  const competitorEvents = [];
  const debtRiskEvents = [];
  const subrentEvents = [];
  const promiseEvents = [];
  const noiseEvents = [];

  for (const event of events) {
    const extraction = event.extraction_json ?? {};
    const baseEvidence = {
      event_id: event.id,
      channel: event.channel ?? null,
      datetime: event.datetime ?? null,
      summary: event.summary ?? event.text ?? null,
    };

    if (extraction.is_noise) {
      noiseEvents.push({
        ...baseEvidence,
        reason: extraction.noise_reason ?? null,
        markers: extraction.noise_markers ?? [],
      });
    }

    if (extraction.competitor?.mentioned) {
      competitorEvents.push({
        ...baseEvidence,
        markers: extraction.competitor.markers ?? [],
      });
    }

    if (extraction.debt_risk?.mentioned) {
      debtRiskEvents.push({
        ...baseEvidence,
        markers: extraction.debt_risk.markers ?? [],
        requires_prepayment: extraction.debt_risk.requires_prepayment ?? false,
      });
    }

    if (extraction.supply_mode === 'subrent') {
      subrentEvents.push({
        ...baseEvidence,
        markers: ['subrent'],
      });
    }

    if (extraction.manager_promise?.raw_value || extraction.next_touch_hint) {
      promiseEvents.push({
        ...baseEvidence,
        promise: extraction.manager_promise?.raw_value ?? extraction.next_touch_hint ?? null,
        due_at: extraction.manager_promise?.due_at ?? extraction.next_touch_due_at ?? null,
        action_code: extraction.next_touch_action_code ?? null,
      });
    }
  }

  return {
    flags: {
      competitor_present: opportunity.graph_signals?.competitor_present ?? false,
      debt_risk: (opportunity.financial_risk?.debt_overdue_days ?? 0) > 0 || opportunity.financial_risk?.credit_limit_blocked,
      subrent_required: opportunity.economic_assessment?.subrent_required ?? false,
      manager_promise_overdue: Boolean(
        opportunity.next_step?.due_at && new Date(opportunity.next_step.due_at).getTime() < Date.now(),
      ),
    },
    counters: {
      communication_events: events.length,
      competitor_mentions: competitorEvents.length,
      debt_markers: debtRiskEvents.length,
      subrent_markers: subrentEvents.length,
      promise_markers: promiseEvents.length,
      ignored_noise_events: noiseEvents.length,
    },
    evidence: {
      competitor: competitorEvents.slice(0, 5),
      debt_risk: debtRiskEvents.slice(0, 5),
      subrent: subrentEvents.slice(0, 5),
      manager_promises: promiseEvents.slice(0, 5),
      ignored_noise: noiseEvents.slice(0, 5),
    },
  };
}

function buildExtractionQuality(opportunity) {
  const events = opportunity.communication_events ?? [];
  const extractionEvents = events
    .map((event) => event.extraction_json ?? null)
    .filter(Boolean);

  const confidence = {
    company: opportunity.company?.confidence_score ?? null,
    object: opportunity.project_object?.confidence_score ?? null,
    person: opportunity.contact_person?.confidence_score ?? null,
    equipment: opportunity.equipment_type?.confidence_score ?? null,
  };

  const extractedSignalConfidence = {
    urgency: extractionEvents
      .map((item) => item.urgency?.confidence)
      .filter((value) => value !== null && value !== undefined),
    money: extractionEvents
      .map((item) => item.money_readiness?.confidence)
      .filter((value) => value !== null && value !== undefined),
    decision_access: extractionEvents
      .map((item) => item.decision_access?.confidence)
      .filter((value) => value !== null && value !== undefined),
    competitor: extractionEvents
      .map((item) => item.competitor?.confidence)
      .filter((value) => value !== null && value !== undefined),
    debt_risk: extractionEvents
      .map((item) => item.debt_risk?.confidence)
      .filter((value) => value !== null && value !== undefined),
  };

  const avg = (values) => values.length
    ? Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2))
    : null;

  const fieldConfidence = {
    ...confidence,
    urgency: avg(extractedSignalConfidence.urgency),
    money: avg(extractedSignalConfidence.money),
    decision_access: avg(extractedSignalConfidence.decision_access),
    competitor: avg(extractedSignalConfidence.competitor),
    debt_risk: avg(extractedSignalConfidence.debt_risk),
    price: avg(extractionEvents
      .map((item) => item.price_context?.confidence)
      .filter((value) => value !== null && value !== undefined)),
    geo: avg(extractionEvents
      .map((item) => item.geo_hint?.confidence)
      .filter((value) => value !== null && value !== undefined)),
  };

  const lowConfidenceFields = Object.entries(fieldConfidence)
    .filter(([, value]) => value !== null && value < 0.7)
    .map(([key]) => key);

  return {
    extracted_events: extractionEvents.length,
    field_confidence: fieldConfidence,
    low_confidence_fields: lowConfidenceFields,
  };
}

function buildDecisionTimeline(stateHistory, recommendationsHistory, feedbackHistory) {
  const feedbackByRecommendationId = new Map();
  for (const item of feedbackHistory ?? []) {
    const key = item.recommendation_id ?? item.action_id;
    if (!key) continue;
    const current = feedbackByRecommendationId.get(key) ?? [];
    current.push(item);
    feedbackByRecommendationId.set(key, current);
  }

  const stateEntries = (stateHistory ?? []).map((item) => ({
    event_type: 'state',
    created_at: item.snapshot_time ?? null,
    title: item.state_code,
    subtitle: item.reason ?? null,
    payload: item,
  }));

  const recommendationEntries = (recommendationsHistory ?? []).map((item) => {
    const feedbackItems = feedbackByRecommendationId.get(item.id) ?? [];
    return {
      event_type: 'recommendation',
      created_at: item.created_at ?? null,
      title: item.action_code ?? 'recommendation',
      subtitle: item.status ?? null,
      payload: {
        ...item,
        feedback: feedbackItems,
      },
    };
  });

  const feedbackEntries = (feedbackHistory ?? []).map((item) => {
    let status = 'shown';
    if (item.executed) status = 'executed';
    else if (item.accepted) status = 'accepted';
    else if (item.rejected) status = 'rejected';

    return {
      event_type: 'feedback',
      created_at: item.recorded_at ?? null,
      title: `${item.action_code ?? 'recommendation'} · ${status}`,
      subtitle: item.rejection_reason ?? item.deal_result ?? null,
      payload: item,
    };
  });

  return [...stateEntries, ...recommendationEntries, ...feedbackEntries]
    .sort((left, right) => new Date(right.created_at ?? 0).getTime() - new Date(left.created_at ?? 0).getTime())
    .slice(0, 30);
}

export async function buildManagerDashboard() {
  const actionEffectiveness = await getActionEffectivenessMap();
  const opportunities = await repository.listOpportunities();
  return opportunities
    .map((opportunity) => {
      const state = evaluateOpportunityState(opportunity);
      const decision = decideNextAction(state, { action_effectiveness: actionEffectiveness });
      return {
        ...buildQueueItem(opportunity, state, decision),
        action_effectiveness: actionEffectiveness.get(decision.recommended_action?.action_code ?? '') ?? null,
      };
    })
    .sort((left, right) => right.priority_score - left.priority_score);
}

export async function buildRopDashboard() {
  const actionEffectiveness = await getActionEffectivenessMap();
  const opportunities = await repository.listOpportunities();
  return opportunities
    .map((opportunity) => {
      const state = evaluateOpportunityState(opportunity);
      const decision = decideNextAction(state, { action_effectiveness: actionEffectiveness });
      const riskEvidence = collectSignalEvidence(opportunity);
      let escalationType = 'monitor';
      let escalationReason = state.states[0]?.reason ?? 'Требует внимания РОПа.';

      if (state.states.some((item) => item.state_code === 'hot_unworked')) {
        escalationType = 'sla_breach';
        escalationReason = 'Горячая сделка без движения дольше SLA.';
      } else if (state.states.some((item) => item.state_code === 'debt_risk')) {
        escalationType = 'debt_risk';
        escalationReason = 'У клиента риск дебиторки, нужно управленческое решение.';
      } else if ((opportunity.economic_assessment?.expected_margin_percent ?? 0) < 15) {
        escalationType = 'low_margin';
        escalationReason = 'Сделка ниже целевого порога маржи.';
      } else if (state.states.some((item) => item.state_code === 'hot_subrent_only')) {
        escalationType = 'subrent_only';
        escalationReason = 'Сделка живая, но без своей техники.';
      }

      const signalMarkers = [
        ...(state.states.some((item) => item.state_code === 'client_ready_for_contract') ? ['contract ready'] : []),
        ...(state.states.some((item) => item.state_code === 'decision_maker_reached') ? ['decision access'] : []),
        ...(state.states.some((item) => item.state_code === 'spec_strong') ? ['spec strong'] : []),
        ...(state.states.some((item) => item.state_code === 'extraction_low_confidence') ? ['verify extraction'] : []),
      ];

      return {
        opportunity_id: opportunity.id,
        bitrix_deal_id: opportunity.bitrix_deal_id,
        company: opportunity.company?.raw_value ?? null,
        object: opportunity.project_object?.raw_value ?? null,
        priority_score: state.priority_score,
        state_codes: state.states.map((item) => item.state_code),
        margin_percent: opportunity.economic_assessment?.expected_margin_percent ?? null,
        debt_overdue_days: opportunity.financial_risk?.debt_overdue_days ?? null,
        escalation_reason: escalationReason,
        escalation_type: escalationType,
        recommended_action: decision.recommended_action?.action_name ?? null,
        target_role: decision.recommended_action?.target_role ?? null,
        recommended_owner: opportunity.owner_manager?.full_name
          ?? opportunity.contact_person?.raw_value
          ?? null,
        recommendation_status: decision.escalation_action?.action_code ? 'needs_approval' : 'monitor',
        deadline_at: decision.deadline_at,
        next_step_due_at: opportunity.next_step?.due_at ?? null,
        promise_overdue: state.states.some((item) => item.state_code === 'manager_promise_overdue'),
        sla_breached: state.states.some((item) => item.state_code === 'hot_unworked'),
        action_effectiveness: actionEffectiveness.get(decision.recommended_action?.action_code ?? '') ?? null,
        signal_markers: signalMarkers,
        evidence_summary: {
          competitor_mentions: riskEvidence.counters.competitor_mentions,
          debt_markers: riskEvidence.counters.debt_markers,
          subrent_markers: riskEvidence.counters.subrent_markers,
          promise_markers: riskEvidence.counters.promise_markers,
        },
        evidence_markers: [
          ...riskEvidence.evidence.competitor.flatMap((item) => item.markers ?? []),
          ...riskEvidence.evidence.debt_risk.flatMap((item) => item.markers ?? []),
          ...(riskEvidence.flags.subrent_required ? ['subrent'] : []),
          ...(riskEvidence.flags.manager_promise_overdue ? ['promise_overdue'] : []),
        ].filter(Boolean).slice(0, 8),
      };
    })
    .filter((item) =>
      item.state_codes.includes('hot_unworked')
      || item.state_codes.includes('debt_risk')
      || item.margin_percent < 15,
    );
}

export async function buildRopEscalations({ limit = 20, escalationType = '' } = {}) {
  const items = await buildRopDashboard();
  return items
    .filter((item) => !escalationType || item.escalation_type === escalationType)
    .sort((left, right) => right.priority_score - left.priority_score)
    .slice(0, limit);
}

function toUrgencyBucket(timeScore) {
  if (timeScore >= 4.5) return 'urgent';
  if (timeScore >= 3) return 'near';
  return 'planned';
}

function getRegionHint(opportunity) {
  return opportunity.geo_hint?.region
    ?? opportunity.address?.normalized_value
    ?? opportunity.address?.raw_value
    ?? null;
}

function normalizeRegionLabel(region) {
  const value = String(region ?? '').toLowerCase();
  if (value.includes('моск')) return 'москва';
  if (value.includes('мо') || value.includes('област')) return 'мо';
  return value;
}

function findBestOwnUnit(opportunity) {
  const dictionaries = getDictionariesOverview();
  const units = dictionaries.own_equipment_units ?? [];
  const equipmentType = String(opportunity.equipment_type?.normalized_value ?? opportunity.equipment_type?.raw_value ?? '').toLowerCase();
  const equipmentModel = String(opportunity.equipment_model ?? '').toLowerCase();
  const region = normalizeRegionLabel(getRegionHint(opportunity));

  return units
    .map((unit) => {
      let score = 0;
      if (String(unit.availability_status ?? '').toLowerCase() === 'available') score += 4;
      if (String(unit.type_name ?? '').toLowerCase() === equipmentType) score += 3;
      if (equipmentModel && String(unit.model ?? '').toLowerCase() === equipmentModel) score += 3;
      if (region && normalizeRegionLabel(unit.region) === region) score += 2;
      return { ...unit, score };
    })
    .filter((unit) => unit.score > 0)
    .sort((left, right) => right.score - left.score)[0] ?? null;
}

function buildPartnerScore(opportunity, partner) {
  const equipmentType = String(opportunity.equipment_type?.normalized_value ?? opportunity.equipment_type?.raw_value ?? '');
  const region = normalizeRegionLabel(getRegionHint(opportunity));
  let score = 0;
  if ((partner.equipment_types ?? []).includes(equipmentType)) score += 4;
  if (region && normalizeRegionLabel(partner.region) === region) score += 3;
  score += Number(partner.reliability ?? 0) * 3;
  score += Math.max(0, 2 - Number(partner.margin_pressure ?? 0) * 5);
  score += Math.max(0, 2 - (Number(partner.shoulder_km ?? 999) / 30));
  return Number(score.toFixed(2));
}

function findBestSubrentPartner(opportunity) {
  const dictionaries = getDictionariesOverview();
  const partners = dictionaries.subrent_partners ?? [];
  return partners
    .map((partner) => ({ ...partner, partner_score: buildPartnerScore(opportunity, partner) }))
    .sort((left, right) => right.partner_score - left.partner_score)[0] ?? null;
}

function buildMarginPressure(opportunity) {
  const margin = opportunity.economic_assessment?.expected_margin_percent ?? null;
  if (margin === null || margin === undefined) return 'unknown';
  if (margin < 10) return 'critical';
  if (margin < 15) return 'high';
  if (margin < 22) return 'medium';
  return 'low';
}

function calculateOwnUnitEconomics(opportunity, unit) {
  if (!unit) return null;
  if (opportunity.economic_assessment?.own_equipment_available === false) return null;
  const revenue = opportunity.economic_assessment?.expected_revenue_amount ?? null;
  const ownCost = opportunity.economic_assessment?.own_cost_amount ?? null;
  const mobilizationDistance = opportunity.economic_assessment?.mobilization_distance_km ?? null;
  const busyPenalty = String(unit.availability_status ?? '').toLowerCase() === 'busy' ? 0.35 : 0;
  const distancePenalty = mobilizationDistance ? Math.min(0.1, mobilizationDistance / 1000) : 0;
  const estimatedMarginPercent = revenue && ownCost
    ? Number((((revenue - ownCost) / revenue) * 100).toFixed(1))
    : opportunity.economic_assessment?.expected_margin_percent ?? null;
  const score = Number((((estimatedMarginPercent ?? 0) / 10) + 3 - busyPenalty * 10 - distancePenalty * 10).toFixed(2));
  return {
    mode: 'own_fleet',
    estimated_margin_percent: estimatedMarginPercent,
    mobilization_distance_km: mobilizationDistance,
    availability_penalty: busyPenalty,
    score,
  };
}

function calculateSubrentEconomics(opportunity, partner) {
  if (!partner) return null;
  const revenue = opportunity.economic_assessment?.expected_revenue_amount ?? null;
  const subrentCost = opportunity.economic_assessment?.subrent_cost_amount ?? null;
  const estimatedMarginPercent = revenue && subrentCost
    ? Number((((revenue - subrentCost) / revenue) * 100).toFixed(1))
    : opportunity.economic_assessment?.expected_margin_percent ?? null;
  const shoulderPenalty = Math.min(0.14, Number(partner.shoulder_km ?? 0) / 400);
  const reliabilityBonus = Number(partner.reliability ?? 0) * 2;
  const marginPenalty = Number(partner.margin_pressure ?? 0) * 10;
  const score = Number((((estimatedMarginPercent ?? 0) / 10) + reliabilityBonus - shoulderPenalty * 10 - marginPenalty).toFixed(2));
  return {
    mode: 'subrent',
    estimated_margin_percent: estimatedMarginPercent,
    mobilization_distance_km: partner.shoulder_km ?? null,
    shoulder_penalty: shoulderPenalty,
    score,
  };
}

function decideLogisticsEconomics(opportunity) {
  const ownUnit = findBestOwnUnit(opportunity);
  const partner = findBestSubrentPartner(opportunity);
  const ownEconomics = calculateOwnUnitEconomics(opportunity, ownUnit);
  const subrentEconomics = calculateSubrentEconomics(opportunity, partner);

  if (ownEconomics && !subrentEconomics) {
    return {
      mode: ownEconomics.mode,
      reason: 'Своя техника доступна, альтернативная субаренда не подтверждена.',
      own_unit: ownUnit,
      partner,
      own_economics: ownEconomics,
      subrent_economics: subrentEconomics,
    };
  }
  if (!ownEconomics && subrentEconomics) {
    return {
      mode: subrentEconomics.mode,
      reason: 'Подходящая своя техника не найдена, субаренда выглядит рабочим вариантом.',
      own_unit: ownUnit,
      partner,
      own_economics: ownEconomics,
      subrent_economics: subrentEconomics,
    };
  }
  if (ownEconomics && subrentEconomics) {
    const preferOwn = ownEconomics.score >= subrentEconomics.score;
    return {
      mode: preferOwn ? ownEconomics.mode : subrentEconomics.mode,
      reason: preferOwn
        ? `Своя техника выгоднее по score ${ownEconomics.score} против ${subrentEconomics.score}.`
        : `Субаренда выгоднее по score ${subrentEconomics.score} против ${ownEconomics.score}.`,
      own_unit: ownUnit,
      partner,
      own_economics: ownEconomics,
      subrent_economics: subrentEconomics,
    };
  }

  return {
    mode: null,
    reason: 'Недостаточно данных для экономического выбора.',
    own_unit: ownUnit,
    partner,
    own_economics: ownEconomics,
    subrent_economics: subrentEconomics,
  };
}

function buildPartnerHint(opportunity, state) {
  const equipment = opportunity.equipment_type?.normalized_value ?? opportunity.equipment_type?.raw_value ?? 'технику';
  const logistics = decideLogisticsEconomics(opportunity);
  const ownUnit = logistics.own_unit;
  const partner = logistics.partner;
  if (state.states.some((item) => item.state_code === 'hot_subrent_only')) {
    if (partner) {
      return `Подобрать субаренду под ${equipment}: приоритет ${partner.name}, плечо ${partner.shoulder_km} км, надежность ${Math.round((partner.reliability ?? 0) * 100)}%.`;
    }
    return `Подобрать субаренду под ${equipment} и проверить плечо мобилизации.`;
  }
  if (opportunity.economic_assessment?.own_equipment_available && ownUnit) {
    return `Сначала резерв своей техники под ${equipment}: ${ownUnit.registry_id} (${ownUnit.base_location}).`;
  }
  if (partner) {
    return `Проверить доступность партнера ${partner.name} по ${equipment}.`;
  }
  return `Проверить доступность партнеров по ${equipment}.`;
}

function buildDemandClusterHint(opportunity) {
  const objectName = opportunity.project_object?.raw_value ?? null;
  const companyName = opportunity.company?.raw_value ?? null;
  const region = getRegionHint(opportunity);
  if (objectName) {
    return `Сгруппировать запросы вокруг объекта "${objectName}".`;
  }
  if (region) {
    return `Проверить накопленный спрос и перегруз по региону "${region}".`;
  }
  if (companyName) {
    return `Проверить повторный спрос у клиента "${companyName}".`;
  }
  return 'Проверить кластер похожих запросов в этом регионе.';
}

export async function buildLogisticsDashboard({ limit = 20, mode = '' } = {}) {
  const actionEffectiveness = await getActionEffectivenessMap();
  const opportunities = await repository.listOpportunities();
  const items = opportunities
    .map((opportunity) => {
      const state = evaluateOpportunityState(opportunity);
      const decision = decideNextAction(state, { action_effectiveness: actionEffectiveness });
      const logistics = decideLogisticsEconomics(opportunity);
      const bestPartner = logistics.partner;
      const reserveUnit = logistics.own_unit;
      return {
        opportunity_id: opportunity.id,
        bitrix_deal_id: opportunity.bitrix_deal_id,
        company: opportunity.company?.raw_value ?? null,
        object: opportunity.project_object?.raw_value ?? null,
        equipment_type: opportunity.equipment_type?.normalized_value ?? opportunity.equipment_type?.raw_value ?? null,
        priority_score: state.priority_score,
        urgency_bucket: toUrgencyBucket(state.scores.time),
        own_equipment_available: opportunity.economic_assessment?.own_equipment_available ?? null,
        subrent_required: opportunity.economic_assessment?.subrent_required ?? null,
        recommended_action: decision.recommended_action?.action_name ?? null,
        partner_hint: buildPartnerHint(opportunity, state),
        demand_cluster_hint: buildDemandClusterHint(opportunity),
        economics_mode: logistics.mode,
        economics_reason: logistics.reason,
        recommended_partner: bestPartner ? {
          name: bestPartner.name,
          reliability_percent: Math.round((bestPartner.reliability ?? 0) * 100),
          shoulder_km: bestPartner.shoulder_km ?? null,
          score: bestPartner.partner_score,
        } : null,
        reserve_unit: reserveUnit ? {
          registry_id: reserveUnit.registry_id,
          model: reserveUnit.model,
          base_location: reserveUnit.base_location,
          availability_status: reserveUnit.availability_status,
        } : null,
        margin_pressure: buildMarginPressure(opportunity),
        expected_margin_percent: opportunity.economic_assessment?.expected_margin_percent ?? null,
        mobilization_distance_km: logistics.mode === 'subrent'
          ? bestPartner?.shoulder_km ?? null
          : opportunity.economic_assessment?.mobilization_distance_km ?? null,
        deadline_at: decision.deadline_at,
        state_codes: state.states.map((item) => item.state_code),
      };
    })
    .filter((item) =>
      item.urgency_bucket === 'urgent'
      || item.subrent_required
      || item.state_codes.includes('hot_subrent_only')
      || item.state_codes.includes('hot_urgent')
    )
    .filter((item) => {
      if (!mode) return true;
      if (mode === 'subrent') return item.subrent_required || item.state_codes.includes('hot_subrent_only');
      if (mode === 'urgent') return item.urgency_bucket === 'urgent';
      if (mode === 'reserve') return item.own_equipment_available === true;
      return true;
    })
    .sort((left, right) => right.priority_score - left.priority_score)
    .slice(0, limit);

  return items;
}

export async function buildOwnerDashboard({ limit = 20, strategy = '' } = {}) {
  const [feedback, opportunities, ingestIssues] = await Promise.all([
    repository.getFeedbackLearningSummary(50),
    repository.listOpportunities(),
    repository.listFailedIngestEvents(500),
  ]);
  const actionEffectiveness = new Map((feedback.action_metrics ?? []).map((item) => [item.action_code, item]));
  const marginRiskCount = opportunities.filter((item) => {
    const margin = item.economic_assessment?.expected_margin_percent ?? null;
    return margin !== null && margin < 15;
  }).length;
  const strategicLoadReadyCount = opportunities.filter((item) => {
    const state = evaluateOpportunityState(item);
    return item.economic_assessment?.own_equipment_available === true
      && state.states.some((entry) => entry.state_code === 'logistics_context_ready');
  }).length;
  const liveSupportCount = opportunities.filter((item) =>
    item.graph_signals?.cross_sell_open || item.graph_signals?.competitor_present).length;
  const items = opportunities
    .map((opportunity) => {
      const state = evaluateOpportunityState(opportunity);
      const decision = decideNextAction(state, { action_effectiveness: actionEffectiveness });
      const margin = opportunity.economic_assessment?.expected_margin_percent ?? null;
      const ownEquipment = opportunity.economic_assessment?.own_equipment_available ?? null;
      const subrentRequired = opportunity.economic_assessment?.subrent_required ?? null;
      const debtRisk = state.states.some((item) => item.state_code === 'debt_risk');
      const logistics = decideLogisticsEconomics(opportunity);
      const reserveUnit = logistics.own_unit;
      const bestPartner = logistics.partner;
      const logisticsReady = state.states.some((item) => item.state_code === 'logistics_context_ready');
      const priceKnown = state.states.some((item) => item.state_code === 'price_context_known');
      const marginPressure = buildMarginPressure(opportunity);

      let strategyFlag = 'monitor';
      let ownerSignal = 'Без стратегического отклонения.';

      if (debtRisk) {
        strategyFlag = 'debt_control';
        ownerSignal = 'Сделка требует контроля риска дебиторки.';
      } else if (subrentRequired && !ownEquipment) {
        strategyFlag = 'subrent_dependency';
        ownerSignal = 'Рост оборота идет через субаренду, а не через свой парк.';
      } else if (margin !== null && margin < 15) {
        strategyFlag = 'margin_risk';
        ownerSignal = 'Маржа ниже рабочего порога.';
      } else if (ownEquipment) {
        strategyFlag = 'fleet_priority';
        ownerSignal = 'Есть шанс загрузить свою технику.';
      }
      if (marginPressure === 'critical' || marginPressure === 'high') {
        ownerSignal = `${ownerSignal} Давление на маржу: ${marginPressure}.`;
      }
      if (logistics.mode) {
        ownerSignal = `${ownerSignal} Режим экономики: ${logistics.mode}.`;
      }

      const signalMarkers = [
        ...(state.states.some((item) => item.state_code === 'client_ready_for_contract') ? ['contract ready'] : []),
        ...(state.states.some((item) => item.state_code === 'decision_maker_reached') ? ['decision access'] : []),
        ...(state.states.some((item) => item.state_code === 'spec_strong') ? ['spec strong'] : []),
        ...(state.states.some((item) => item.state_code === 'extraction_low_confidence') ? ['verify extraction'] : []),
        ...(reserveUnit ? [`reserve ${reserveUnit.registry_id}`] : []),
        ...(bestPartner ? [`partner ${bestPartner.name}`] : []),
        ...(logistics.mode ? [`mode ${logistics.mode}`] : []),
        ...(logisticsReady ? ['logistics ready'] : []),
        ...(priceKnown ? ['price known'] : []),
        ...(marginPressure !== 'low' && marginPressure !== 'unknown' ? [`margin ${marginPressure}`] : []),
      ];

      return {
        opportunity_id: opportunity.id,
        company: opportunity.company?.raw_value ?? null,
        object: opportunity.project_object?.raw_value ?? null,
        priority_score: state.priority_score,
        margin_percent: margin,
        own_equipment_available: ownEquipment,
        subrent_required: subrentRequired,
        debt_risk: debtRisk,
        strategy_flag: strategyFlag,
        owner_signal: ownerSignal,
        recommended_action: decision.recommended_action?.action_name ?? null,
        signal_markers: signalMarkers,
        reserve_unit: reserveUnit ? reserveUnit.registry_id : null,
        recommended_partner: bestPartner?.name ?? null,
        margin_pressure: marginPressure,
      };
    })
    .filter((item) => {
      if (!strategy) return item.strategy_flag !== 'monitor';
      return item.strategy_flag === strategy;
    })
    .sort((left, right) => right.priority_score - left.priority_score)
    .slice(0, limit);

  const totalOpportunities = opportunities.length || 1;
  const ownEquipmentCount = opportunities.filter((item) => item.economic_assessment?.own_equipment_available === true).length;
  const subrentCount = opportunities.filter((item) => item.economic_assessment?.subrent_required === true).length;
  const debtRiskCount = opportunities.filter((item) =>
    (item.financial_risk?.debt_overdue_days ?? 0) > 0 || item.financial_risk?.credit_limit_blocked).length;
  const reserveCoverageCount = opportunities.filter((item) => findBestOwnUnit(item)).length;
  const partnerCoverageCount = opportunities.filter((item) => findBestSubrentPartner(item)).length;
  const confidenceGuardCount = opportunities.filter((item) =>
    evaluateOpportunityState(item).states.some((state) => state.state_code === 'extraction_low_confidence')).length;
  const avgMarginSource = opportunities
    .map((item) => item.economic_assessment?.expected_margin_percent)
    .filter((value) => value !== null && value !== undefined);
  const averageMargin = avgMarginSource.length
    ? Number((avgMarginSource.reduce((sum, value) => sum + value, 0) / avgMarginSource.length).toFixed(1))
    : null;
  const failedIngestCount = ingestIssues.filter((item) => item.processing_status === 'failed').length;
  const suspiciousIngestCount = ingestIssues.filter((item) => item.processing_status === 'suspicious').length;
  const unresolvedIngestCount = ingestIssues.filter((item) =>
    String(item.error_message ?? '').toLowerCase().includes('unable to resolve opportunity')).length;

  return {
    summary: {
      total_opportunities: opportunities.length,
      own_equipment_share: Math.round((ownEquipmentCount / totalOpportunities) * 100),
      subrent_dependency_share: Math.round((subrentCount / totalOpportunities) * 100),
      debt_exposure_share: Math.round((debtRiskCount / totalOpportunities) * 100),
      reserve_coverage_share: Math.round((reserveCoverageCount / totalOpportunities) * 100),
      partner_coverage_share: Math.round((partnerCoverageCount / totalOpportunities) * 100),
      confidence_guard_share: Math.round((confidenceGuardCount / totalOpportunities) * 100),
      average_margin_percent: averageMargin,
      margin_risk_share: Math.round((marginRiskCount / totalOpportunities) * 100),
      strategic_load_ready_share: Math.round((strategicLoadReadyCount / totalOpportunities) * 100),
      live_support_share: Math.round((liveSupportCount / totalOpportunities) * 100),
      recommendation_accepted_rate: Math.round((feedback.summary?.accepted_rate ?? 0) * 100),
      recommendation_executed_rate: Math.round((feedback.summary?.executed_rate ?? 0) * 100),
      ingest_failed_events: failedIngestCount,
      ingest_suspicious_events: suspiciousIngestCount,
      ingest_unresolved_events: unresolvedIngestCount,
    },
    items,
  };
}

export async function buildSystemStatusDashboard() {
  const [vectorStatus, graphStatus, pendingIngest, failedIngest, diagnostics, httpCheck, appMetadata, opportunities, feedback] = await Promise.all([
    getQdrantStatus(),
    getNeo4jStatus(),
    repository.listPendingIngestEvents?.(20) ?? [],
    repository.listFailedIngestEvents(50),
    repository.getSystemDiagnostics?.() ?? {},
    checkLocalHttpHealth(),
    getAppMetadata(),
    repository.listOpportunities(),
    repository.getFeedbackLearningSummary(50),
  ]);

  let postgres = {
    configured: hasPostgresConfig(),
    reachable: false,
  };

  if (postgres.configured) {
    try {
      await pgQuery('SELECT 1');
      postgres = {
        configured: true,
        reachable: true,
      };
    } catch {
      postgres = {
        configured: true,
        reachable: false,
      };
    }
  }

  const latestProcessedMinutes = diffMinutesFromNow(diagnostics.latest_processed_ingest_at ?? null);
  const latestIssueMinutes = diffMinutesFromNow(diagnostics.latest_ingest_issue_at ?? null);
  const latestRecommendationMinutes = diffMinutesFromNow(diagnostics.latest_recommendation_at ?? null);
  const latestAuditMinutes = diffMinutesFromNow(diagnostics.latest_audit_at ?? null);
  const uptimeMinutes = diffMinutesFromNow(APP_STARTED_AT);
  const latestOpportunityTouchAt = opportunities
    .map((item) => pickLatestTimestamp(item.last_touch_at, item.next_step?.due_at))
    .filter(Boolean)
    .sort((left, right) => new Date(right).getTime() - new Date(left).getTime())[0] ?? null;
  const latestOperationalTouchAt = pickLatestTimestamp(
    diagnostics.latest_processed_ingest_at ?? null,
    latestOpportunityTouchAt,
    diagnostics.latest_recommendation_at ?? null,
    diagnostics.latest_audit_at ?? null,
  );
  const latestOperationalTouchMinutes = diffMinutesFromNow(latestOperationalTouchAt);

  let freshnessState = 'active';
  if (!latestOperationalTouchAt) {
    freshnessState = 'idle';
  } else if (latestOperationalTouchMinutes !== null && latestOperationalTouchMinutes > 180) {
    freshnessState = 'stale';
  } else if (latestOperationalTouchMinutes !== null && latestOperationalTouchMinutes > 60) {
    freshnessState = 'warming';
  }

  const warnings = [];
  if (!postgres.reachable && postgres.configured) warnings.push('postgres_unreachable');
  if (vectorStatus.configured && !vectorStatus.reachable) warnings.push('qdrant_unreachable');
  if (graphStatus.configured && !graphStatus.reachable) warnings.push('neo4j_unreachable');
  if (!httpCheck.reachable) warnings.push('app_http_unreachable');
  if ((httpCheck.latency_ms ?? 0) > 500) warnings.push('app_http_slow');
  if (failedIngest.some((item) => item.processing_status === 'failed')) warnings.push('failed_ingest_present');
  if (pendingIngest.length > 10) warnings.push('ingest_backlog');
  if (freshnessState === 'stale') warnings.push('ingest_stale');

  const overallState = warnings.length
    ? (warnings.some((item) => item.endsWith('unreachable') || item === 'ingest_stale') ? 'degraded' : 'attention')
    : 'healthy';
  const totalOpportunities = opportunities.length || 1;
  const vectorPointCounts = Array.isArray(vectorStatus.collections)
    ? vectorStatus.collections.map((item) => Number(item.points_count ?? 0)).filter((value) => Number.isFinite(value) && value > 0)
    : [];
  const vectorCoverageBase = vectorPointCounts.length ? Math.max(...vectorPointCounts) : 0;
  const vectorLiveShare = vectorStatus.reachable
    ? Math.min(100, Math.round((vectorCoverageBase / totalOpportunities) * 100))
    : 0;
  const graphNodeCount = Number(graphStatus.nodes_count ?? 0);
  const graphLiveShare = graphStatus.reachable
    ? Math.min(100, Math.round((graphNodeCount / totalOpportunities) * 100))
    : 0;
  const systemStatus = {
    postgres,
    qdrant: vectorStatus,
    neo4j: graphStatus,
    ingest: {
      pending_count: pendingIngest.length,
      failed_count: failedIngest.filter((item) => item.processing_status === 'failed').length,
      suspicious_count: failedIngest.filter((item) => item.processing_status === 'suspicious').length,
      latest_ingest_at: diagnostics.latest_ingest_at ?? null,
      latest_processed_ingest_at: diagnostics.latest_processed_ingest_at ?? null,
      latest_issue_at: diagnostics.latest_ingest_issue_at ?? null,
      latest_operational_touch_at: latestOperationalTouchAt,
      freshness_state: freshnessState,
      latest_processed_age_min: latestProcessedMinutes,
      latest_operational_touch_age_min: latestOperationalTouchMinutes,
      latest_issue_age_min: latestIssueMinutes,
    },
    app: {
      service: 'bts-dss',
      app_name: appMetadata.name,
      app_version: appMetadata.version,
      git_sha: appMetadata.git_sha,
      environment: process.env.NODE_ENV ?? 'development',
      timestamp: new Date().toISOString(),
      started_at: APP_STARTED_AT,
      uptime_min: uptimeMinutes,
      live_state: 'alive',
      http_reachable: httpCheck.reachable,
      http_status_code: httpCheck.status_code,
      http_latency_ms: httpCheck.latency_ms,
      latest_recommendation_at: diagnostics.latest_recommendation_at ?? null,
      latest_recommendation_age_min: latestRecommendationMinutes,
      latest_audit_at: diagnostics.latest_audit_at ?? null,
      latest_audit_age_min: latestAuditMinutes,
    },
    learning: {
      readiness: feedback.summary?.learning_readiness ?? 'cold',
      total_feedback: feedback.summary?.total_feedback ?? 0,
      top_promote_action: feedback.summary?.top_promote_action ?? null,
      top_suppress_action: feedback.summary?.top_suppress_action ?? null,
    },
    live_support: {
      vector_live_share: vectorLiveShare,
      graph_live_share: graphLiveShare,
      vector_points_max: vectorCoverageBase,
      graph_nodes_count: graphNodeCount,
    },
    overall_state: overallState,
    warnings,
  };

  return {
    ...systemStatus,
    readiness: deriveReadiness(systemStatus),
    operational_checklist: buildOperationalChecklist(systemStatus),
  };
}

async function buildOpportunityGraphLiveFirst(opportunity) {
  const liveGraph = await getOpportunityGraphFromNeo4j(opportunity.id);
  if (liveGraph?.nodes?.length) {
    return liveGraph;
  }
  return buildOpportunityGraph(opportunity);
}

export async function buildManagerQueue({ limit = 20, bucket = '', state = '', mode = '', search = '' } = {}) {
  const normalizedSearch = search.trim().toLowerCase();
  const items = await buildManagerDashboard();
  return items
    .filter((item) => !bucket || item.priority_bucket === bucket)
    .filter((item) => !state || item.state_codes.includes(state))
    .filter((item) => {
      if (!mode) return true;
      if (mode === 'verify') return item.state_codes.includes('extraction_low_confidence');
      if (mode === 'blocked') return (item.why_blocked?.length ?? 0) > 0;
      if (mode === 'low_priority') return (item.why_low_priority?.length ?? 0) > 0;
      if (mode === 'overdue') {
        return item.state_codes.includes('hot_unworked')
          || item.state_codes.includes('manager_promise_overdue');
      }
      if (mode === 'attack_now') {
        return (item.why_blocked?.length ?? 0) === 0
          && (item.why_low_priority?.length ?? 0) === 0
          && ['critical', 'high'].includes(item.priority_bucket);
      }
      return true;
    })
    .filter((item) => {
      if (!normalizedSearch) return true;
      return [item.company, item.object, item.next_action, item.why_now]
        .filter(Boolean)
        .some((value) => value.toLowerCase().includes(normalizedSearch));
    })
    .slice(0, limit);
}

export async function buildOpportunityCard(opportunityId) {
  const opportunity = await repository.getOpportunityById(opportunityId);
  if (!opportunity) {
    return null;
  }

  const state = await evaluateAndPersistState(opportunity);
  const actionEffectiveness = await getActionEffectivenessMap();
  const decision = await evaluateAndPersistDecision(opportunity, actionEffectiveness);
  const stateHistory = await repository.listStateSnapshots(opportunityId);
  const recommendationsHistory = await repository.listRecommendations(opportunityId);
  const feedbackHistory = await repository.listFeedbackForOpportunity(opportunityId);
  const graph = await buildOpportunityGraphLiveFirst(opportunity);
  const similarCases = await getSimilarCases(opportunity, repository);
  const riskEvidence = collectSignalEvidence(opportunity);
  const extractionQuality = buildExtractionQuality(opportunity);
  const decisionTimeline = buildDecisionTimeline(stateHistory, recommendationsHistory, feedbackHistory);
  const stopSignals = buildStopSignals(opportunity, state, decision);
  const topSimilarCase = similarCases[0] ?? null;
  const similarCaseSources = Array.from(new Set((similarCases ?? []).map((item) => item.source).filter(Boolean)));
  const similarActionAlignment = topSimilarCase?.recommended_action_hint
    ? (topSimilarCase.recommended_action_hint === decision.recommended_action?.action_code ? 'aligned' : 'different')
    : null;
  const recommendedActionEffectiveness = actionEffectiveness.get(decision.recommended_action?.action_code ?? '') ?? null;
  const consideredAlternatives = (decision.explainability?.considered_alternatives ?? []).map((item) => ({
    ...item,
    action_effectiveness: actionEffectiveness.get(item.action_code ?? '') ?? null,
  }));
  const decisionSupportMarkers = [
    ...(graph.source === 'neo4j' ? ['graph:neo4j_live'] : []),
    ...(opportunity.graph_signals?.cross_sell_open ? ['graph:cross_sell'] : []),
    ...(opportunity.graph_signals?.competitor_present ? ['graph:competitor'] : []),
    ...(topSimilarCase ? [`semantic:${topSimilarCase.source ?? 'similar_case'}`] : []),
    ...(topSimilarCase?.source_mode === 'qdrant' ? ['semantic:qdrant_live'] : []),
    ...(recommendedActionEffectiveness ? ['learning:feedback_history'] : []),
  ];
  const decisionSupportLevel = decisionSupportMarkers.length >= 3
    ? 'high'
    : decisionSupportMarkers.length >= 2
      ? 'medium'
      : decisionSupportMarkers.length >= 1
        ? 'light'
        : 'minimal';

  return {
    opportunity_id: opportunity.id,
    bitrix_deal_id: opportunity.bitrix_deal_id,
    summary: {
      company: opportunity.company?.raw_value ?? null,
      contact: opportunity.contact_person?.raw_value ?? null,
      owner_manager: opportunity.owner_manager?.full_name ?? null,
      object: opportunity.project_object?.raw_value ?? null,
      equipment_type: opportunity.equipment_type?.normalized_value ?? opportunity.equipment_type?.raw_value ?? null,
      commercial_stage: opportunity.commercial_stage ?? null,
      last_touch_at: opportunity.last_touch_at ?? null,
    },
    opportunity_unit: opportunity,
    score_vector: state.scores,
    priority_score: state.priority_score,
    states: state.states,
    recommendation: {
      recommendation_id: decision.recommendation_id ?? null,
      recommendation_status: decision.recommendation_status ?? null,
      action_code: decision.recommended_action?.action_code ?? null,
      action_name: decision.recommended_action?.action_name ?? null,
      target_role: decision.recommended_action?.target_role ?? null,
      deadline_at: decision.deadline_at,
      escalation_action_code: decision.escalation_action?.action_code ?? null,
      explainability: {
        ...decision.explainability,
        similar_case_hint: topSimilarCase
          ? `${topSimilarCase.title} · ${topSimilarCase.outcome} · ${topSimilarCase.source}${topSimilarCase.recommended_action_hint ? ` · action ${topSimilarCase.recommended_action_hint}` : ''}${similarActionAlignment ? ` · ${similarActionAlignment}` : ''}`
          : decision.explainability.similar_case_hint,
        learning_hint: recommendedActionEffectiveness
          ? `Исторически действие ${decision.recommended_action?.action_code} принимается в ${Math.round((recommendedActionEffectiveness.accepted_rate ?? 0) * 100)}% случаев и исполняется в ${Math.round((recommendedActionEffectiveness.executed_rate ?? 0) * 100)}% случаев.`
          : 'Пока недостаточно feedback-истории, чтобы оценить эффективность действия.',
        considered_alternatives: consideredAlternatives,
      },
      action_effectiveness: actionEffectiveness.get(decision.recommended_action?.action_code ?? '') ?? null,
    },
    recommendation_signals: {
      contract_ready: state.states.some((item) => item.state_code === 'client_ready_for_contract'),
      decision_access: state.states.some((item) => item.state_code === 'decision_maker_reached'),
      spec_strong: state.states.some((item) => item.state_code === 'spec_strong'),
      confidence_guard: state.states.some((item) => item.state_code === 'extraction_low_confidence'),
      markers: [
        ...(state.states.some((item) => item.state_code === 'client_ready_for_contract') ? ['contract ready'] : []),
        ...(state.states.some((item) => item.state_code === 'decision_maker_reached') ? ['decision access'] : []),
        ...(state.states.some((item) => item.state_code === 'spec_strong') ? ['spec strong'] : []),
        ...(state.states.some((item) => item.state_code === 'extraction_low_confidence') ? ['verify extraction'] : []),
      ],
    },
    decision_support: {
      support_level: decisionSupportLevel,
      graph_support: Boolean(graph?.nodes?.length),
      graph_source: graph.source ?? 'fallback',
      semantic_support: Boolean(topSimilarCase),
      semantic_source: topSimilarCase?.source_mode ?? null,
      learning_support: Boolean(recommendedActionEffectiveness),
      confidence_guard: state.states.some((item) => item.state_code === 'extraction_low_confidence'),
      support_markers: decisionSupportMarkers,
    },
    communication_history: (opportunity.communication_events ?? []).slice(0, 12),
    enriched_context: {
      equipment_model: opportunity.equipment_model ?? null,
      work_conditions: opportunity.work_conditions ?? [],
      price_context: opportunity.price_context ?? null,
      client_expected_next_step: opportunity.client_expected_next_step ?? null,
      geo_hint: opportunity.geo_hint ?? null,
      readiness_signals: opportunity.readiness_signals ?? {},
    },
    risk_evidence: riskEvidence,
    extraction_quality: extractionQuality,
    stop_signals: stopSignals,
    similar_cases_summary: {
      total: similarCases.length,
      primary_source: topSimilarCase?.source ?? null,
      sources: similarCaseSources,
      vector_live: similarCases.some((item) => item.source_mode === 'qdrant'),
      support_level: topSimilarCase?.support_level ?? null,
    },
    similar_cases: similarCases,
    recommendations_history: recommendationsHistory,
    feedback_history: feedbackHistory,
    decision_timeline: decisionTimeline,
    state_history: stateHistory,
    graph,
  };
}

export function buildOpportunityGraph(opportunity) {
  const nodes = [];
  const edges = [];

  const opportunityNodeId = `opportunity:${opportunity.id}`;
  nodes.push({
    id: opportunityNodeId,
    label: `Opportunity ${opportunity.bitrix_deal_id ?? opportunity.id}`,
    type: 'Opportunity',
  });

  if (opportunity.company?.raw_value) {
    const companyId = opportunity.company.resolved_entity_id ?? `company:${opportunity.company.normalized_value ?? opportunity.company.raw_value}`;
    nodes.push({
      id: companyId,
      label: opportunity.company.raw_value,
      type: 'Company',
    });
    edges.push({ source: opportunityNodeId, target: companyId, type: 'FOR_COMPANY' });
  }

  if (opportunity.contact_person?.raw_value) {
    const personId = opportunity.contact_person.resolved_entity_id ?? `person:${opportunity.contact_person.normalized_value ?? opportunity.contact_person.raw_value}`;
    nodes.push({
      id: personId,
      label: opportunity.contact_person.raw_value,
      type: 'Person',
    });
    edges.push({ source: opportunityNodeId, target: personId, type: 'ASSIGNED_TO' });
    if (opportunity.company?.raw_value) {
      const companyId = opportunity.company.resolved_entity_id ?? `company:${opportunity.company.normalized_value ?? opportunity.company.raw_value}`;
      edges.push({ source: personId, target: companyId, type: 'WORKS_FOR' });
    }
  }

  if (opportunity.project_object?.raw_value) {
    const objectId = opportunity.project_object.resolved_entity_id ?? `object:${opportunity.project_object.normalized_value ?? opportunity.project_object.raw_value}`;
    nodes.push({
      id: objectId,
      label: opportunity.project_object.raw_value,
      type: 'ProjectObject',
    });
    edges.push({ source: opportunityNodeId, target: objectId, type: 'FOR_OBJECT' });
  }

  if (opportunity.equipment_type?.normalized_value || opportunity.equipment_type?.raw_value) {
    const equipmentLabel = opportunity.equipment_type.normalized_value ?? opportunity.equipment_type.raw_value;
    const equipmentId = opportunity.equipment_type.resolved_entity_id ?? `equipment:${equipmentLabel.toLowerCase()}`;
    nodes.push({
      id: equipmentId,
      label: equipmentLabel,
      type: 'EquipmentType',
    });
    edges.push({ source: opportunityNodeId, target: equipmentId, type: 'NEEDS' });
    if (opportunity.project_object?.raw_value) {
      const objectId = opportunity.project_object.resolved_entity_id ?? `object:${opportunity.project_object.normalized_value ?? opportunity.project_object.raw_value}`;
      edges.push({ source: objectId, target: equipmentId, type: 'USES' });
    }
  }

  if (opportunity.graph_signals?.competitor_present) {
    const competitorId = `competitor:${opportunity.id}`;
    nodes.push({
      id: competitorId,
      label: 'Конкурент на объекте',
      type: 'Competitor',
    });
    if (opportunity.project_object?.raw_value) {
      const objectId = opportunity.project_object.resolved_entity_id ?? `object:${opportunity.project_object.normalized_value ?? opportunity.project_object.raw_value}`;
      edges.push({ source: objectId, target: competitorId, type: 'HAS_COMPETITOR' });
    }
  }

  if (opportunity.graph_signals?.cross_sell_open) {
    const crossSellId = `cross-sell:${opportunity.id}`;
    nodes.push({
      id: crossSellId,
      label: 'Кросс-продажа',
      type: 'Scenario',
    });
    edges.push({ source: opportunityNodeId, target: crossSellId, type: 'CROSS_SELL_OPEN' });
  }

  for (const event of (opportunity.communication_events ?? []).slice(0, 3)) {
    const eventId = `event:${event.id}`;
    nodes.push({
      id: eventId,
      label: event.summary || event.type,
      type: 'CommunicationEvent',
    });
    edges.push({ source: opportunityNodeId, target: eventId, type: 'HAS_EVENT' });
  }

  const dedupedNodes = Array.from(new Map(nodes.map((node) => [node.id, node])).values());
  const dedupedEdges = Array.from(new Map(edges.map((edge) => [`${edge.source}:${edge.target}:${edge.type}`, edge])).values());

  return {
    opportunity_id: opportunity.id,
    object_id: opportunity.project_object?.resolved_entity_id ?? null,
    nodes: dedupedNodes,
    edges: dedupedEdges,
    source: 'fallback',
    summary: {
      nodes_count: dedupedNodes.length,
      edges_count: dedupedEdges.length,
    },
  };
}

function buildQualityIssues(opportunity) {
  const issues = [];
  if (!opportunity.company?.normalized_value) issues.push('company_not_normalized');
  if (!opportunity.project_object?.normalized_value) issues.push('object_not_normalized');
  if (!opportunity.equipment_type?.normalized_value) issues.push('equipment_missing');
  if (!opportunity.time_window?.start_at) issues.push('start_date_missing');
  if (!opportunity.time_window?.duration_days) issues.push('duration_missing');
  if (!opportunity.owner_manager?.external_id) issues.push('owner_manager_missing');
  if (!opportunity.next_step?.code && !opportunity.next_step?.description) issues.push('next_step_missing');
  if (!opportunity.last_touch_at) issues.push('last_touch_missing');
  if (!(opportunity.communication_events ?? []).length) issues.push('no_linked_events');
  if (!(opportunity.communication_events ?? []).some((item) => item.channel)) issues.push('channel_missing');
  if (!opportunity.geo_hint?.normalized_value && !opportunity.address?.normalized_value) issues.push('geo_hint_missing');
  if (!opportunity.client_expected_next_step && !opportunity.next_step?.code) issues.push('client_next_step_missing');
  if (!opportunity.payment_readiness || opportunity.payment_readiness === 'early') issues.push('payment_readiness_weak');
  if (!['decision_maker', 'influencer'].includes(opportunity.decision_access_status ?? 'unknown')) issues.push('decision_access_unknown');
  const extractionQuality = buildExtractionQuality(opportunity);
  if (extractionQuality.low_confidence_fields.includes('object')) issues.push('object_low_confidence');
  if (extractionQuality.low_confidence_fields.includes('equipment')) issues.push('equipment_low_confidence');
  if (extractionQuality.low_confidence_fields.includes('person')) issues.push('person_low_confidence');
  if (extractionQuality.low_confidence_fields.includes('geo')) issues.push('geo_low_confidence');
  if (extractionQuality.low_confidence_fields.includes('price')) issues.push('price_low_confidence');
  if (evaluateOpportunityState(opportunity).states.some((item) => item.state_code === 'extraction_low_confidence')) {
    issues.push('confidence_guard_active');
  }
  return issues;
}

function buildIngestIssueMap(ingestEvents) {
  const byOpportunity = new Map();

  for (const event of ingestEvents) {
    try {
      const patch = buildBitrixEntityPatch(event.payload);
      const opportunityId = patch.kind === 'deal'
        ? String(patch.external_id)
        : (patch.opportunity_external_id ? String(patch.opportunity_external_id) : null);
      if (!opportunityId) continue;

      const issues = byOpportunity.get(opportunityId) ?? [];
      if (event.processing_status === 'suspicious') {
        issues.push('suspicious_ingest_match');
      }
      if (event.processing_status === 'failed') {
        issues.push('failed_ingest_event');
      }
      if (String(event.error_message ?? '').toLowerCase().includes('unable to resolve opportunity')) {
        issues.push('unresolved_ingest_event');
      }
      if (String(event.error_message ?? '').toLowerCase().includes('accepted normalization alias')) {
        issues.push('alias_assisted_match');
      }
      byOpportunity.set(opportunityId, Array.from(new Set(issues)));
    } catch {
      continue;
    }
  }

  return byOpportunity;
}

export async function buildDataQualityDashboard() {
  const [opportunities, failedIngest, normalizationResults] = await Promise.all([
    repository.listOpportunities(),
    repository.listFailedIngestEvents(200),
    repository.listNormalizationResults(1000),
  ]);

  const totalOpportunities = opportunities.length || 1;
  const ingestFailedCount = failedIngest.filter((item) => item.processing_status === 'failed').length;
  const ingestSuspiciousCount = failedIngest.filter((item) => item.processing_status === 'suspicious').length;
  const ingestUnresolvedCount = failedIngest.filter((item) =>
    String(item.error_message ?? '').toLowerCase().includes('unable to resolve opportunity')).length;
  const ingestAliasAssistedCount = failedIngest.filter((item) =>
    String(item.error_message ?? '').toLowerCase().includes('accepted normalization alias')).length;
  const ingestIssueMap = buildIngestIssueMap(failedIngest);
  const opportunitiesWithIngestRisk = ingestIssueMap.size;
  const opportunitiesWithConfidenceGuard = opportunities.filter((item) =>
    evaluateOpportunityState(item).states.some((state) => state.state_code === 'extraction_low_confidence')).length;
  const opportunitiesLinkedToUnit = opportunities.filter((item) =>
    item.company?.normalized_value
    && item.project_object?.normalized_value
    && item.equipment_type?.normalized_value).length;
  const linkedEventsCount = opportunities.filter((item) => (item.communication_events ?? []).length > 0).length;
  const normalizedObjectsCount = opportunities.filter((item) => item.project_object?.normalized_value).length;
  const withoutNextStep = opportunities.filter((item) => !item.next_step?.code && !item.next_step?.description).length;
  const missingEquipment = opportunities.filter((item) => !item.equipment_type?.normalized_value).length;
  const competitorSignals = opportunities.filter((item) => item.graph_signals?.competitor_present).length;
  const competitorWithConfidence = opportunities.filter((item) =>
    (item.communication_events ?? []).some((event) => (event.extraction_json?.competitor?.confidence ?? 0) > 0)).length;
  const actionsWithExecutionLog = opportunities.filter((item) =>
    Array.isArray(item.communication_events) && item.communication_events.length > 0).length;
  const opportunitiesWithClientIntent = opportunities.filter((item) => item.client_expected_next_step).length;
  const opportunitiesWithPriceContext = opportunities.filter((item) => item.price_context?.raw_value).length;
  const opportunitiesWithLogisticsContext = opportunities.filter((item) => (item.work_conditions?.length ?? 0) > 0).length;
  const opportunitiesWithGeoHint = opportunities.filter((item) => item.geo_hint?.normalized_value || item.address?.normalized_value).length;
  const opportunitiesWithPaymentReadiness = opportunities.filter((item) => item.payment_readiness && item.payment_readiness !== 'early').length;
  const opportunitiesWithDecisionAccess = opportunities.filter((item) => ['decision_maker', 'influencer'].includes(item.decision_access_status ?? 'unknown')).length;
  const opportunitiesWithNextStepSignal = opportunities.filter((item) => item.client_expected_next_step || item.next_step?.code || item.next_step?.description).length;
  const coverageMetrics = [
    {
      field_code: 'client',
      label: 'Клиент',
      filled_count: opportunities.filter((item) => item.company?.normalized_value).length,
      target_percent: 90,
    },
    {
      field_code: 'object',
      label: 'Объект',
      filled_count: opportunities.filter((item) => item.project_object?.normalized_value).length,
      target_percent: 85,
    },
    {
      field_code: 'equipment_type',
      label: 'Тип техники',
      filled_count: opportunities.filter((item) => item.equipment_type?.normalized_value).length,
      target_percent: 90,
    },
    {
      field_code: 'requested_start_at',
      label: 'Предполагаемая дата',
      filled_count: opportunities.filter((item) => item.time_window?.start_at).length,
      target_percent: 90,
    },
    {
      field_code: 'duration_days',
      label: 'Длительность',
      filled_count: opportunities.filter((item) => item.time_window?.duration_days).length,
      target_percent: 90,
    },
    {
      field_code: 'channel',
      label: 'Канал связи',
      filled_count: opportunities.filter((item) => (item.communication_events ?? []).some((event) => event.channel)).length,
      target_percent: 90,
    },
    {
      field_code: 'last_touch_at',
      label: 'Последнее касание',
      filled_count: opportunities.filter((item) => item.last_touch_at).length,
      target_percent: 90,
    },
    {
      field_code: 'owner_manager',
      label: 'Ответственный',
      filled_count: opportunities.filter((item) => item.owner_manager?.external_id).length,
      target_percent: 95,
    },
    {
      field_code: 'next_step',
      label: 'Следующий шаг',
      filled_count: opportunities.filter((item) => item.next_step?.code || item.next_step?.description).length,
      target_percent: 95,
    },
    {
      field_code: 'geo_hint',
      label: 'Гео-контекст',
      filled_count: opportunitiesWithGeoHint,
      target_percent: 80,
    },
    {
      field_code: 'payment_readiness',
      label: 'Готовность к оплате',
      filled_count: opportunitiesWithPaymentReadiness,
      target_percent: 80,
    },
    {
      field_code: 'decision_access',
      label: 'Доступ к роли',
      filled_count: opportunitiesWithDecisionAccess,
      target_percent: 75,
    },
  ].map((item) => {
    const filledPercent = Math.round((item.filled_count / totalOpportunities) * 100);
    return {
      ...item,
      filled_percent: filledPercent,
      status: filledPercent >= item.target_percent ? 'ok' : filledPercent >= Math.max(50, item.target_percent - 20) ? 'warning' : 'critical',
    };
  });

  const items = opportunities
    .map((opportunity) => {
      const ingestIssues = ingestIssueMap.get(String(opportunity.id)) ?? [];
      const issues = [...buildQualityIssues(opportunity), ...ingestIssues];
      return {
        opportunity_id: opportunity.id,
        company: opportunity.company?.raw_value ?? null,
        object: opportunity.project_object?.raw_value ?? null,
        quality_score: Math.max(0, 100 - (issues.length * 18)),
        issues,
        ingest_issues: ingestIssues,
        extraction_confidence: buildExtractionQuality(opportunity),
      };
    })
    .filter((item) => item.issues.length > 0)
    .sort((left, right) => left.quality_score - right.quality_score);
  const issueBreakdown = Array.from(
    items.reduce((accumulator, item) => {
      for (const issue of item.issues) {
        accumulator.set(issue, (accumulator.get(issue) ?? 0) + 1);
      }
      return accumulator;
    }, new Map()).entries(),
  )
    .map(([issue_code, count]) => ({ issue_code, count }))
    .sort((left, right) => right.count - left.count);

  return {
    summary: {
      total_opportunities: opportunities.length,
      linked_events_percent: Math.round((linkedEventsCount / totalOpportunities) * 100),
      normalized_objects_percent: Math.round((normalizedObjectsCount / totalOpportunities) * 100),
      linked_opportunity_unit_percent: Math.round((opportunitiesLinkedToUnit / totalOpportunities) * 100),
      competitor_confidence_percent: competitorSignals ? Math.round((competitorWithConfidence / competitorSignals) * 100) : 100,
      execution_log_percent: Math.round((actionsWithExecutionLog / totalOpportunities) * 100),
      client_intent_percent: Math.round((opportunitiesWithClientIntent / totalOpportunities) * 100),
      price_context_percent: Math.round((opportunitiesWithPriceContext / totalOpportunities) * 100),
      logistics_context_percent: Math.round((opportunitiesWithLogisticsContext / totalOpportunities) * 100),
      geo_hint_percent: Math.round((opportunitiesWithGeoHint / totalOpportunities) * 100),
      payment_readiness_percent: Math.round((opportunitiesWithPaymentReadiness / totalOpportunities) * 100),
      decision_access_percent: Math.round((opportunitiesWithDecisionAccess / totalOpportunities) * 100),
      next_step_signal_percent: Math.round((opportunitiesWithNextStepSignal / totalOpportunities) * 100),
      opportunities_without_next_step: withoutNextStep,
      opportunities_missing_equipment: missingEquipment,
      failed_ingest_events: ingestFailedCount,
      suspicious_ingest_events: ingestSuspiciousCount,
      unresolved_ingest_events: ingestUnresolvedCount,
      alias_assisted_ingest_events: ingestAliasAssistedCount,
      opportunities_with_ingest_risk: opportunitiesWithIngestRisk,
      confidence_guard_events: opportunitiesWithConfidenceGuard,
      normalization_records: normalizationResults.length,
      threshold_checks: [
        {
          code: 'opportunity_unit_link_rate',
          actual_percent: Math.round((opportunitiesLinkedToUnit / totalOpportunities) * 100),
          target_percent: 90,
        },
        {
          code: 'normalized_objects_rate',
          actual_percent: Math.round((normalizedObjectsCount / totalOpportunities) * 100),
          target_percent: 85,
        },
        {
          code: 'competitor_confidence_rate',
          actual_percent: competitorSignals ? Math.round((competitorWithConfidence / competitorSignals) * 100) : 100,
          target_percent: 80,
        },
        {
          code: 'action_execution_log_rate',
          actual_percent: Math.round((actionsWithExecutionLog / totalOpportunities) * 100),
          target_percent: 95,
        },
        {
          code: 'geo_hint_rate',
          actual_percent: Math.round((opportunitiesWithGeoHint / totalOpportunities) * 100),
          target_percent: 80,
        },
        {
          code: 'payment_readiness_rate',
          actual_percent: Math.round((opportunitiesWithPaymentReadiness / totalOpportunities) * 100),
          target_percent: 80,
        },
        {
          code: 'decision_access_rate',
          actual_percent: Math.round((opportunitiesWithDecisionAccess / totalOpportunities) * 100),
          target_percent: 75,
        },
      ].map((item) => ({
        ...item,
        status: item.actual_percent >= item.target_percent ? 'ok' : item.actual_percent >= item.target_percent - 15 ? 'warning' : 'critical',
      })),
      critical_fields: coverageMetrics,
      issue_breakdown: issueBreakdown,
    },
    items,
  };
}

export async function buildNormalizationDashboard({ action = '' } = {}) {
  const opportunities = await repository.listOpportunities();

  const companies = opportunities
    .filter((item) => item.company?.raw_value)
    .map((item) => ({
      opportunity_id: item.id,
      ...item.company,
    }));

  const objects = opportunities
    .filter((item) => item.project_object?.raw_value)
    .map((item) => ({
      opportunity_id: item.id,
      address: item.address?.normalized_value ?? item.address?.raw_value ?? null,
      equipment: item.equipment_type?.normalized_value ?? item.equipment_type?.raw_value ?? null,
      ...item.project_object,
    }));

  const persons = opportunities
    .filter((item) => item.contact_person?.raw_value)
    .map((item) => ({
      opportunity_id: item.id,
      raw_value: item.contact_person.raw_value,
      normalized_value: item.contact_person.normalized_value,
      resolved_entity_id: item.contact_person.resolved_entity_id,
      confidence_score: item.contact_person.confidence_score,
      role: item.contact_person.role ?? null,
      company: item.company?.normalized_value ?? item.company?.raw_value ?? null,
    }));

  const candidates = [
    ...findDuplicateCandidates(companies, {
      kind: 'company',
      getReferenceId: (item) => `${item.opportunity_id}:${item.resolved_entity_id ?? item.raw_value}`,
    }),
    ...findContextualDuplicateCandidates(objects, {
      kind: 'object',
      threshold: 0.74,
      getReferenceId: (item) => `${item.opportunity_id}:${item.resolved_entity_id ?? item.raw_value}`,
      getContext: (item) => ({
        address: item.address,
        equipment: item.equipment,
      }),
    }),
    ...findContextualDuplicateCandidates(persons, {
      kind: 'person',
      threshold: 0.8,
      getReferenceId: (item) => `${item.opportunity_id}:${item.resolved_entity_id ?? item.raw_value}`,
      getContext: (item) => ({
        role: item.role,
        company: item.company,
      }),
    }),
  ]
    .map((item) => {
      const candidateKey = [
        item.entity_kind,
        item.left_label,
        item.right_label,
      ].join('::').toLowerCase();
      const priority = item.similarity_score >= 0.92
        ? 'merge_now'
        : item.similarity_score >= 0.84
          ? 'review_fast'
          : 'review';
      return {
        ...item,
        candidate_key: candidateKey,
        merge_priority: priority,
        suggested_action: priority === 'merge_now'
          ? 'Объединить автоматически после проверки'
          : priority === 'review_fast'
            ? 'Проверить и объединить вручную в первую очередь'
            : 'Оставить в очереди на ручную верификацию',
      };
    })
    .sort((left, right) => right.similarity_score - left.similarity_score)
    .slice(0, 50);
  const candidatesWithDecisions = await Promise.all(
    candidates.map(async (item) => ({
      ...item,
      decision: await repository.getNormalizationDecision(item.candidate_key),
    })),
  );
  const priorityBreakdown = ['merge_now', 'review_fast', 'review']
    .map((priority_code) => ({
      priority_code,
      count: candidatesWithDecisions.filter((item) => item.merge_priority === priority_code && !item.decision).length,
    }))
    .filter((item) => item.count > 0);

  const unresolvedCandidates = candidatesWithDecisions.filter((item) => !item.decision);
  const decisionBreakdown = ['accepted', 'review_later', 'ignored']
    .map((decision_status) => ({
      decision_status,
      count: candidatesWithDecisions.filter((item) => item.decision?.decision_status === decision_status).length,
    }))
    .filter((item) => item.count > 0);
  const filteredCandidates = action
    ? unresolvedCandidates.filter((item) => item.merge_priority === action)
    : unresolvedCandidates;

  return {
    summary: {
      companies_seen: companies.length,
      objects_seen: objects.length,
      persons_seen: persons.length,
      duplicate_candidates: unresolvedCandidates.length,
      priority_breakdown: priorityBreakdown,
      decision_breakdown: decisionBreakdown,
    },
    items: filteredCandidates,
  };
}

export async function buildFeedbackLearningDashboard() {
  return repository.getFeedbackLearningSummary(12);
}

function buildKpi({ label, value, tone, target = null, delta = null, trend = 'flat' }) {
  return { label, value, tone, target, delta, trend };
}

function buildDomainSignal(label, tone = 'low', value = null) {
  return { label, tone, value };
}

function formatSignedNumber(value, suffix = '') {
  if (!Number.isFinite(value)) return null;
  const rounded = Math.round(value * 10) / 10;
  const prefix = rounded > 0 ? '+' : '';
  return `${prefix}${rounded}${suffix}`;
}

function buildRatioKpi({
  label,
  numerator,
  denominator,
  threshold,
  tone = 'medium',
  targetLabel,
}) {
  if (!denominator) {
    return buildKpi({
      label,
      value: `0/0`,
      tone,
      target: targetLabel,
      delta: null,
      trend: 'flat',
    });
  }

  const percent = Math.round((numerator / denominator) * 100);
  return buildKpi({
    label,
    value: `${numerator}/${denominator} (${percent}%)`,
    tone,
    target: targetLabel,
    delta: formatSignedNumber(percent - threshold, ' pp'),
    trend: percent >= threshold ? 'up' : 'down',
  });
}

function buildFinanceDomainSummary({ queueItems, ropItems, ownerSummary, systemIngest, opportunities }) {
  const financeItems = queueItems.filter((item) => item.state_codes?.includes('debt_risk'));
  const marginRiskDeals = opportunities.filter((item) => {
    const margin = item.economic_assessment?.expected_margin_percent ?? null;
    return margin !== null && margin < 15;
  }).length;
  const blockedCredits = opportunities.filter((item) => item.financial_risk?.credit_limit_blocked).length;
  const overdueDebtDeals = opportunities.filter((item) => (item.financial_risk?.debt_overdue_days ?? 0) > 0).length;
  const readyForMoneyFlow = opportunities.filter((item) =>
    item.payment_readiness === 'ready' || item.payment_readiness === 'ready_for_offer').length;

  return {
    summary: `Сейчас в финансовом контуре ${financeItems.length} сделок с риском по оплате или ограничениям, ${marginRiskDeals} сделок с давлением на маржу и ${ropItems.length} управленческих эскалаций.`,
    kpis: [
      buildKpi({ label: 'Debt Risk Deals', value: String(financeItems.length), tone: financeItems.length > 0 ? 'high' : 'low', target: '0', delta: financeItems.length > 0 ? `+${financeItems.length}` : '0', trend: financeItems.length > 0 ? 'up' : 'flat' }),
      buildKpi({ label: 'Avg Margin', value: ownerSummary.average_margin_percent !== null && ownerSummary.average_margin_percent !== undefined ? `${ownerSummary.average_margin_percent}%` : '—', tone: 'medium', target: '22%+', delta: ownerSummary.average_margin_percent !== null && ownerSummary.average_margin_percent !== undefined ? formatSignedNumber(ownerSummary.average_margin_percent - 22, ' pp') : null, trend: (ownerSummary.average_margin_percent ?? 0) >= 22 ? 'up' : 'down' }),
      buildKpi({ label: 'Debt Exposure', value: Number.isFinite(ownerSummary.debt_exposure_share) ? `${ownerSummary.debt_exposure_share}%` : '—', tone: 'high', target: '<15%', delta: Number.isFinite(ownerSummary.debt_exposure_share) ? formatSignedNumber(ownerSummary.debt_exposure_share - 15, ' pp') : null, trend: (ownerSummary.debt_exposure_share ?? 0) > 15 ? 'up' : 'down' }),
      buildKpi({ label: 'Ingest Freshness', value: systemIngest.freshness_state ?? '—', tone: systemIngest.freshness_state === 'stale' ? 'critical' : 'low', target: 'active', delta: null, trend: systemIngest.freshness_state === 'stale' ? 'down' : 'flat' }),
      buildKpi({ label: 'Margin Risk Deals', value: String(marginRiskDeals), tone: marginRiskDeals > 0 ? 'high' : 'low', target: '0', delta: marginRiskDeals > 0 ? `+${marginRiskDeals}` : '0', trend: marginRiskDeals > 0 ? 'up' : 'flat' }),
      buildKpi({ label: 'Credit Blocks', value: String(blockedCredits), tone: blockedCredits > 0 ? 'critical' : 'low', target: '0', delta: blockedCredits > 0 ? `+${blockedCredits}` : '0', trend: blockedCredits > 0 ? 'up' : 'flat' }),
      buildKpi({ label: 'Overdue Debt', value: String(overdueDebtDeals), tone: overdueDebtDeals > 0 ? 'high' : 'low', target: '0', delta: overdueDebtDeals > 0 ? `+${overdueDebtDeals}` : '0', trend: overdueDebtDeals > 0 ? 'up' : 'flat' }),
      buildRatioKpi({ label: 'Payment Ready', numerator: readyForMoneyFlow, denominator: opportunities.length || 0, threshold: 70, tone: 'medium', targetLabel: '70%+' }),
    ],
    states: [
      buildDomainSignal(blockedCredits > 0 ? 'Кредитные ограничения активны' : 'Кредитные ограничения не активны', blockedCredits > 0 ? 'critical' : 'low', `${blockedCredits}`),
      buildDomainSignal(overdueDebtDeals > 0 ? 'Есть сделки с просрочкой дебиторки' : 'Просроченная дебиторка не доминирует', overdueDebtDeals > 0 ? 'high' : 'low', `${overdueDebtDeals}`),
      buildDomainSignal(marginRiskDeals > 0 ? 'Маржа по части сделок ниже порога' : 'Маржинальный порог в норме', marginRiskDeals > 0 ? 'high' : 'low', `${marginRiskDeals}`),
    ],
    decisions: [
      buildDomainSignal(blockedCredits > 0 ? 'Эскалировать блокировки в CFO/CEO и пересмотреть условия оплаты' : 'Поддерживать текущий кредитный режим', blockedCredits > 0 ? 'critical' : 'low'),
      buildDomainSignal(overdueDebtDeals > 0 ? 'Запустить ускорение дебиторки и обзвон должников' : 'Сохранять стандартный контроль дебиторки', overdueDebtDeals > 0 ? 'high' : 'low'),
      buildDomainSignal(readyForMoneyFlow < Math.ceil((opportunities.length || 0) * 0.7) ? 'Усилить перевод сделок в payment-ready' : 'Фокус держать на сохранении платежной готовности', readyForMoneyFlow < Math.ceil((opportunities.length || 0) * 0.7) ? 'medium' : 'low'),
    ],
    sensors: [
      buildDomainSignal('Debt risk queue', financeItems.length > 0 ? 'high' : 'low', `${financeItems.length}`),
      buildDomainSignal('Owner margin summary', 'medium', ownerSummary.average_margin_percent !== null && ownerSummary.average_margin_percent !== undefined ? `${ownerSummary.average_margin_percent}%` : '—'),
      buildDomainSignal('System ingest freshness', systemIngest.freshness_state === 'stale' ? 'critical' : 'low', systemIngest.freshness_state ?? '—'),
    ],
  };
}

function buildMarketingDomainSummary({ qualitySummary, normalizationSummary, feedbackSummary }) {
  const clientIntentPercent = qualitySummary.client_intent_percent ?? 0;
  const priceContextPercent = qualitySummary.price_context_percent ?? 0;
  const linkedEventsPercent = qualitySummary.linked_events_percent ?? 0;
  const competitorConfidencePercent = qualitySummary.competitor_confidence_percent ?? 0;
  const learningCoveragePercent = Math.round((feedbackSummary.recommendation_coverage ?? 0) * 100);
  const duplicateCandidates = normalizationSummary.duplicate_candidates ?? 0;
  const promoteAction = feedbackSummary.top_promote_action ?? '—';

  return {
    summary: `Маркетинговый контур сейчас опирается на полноту клиентского интента (${clientIntentPercent}%), ценовой контекст (${priceContextPercent}%) и покрытие обучением (${learningCoveragePercent}%). Также в системе ${duplicateCandidates} неразобранных дублей, которые искажают оценку спроса.`,
    kpis: [
      buildKpi({ label: 'Client Intent', value: Number.isFinite(clientIntentPercent) ? `${clientIntentPercent}%` : '—', tone: clientIntentPercent < 60 ? 'high' : 'medium', target: '70%+', delta: formatSignedNumber(clientIntentPercent - 70, ' pp'), trend: clientIntentPercent >= 70 ? 'up' : 'down' }),
      buildKpi({ label: 'Price Context', value: Number.isFinite(priceContextPercent) ? `${priceContextPercent}%` : '—', tone: priceContextPercent < 60 ? 'high' : 'low', target: '70%+', delta: formatSignedNumber(priceContextPercent - 70, ' pp'), trend: priceContextPercent >= 70 ? 'up' : 'down' }),
      buildKpi({ label: 'Linked Events', value: Number.isFinite(linkedEventsPercent) ? `${linkedEventsPercent}%` : '—', tone: linkedEventsPercent < 75 ? 'high' : 'low', target: '85%+', delta: formatSignedNumber(linkedEventsPercent - 85, ' pp'), trend: linkedEventsPercent >= 85 ? 'up' : 'down' }),
      buildKpi({ label: 'Competitor Signal', value: Number.isFinite(competitorConfidencePercent) ? `${competitorConfidencePercent}%` : '—', tone: 'medium', target: '60%+', delta: formatSignedNumber(competitorConfidencePercent - 60, ' pp'), trend: competitorConfidencePercent >= 60 ? 'up' : 'down' }),
      buildKpi({ label: 'Learning Coverage', value: `${learningCoveragePercent}%`, tone: learningCoveragePercent < 50 ? 'high' : 'medium', target: '65%+', delta: formatSignedNumber(learningCoveragePercent - 65, ' pp'), trend: learningCoveragePercent >= 65 ? 'up' : 'down' }),
      buildKpi({ label: 'Promote Action', value: String(promoteAction), tone: 'low', target: 'defined', delta: null, trend: promoteAction !== '—' ? 'up' : 'flat' }),
      buildKpi({ label: 'Duplicate Candidates', value: String(duplicateCandidates), tone: duplicateCandidates > 0 ? 'high' : 'low', target: '0', delta: duplicateCandidates > 0 ? `+${duplicateCandidates}` : '0', trend: duplicateCandidates > 0 ? 'up' : 'flat' }),
      buildKpi({ label: 'Normalization Scope', value: String(normalizationSummary.companies_seen ?? 0), tone: 'low', target: 'growing', delta: null, trend: 'up' }),
    ],
    states: [
      buildDomainSignal(clientIntentPercent < 70 ? 'Клиентский интент заполнен не полностью' : 'Клиентский интент покрыт на рабочем уровне', clientIntentPercent < 70 ? 'high' : 'low', `${clientIntentPercent}%`),
      buildDomainSignal(priceContextPercent < 70 ? 'Ценовой контекст неполный' : 'Ценовой контекст достаточный', priceContextPercent < 70 ? 'high' : 'low', `${priceContextPercent}%`),
      buildDomainSignal(duplicateCandidates > 0 ? 'Нормализация и дубли искажают картину спроса' : 'Слой нормализации стабилен', duplicateCandidates > 0 ? 'high' : 'low', `${duplicateCandidates}`),
    ],
    decisions: [
      buildDomainSignal(clientIntentPercent < 70 ? 'Усилить дисциплину заполнения ICP и потребности клиента' : 'Поддерживать текущий стандарт capture контекста', clientIntentPercent < 70 ? 'high' : 'low'),
      buildDomainSignal(priceContextPercent < 70 ? 'Добавить price context в лиды и офферы' : 'Продолжать использовать ценовой контекст как фильтр качества спроса', priceContextPercent < 70 ? 'high' : 'low'),
      buildDomainSignal(duplicateCandidates > 0 ? 'Приоритизировать разбор дублей и нормализацию справочников' : 'Держать нормализацию в режиме контроля', duplicateCandidates > 0 ? 'medium' : 'low'),
    ],
    sensors: [
      buildDomainSignal('Client intent completeness', clientIntentPercent < 70 ? 'high' : 'low', `${clientIntentPercent}%`),
      buildDomainSignal('Linked events coverage', linkedEventsPercent < 85 ? 'medium' : 'low', `${linkedEventsPercent}%`),
      buildDomainSignal('Learning coverage', learningCoveragePercent < 65 ? 'medium' : 'low', `${learningCoveragePercent}%`),
    ],
  };
}

function buildSalesDomainSummary({ queueItems, ropItems, feedbackSummary, qualitySummary, opportunities }) {
  const salesItems = queueItems.filter((item) =>
    item.state_codes?.includes('hot_urgent') || item.state_codes?.includes('hot_unworked'));
  const hotUrgentDeals = queueItems.filter((item) => item.state_codes?.includes('hot_urgent')).length;
  const hotUnworkedDeals = queueItems.filter((item) => item.state_codes?.includes('hot_unworked')).length;
  const marginRiskDeals = opportunities.filter((item) => {
    const margin = item.economic_assessment?.expected_margin_percent ?? null;
    return margin !== null && margin < 15;
  }).length;
  const paymentReadyDeals = opportunities.filter((item) =>
    item.payment_readiness === 'ready' || item.payment_readiness === 'ready_for_offer').length;
  const contractStageDeals = opportunities.filter((item) =>
    item.commercial_stage === 'contract_requested' || item.commercial_stage === 'invoice_requested').length;

  return {
    summary: `В продажах сейчас ${salesItems.length} горячих сделок в очереди, из них ${hotUnworkedDeals} уже с риском SLA, ${marginRiskDeals} сделок под давлением по марже и ${ropItems.length} эскалаций.`,
    kpis: [
      buildKpi({ label: 'Hot Deals', value: String(salesItems.length), tone: salesItems.length > 0 ? 'high' : 'low', target: '<5', delta: salesItems.length > 5 ? `+${salesItems.length - 5}` : '0', trend: salesItems.length > 5 ? 'up' : 'flat' }),
      buildKpi({ label: 'Hot Urgent', value: String(hotUrgentDeals), tone: hotUrgentDeals > 0 ? 'high' : 'low', target: 'handled', delta: hotUrgentDeals > 0 ? `+${hotUrgentDeals}` : '0', trend: hotUrgentDeals > 0 ? 'up' : 'flat' }),
      buildKpi({ label: 'SLA Risk', value: String(hotUnworkedDeals), tone: hotUnworkedDeals > 0 ? 'critical' : 'low', target: '0', delta: hotUnworkedDeals > 0 ? `+${hotUnworkedDeals}` : '0', trend: hotUnworkedDeals > 0 ? 'up' : 'flat' }),
      buildKpi({ label: 'Escalations', value: String(ropItems.length), tone: ropItems.length > 0 ? 'high' : 'low', target: '<3', delta: ropItems.length > 3 ? `+${ropItems.length - 3}` : '0', trend: ropItems.length > 3 ? 'up' : 'flat' }),
      buildKpi({ label: 'Margin Risk Deals', value: String(marginRiskDeals), tone: marginRiskDeals > 0 ? 'high' : 'low', target: '0', delta: marginRiskDeals > 0 ? `+${marginRiskDeals}` : '0', trend: marginRiskDeals > 0 ? 'up' : 'flat' }),
      buildRatioKpi({ label: 'Payment Ready', numerator: paymentReadyDeals, denominator: opportunities.length || 0, threshold: 60, tone: 'medium', targetLabel: '60%+' }),
      buildKpi({ label: 'Contract Stage', value: String(contractStageDeals), tone: contractStageDeals > 0 ? 'medium' : 'low', target: 'growth', delta: null, trend: contractStageDeals > 0 ? 'up' : 'flat' }),
      buildKpi({ label: 'Next Step Signal', value: Number.isFinite(qualitySummary.next_step_signal_percent) ? `${qualitySummary.next_step_signal_percent}%` : '—', tone: 'medium', target: '80%+', delta: Number.isFinite(qualitySummary.next_step_signal_percent) ? formatSignedNumber(qualitySummary.next_step_signal_percent - 80, ' pp') : null, trend: (qualitySummary.next_step_signal_percent ?? 0) >= 80 ? 'up' : 'down' }),
      buildKpi({ label: 'Accepted Rate', value: `${Math.round((feedbackSummary.accepted_rate ?? 0) * 100)}%`, tone: 'medium', target: '70%+', delta: formatSignedNumber(Math.round((feedbackSummary.accepted_rate ?? 0) * 100) - 70, ' pp'), trend: (feedbackSummary.accepted_rate ?? 0) >= 0.7 ? 'up' : 'down' }),
      buildKpi({ label: 'Executed Rate', value: `${Math.round((feedbackSummary.executed_rate ?? 0) * 100)}%`, tone: 'medium', target: '55%+', delta: formatSignedNumber(Math.round((feedbackSummary.executed_rate ?? 0) * 100) - 55, ' pp'), trend: (feedbackSummary.executed_rate ?? 0) >= 0.55 ? 'up' : 'down' }),
    ],
    states: [
      buildDomainSignal(hotUnworkedDeals > 0 ? 'Есть горячие сделки с риском SLA' : 'SLA по горячим сделкам контролируется', hotUnworkedDeals > 0 ? 'critical' : 'low', `${hotUnworkedDeals}`),
      buildDomainSignal(marginRiskDeals > 0 ? 'Часть воронки идет в продажи с просадкой по марже' : 'Маржинальные риски в воронке не доминируют', marginRiskDeals > 0 ? 'high' : 'low', `${marginRiskDeals}`),
      buildDomainSignal(paymentReadyDeals < Math.ceil((opportunities.length || 0) * 0.6) ? 'Недостаточно сделок доведено до оплаты' : 'Конверсия в оплату на рабочем уровне', paymentReadyDeals < Math.ceil((opportunities.length || 0) * 0.6) ? 'high' : 'low', `${paymentReadyDeals}/${opportunities.length || 0}`),
    ],
    decisions: [
      buildDomainSignal(hotUnworkedDeals > 0 ? 'Разобрать SLA-риск по горячим сделкам и перераспределить владельцев' : 'Сохранять текущий режим управления горячими сделками', hotUnworkedDeals > 0 ? 'critical' : 'low'),
      buildDomainSignal(marginRiskDeals > 0 ? 'Ограничить скидки и вынести margin-risk сделки на разбор' : 'Удерживать текущую маржинальную дисциплину', marginRiskDeals > 0 ? 'high' : 'low'),
      buildDomainSignal(contractStageDeals > 0 ? 'Ускорить contract/invoice stage до оплаты' : 'Фокус на поддержании скорости воронки', contractStageDeals > 0 ? 'medium' : 'low'),
    ],
    sensors: [
      buildDomainSignal('Hot queue volume', salesItems.length > 5 ? 'high' : 'low', `${salesItems.length}`),
      buildDomainSignal('Next step signal', (qualitySummary.next_step_signal_percent ?? 0) < 80 ? 'medium' : 'low', Number.isFinite(qualitySummary.next_step_signal_percent) ? `${qualitySummary.next_step_signal_percent}%` : '—'),
      buildDomainSignal('Executed recommendations', (feedbackSummary.executed_rate ?? 0) < 0.55 ? 'medium' : 'low', `${Math.round((feedbackSummary.executed_rate ?? 0) * 100)}%`),
    ],
  };
}

function buildOperationsDomainSummary({ queueItems, ownerSummary, qualitySummary }) {
  const opsItems = queueItems.filter((item) =>
    (item.signal_markers ?? []).some((marker) => String(marker).toLowerCase().includes('subrent')));
  const urgentOpsItems = queueItems.filter((item) =>
    item.state_codes?.includes('hot_subrent_only') || item.state_codes?.includes('hot_urgent')).length;
  const ownFleetShare = ownerSummary.own_equipment_share ?? 0;
  const subrentShare = ownerSummary.subrent_dependency_share ?? 0;
  const reserveCoverage = ownerSummary.reserve_coverage_share ?? 0;
  const partnerCoverage = ownerSummary.partner_coverage_share ?? 0;
  const strategicLoadReady = ownerSummary.strategic_load_ready_share ?? 0;
  const logisticsContext = qualitySummary.logistics_context_percent ?? 0;
  const geoHint = qualitySummary.geo_hint_percent ?? 0;
  const confidenceGuard = ownerSummary.confidence_guard_share ?? 0;

  return {
    summary: `Производственный контур сейчас показывает ${opsItems.length} сделок с операционным давлением, ${urgentOpsItems} срочных кейсов по субаренде/логистике и покрытие резерва ${reserveCoverage}%. Баланс собственного парка к субаренде: ${ownFleetShare}% / ${subrentShare}%.`,
    kpis: [
      buildKpi({ label: 'Ops Pressure', value: String(opsItems.length), tone: opsItems.length > 0 ? 'high' : 'low', target: '0', delta: opsItems.length > 0 ? `+${opsItems.length}` : '0', trend: opsItems.length > 0 ? 'up' : 'flat' }),
      buildKpi({ label: 'Urgent Ops', value: String(urgentOpsItems), tone: urgentOpsItems > 0 ? 'critical' : 'low', target: '0', delta: urgentOpsItems > 0 ? `+${urgentOpsItems}` : '0', trend: urgentOpsItems > 0 ? 'up' : 'flat' }),
      buildKpi({ label: 'Own Fleet Share', value: Number.isFinite(ownFleetShare) ? `${ownFleetShare}%` : '—', tone: 'medium', target: '60%+', delta: formatSignedNumber(ownFleetShare - 60, ' pp'), trend: ownFleetShare >= 60 ? 'up' : 'down' }),
      buildKpi({ label: 'Subrent Share', value: Number.isFinite(subrentShare) ? `${subrentShare}%` : '—', tone: subrentShare > 40 ? 'high' : 'medium', target: '<35%', delta: formatSignedNumber(subrentShare - 35, ' pp'), trend: subrentShare > 35 ? 'up' : 'down' }),
      buildKpi({ label: 'Reserve Coverage', value: Number.isFinite(reserveCoverage) ? `${reserveCoverage}%` : '—', tone: reserveCoverage < 50 ? 'high' : 'medium', target: '70%+', delta: formatSignedNumber(reserveCoverage - 70, ' pp'), trend: reserveCoverage >= 70 ? 'up' : 'down' }),
      buildKpi({ label: 'Partner Coverage', value: Number.isFinite(partnerCoverage) ? `${partnerCoverage}%` : '—', tone: 'medium', target: '65%+', delta: formatSignedNumber(partnerCoverage - 65, ' pp'), trend: partnerCoverage >= 65 ? 'up' : 'down' }),
      buildKpi({ label: 'Load Ready', value: Number.isFinite(strategicLoadReady) ? `${strategicLoadReady}%` : '—', tone: 'medium', target: '55%+', delta: formatSignedNumber(strategicLoadReady - 55, ' pp'), trend: strategicLoadReady >= 55 ? 'up' : 'down' }),
      buildKpi({ label: 'Logistics Context', value: Number.isFinite(logisticsContext) ? `${logisticsContext}%` : '—', tone: logisticsContext < 60 ? 'high' : 'low', target: '75%+', delta: formatSignedNumber(logisticsContext - 75, ' pp'), trend: logisticsContext >= 75 ? 'up' : 'down' }),
      buildKpi({ label: 'Geo Hint', value: Number.isFinite(geoHint) ? `${geoHint}%` : '—', tone: 'low', target: '80%+', delta: formatSignedNumber(geoHint - 80, ' pp'), trend: geoHint >= 80 ? 'up' : 'down' }),
      buildKpi({ label: 'Confidence Guard', value: Number.isFinite(confidenceGuard) ? `${confidenceGuard}%` : '—', tone: confidenceGuard > 20 ? 'high' : 'low', target: '<10%', delta: formatSignedNumber(confidenceGuard - 10, ' pp'), trend: confidenceGuard > 10 ? 'up' : 'down' }),
    ],
    states: [
      buildDomainSignal(urgentOpsItems > 0 ? 'Есть срочные кейсы по субаренде и логистике' : 'Срочного перегрева в операциях нет', urgentOpsItems > 0 ? 'critical' : 'low', `${urgentOpsItems}`),
      buildDomainSignal(subrentShare > 35 ? 'Зависимость от субаренды выше целевого режима' : 'Субарендная зависимость в допустимой зоне', subrentShare > 35 ? 'high' : 'low', `${subrentShare}%`),
      buildDomainSignal(reserveCoverage < 70 ? 'Резерв покрытия ниже цели' : 'Резерв покрытия достаточен', reserveCoverage < 70 ? 'high' : 'low', `${reserveCoverage}%`),
    ],
    decisions: [
      buildDomainSignal(urgentOpsItems > 0 ? 'Перебросить резерв/партнеров на срочные кейсы' : 'Поддерживать текущую операционную модель', urgentOpsItems > 0 ? 'critical' : 'low'),
      buildDomainSignal(subrentShare > 35 ? 'Снижать долю субаренды и усиливать собственный парк' : 'Сохранять текущий баланс парк/партнеры', subrentShare > 35 ? 'high' : 'low'),
      buildDomainSignal(logisticsContext < 75 ? 'Усилить capture логистического контекста в карточках' : 'Контекст логистики уже можно использовать как управленческий сигнал', logisticsContext < 75 ? 'medium' : 'low'),
    ],
    sensors: [
      buildDomainSignal('Ops pressure queue', opsItems.length > 0 ? 'high' : 'low', `${opsItems.length}`),
      buildDomainSignal('Reserve coverage', reserveCoverage < 70 ? 'high' : 'low', `${reserveCoverage}%`),
      buildDomainSignal('Logistics context', logisticsContext < 75 ? 'medium' : 'low', `${logisticsContext}%`),
    ],
  };
}

export async function buildDomainSummaryDashboard() {
  const [
    queueItems,
    ropItems,
    ownerDashboard,
    qualityDashboard,
    normalizationDashboard,
    feedbackDashboard,
    systemStatus,
    opportunities,
  ] = await Promise.all([
    buildManagerQueue({ limit: 50 }),
    buildRopEscalations({ limit: 50 }),
    buildOwnerDashboard({ limit: 20 }),
    buildDataQualityDashboard(),
    buildNormalizationDashboard(),
    buildFeedbackLearningDashboard(),
    buildSystemStatusDashboard(),
    repository.listOpportunities(),
  ]);

  const qualitySummary = qualityDashboard.summary ?? {};
  const normalizationSummary = normalizationDashboard.summary ?? {};
  const feedbackSummary = feedbackDashboard.summary ?? {};
  const ownerSummary = ownerDashboard.summary ?? {};
  const systemIngest = systemStatus.ingest ?? {};

  return {
    generated_at: new Date().toISOString(),
    domains: {
      'Финансы': buildFinanceDomainSummary({ queueItems, ropItems, ownerSummary, systemIngest, opportunities }),
      'Маркетинг': buildMarketingDomainSummary({ qualitySummary, normalizationSummary, feedbackSummary }),
      'Продажи': buildSalesDomainSummary({ queueItems, ropItems, feedbackSummary, qualitySummary, opportunities }),
      'Производство': buildOperationsDomainSummary({ queueItems, ownerSummary, qualitySummary }),
    },
  };
}

export async function buildAuditDashboard(limit = 20) {
  return {
    items: await repository.listAuditLogs(limit),
  };
}

export function createAppServer() {
  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, `http://${request.headers.host}`);
      const auth = resolveAuthContext(request);
      const isHead = request.method === 'HEAD';
      const isGetLike = request.method === 'GET' || isHead;

      if (isGetLike && url.pathname === '/health') {
        return sendJson(response, 200, { status: 'ok', service: 'ai-sales-decision-engine' }, { headOnly: isHead });
      }

      if (isGetLike && url.pathname === '/live') {
        return sendJson(response, 200, { status: 'alive', live: true, service: 'ai-sales-decision-engine' }, { headOnly: isHead });
      }

      if (isGetLike && url.pathname === '/ready') {
        const status = await buildSystemStatusDashboard();
        const readiness = status.readiness ?? deriveReadiness(status);
        return sendJson(
          response,
          readiness.ready ? 200 : 503,
          {
            status: readiness.state,
            ready: readiness.ready,
            reasons: readiness.reasons,
            service: 'ai-sales-decision-engine',
          },
          { headOnly: isHead },
        );
      }

      if (request.method === 'GET' && url.pathname === '/auth/me') {
        await repository.upsertUserContext(auth.user);
        return sendJson(response, 200, auth);
      }

      if (isGetLike && (url.pathname === '/' || url.pathname === '/app')) {
        await serveStaticFile(response, 'index.html', { headOnly: isHead });
        return;
      }

      if (isGetLike && url.pathname.startsWith('/app/')) {
        await serveStaticFile(response, url.pathname.replace('/app/', ''), { headOnly: isHead });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/events/bitrix') {
        const denied = requirePermission(auth, 'dashboard.data_quality');
        if (denied) return sendJson(response, 403, denied);
        const payload = await readJson(request);
        const normalizedPayload = payload?.event ? adaptBitrixWebhookPayload(payload) : payload;
        const acceptedEvent = await repository.saveIngestEvent(normalizedPayload);
        await writeAuditLog(auth, 'bitrix_event_accept', 'ingest_event', acceptedEvent.id, {
          source_event_id: acceptedEvent.source_event_id ?? null,
        });
        return sendJson(response, 202, {
          accepted: true,
          message: 'Событие принято в ingest-контур.',
          ingest_event: acceptedEvent,
        });
      }

      if (request.method === 'GET' && url.pathname === '/events/bitrix/pending') {
        const denied = requirePermission(auth, 'dashboard.data_quality');
        if (denied) return sendJson(response, 403, denied);
        return sendJson(response, 200, {
          items: await repository.listPendingIngestEvents(100),
        });
      }

      if (request.method === 'GET' && url.pathname === '/events/bitrix/errors') {
        const denied = requirePermission(auth, 'dashboard.data_quality');
        if (denied) return sendJson(response, 403, denied);
        return sendJson(response, 200, {
          items: await repository.listFailedIngestEvents(100),
        });
      }

      if (request.method === 'POST' && url.pathname === '/events/bitrix/retry') {
        const denied = requirePermission(auth, 'dashboard.data_quality');
        if (denied) return sendJson(response, 403, denied);
        const payload = await readJson(request).catch(() => ({}));
        const limit = Number(payload?.limit ?? 50);
        const processAfterRetry = payload?.process_after_retry === true;
        const statuses = Array.isArray(payload?.statuses) && payload.statuses.length
          ? payload.statuses
          : ['failed', 'suspicious'];
        const result = await repository.retryIngestEvents({ statuses, limit });
        const processed = processAfterRetry
          ? await repository.processPendingIngestEvents(limit)
          : null;
        await writeAuditLog(auth, 'bitrix_ingest_retry', 'ingest_batch', `retry:${Date.now()}`, {
          retried_count: result.retried_count,
          statuses,
          process_after_retry: processAfterRetry,
          processed_count: processed?.processed_count ?? 0,
        });
        return sendJson(response, 200, {
          ok: true,
          ...result,
          processed,
        });
      }

      if (request.method === 'POST' && url.pathname === '/events/bitrix/process') {
        const denied = requirePermission(auth, 'dashboard.data_quality');
        if (denied) return sendJson(response, 403, denied);
        const payload = await readJson(request);
        const limit = Number(payload.limit ?? 50);
        const result = await repository.processPendingIngestEvents(limit);
        await writeAuditLog(auth, 'ingest_process', 'ingest_batch', null, {
          limit,
          processed_count: result.processed_count,
        });
        return sendJson(response, 200, result);
      }

      if (request.method === 'POST' && url.pathname === '/nlp/extract') {
        const payload = await readJson(request);
        return sendJson(response, 200, {
          text: payload.text ?? '',
          extraction: extractEntitiesFromText(payload.text ?? ''),
        });
      }

      if (request.method === 'GET' && url.pathname === '/meta/contracts') {
        return sendJson(response, 200, getContractsOverview());
      }

      if (request.method === 'GET' && url.pathname === '/meta/dictionaries') {
        return sendJson(response, 200, getDictionariesOverview());
      }

      if (request.method === 'GET' && url.pathname === '/vectors/status') {
        return sendJson(response, 200, await getQdrantStatus());
      }

      if (request.method === 'GET' && url.pathname === '/graph/status') {
        return sendJson(response, 200, await getNeo4jStatus());
      }

      if (request.method === 'POST' && url.pathname === '/graph/sync') {
        const denied = requirePermission(auth, 'dashboard.data_quality');
        if (denied) return sendJson(response, 403, denied);
        const result = await syncRepositoryToNeo4j(repository);
        await writeAuditLog(auth, 'graph_sync', 'graph_index', 'neo4j', {
          enabled: result.enabled ?? false,
          database: result.database ?? null,
          synced_opportunities: result.synced_opportunities ?? 0,
        }, result.enabled === false ? 'skipped' : 'success');
        return sendJson(response, 200, result);
      }

      if (request.method === 'POST' && url.pathname === '/vectors/index') {
        const denied = requirePermission(auth, 'dashboard.data_quality');
        if (denied) return sendJson(response, 403, denied);
        const result = await syncRepositoryToQdrant(repository);
        await writeAuditLog(auth, 'vectors_index', 'vector_index', 'qdrant', {
          enabled: result.enabled ?? false,
          collections: result.collections ?? null,
        }, result.enabled === false ? 'skipped' : 'success');
        return sendJson(response, 200, result);
      }

      if (request.method === 'GET' && url.pathname.startsWith('/opportunities/')) {
        const [, resource, id, action] = url.pathname.split('/');
        if (resource !== 'opportunities' || !id) {
          return notFound(response);
        }

        const opportunity = await getOpportunity(id);
        if (!opportunity) {
          return sendJson(response, 404, { error: 'Opportunity not found', id });
        }

        if (action === 'state') {
          const denied = requirePermission(auth, 'opportunity.view');
          if (denied) return sendJson(response, 403, denied);
          return sendJson(response, 200, await evaluateAndPersistState(opportunity));
        }

        if (action === 'state-history') {
          return sendJson(response, 200, {
            opportunity_id: id,
            items: await repository.listStateSnapshots(id),
          });
        }

        if (action === 'decision') {
          const denied = requirePermission(auth, 'opportunity.decision');
          if (denied) return sendJson(response, 403, denied);
          const result = await evaluateAndPersistDecision(opportunity);
          await writeAuditLog(auth, 'view_decision', 'opportunity', id, {
            recommendation_id: result.recommendation_id ?? null,
          });
          return sendJson(response, 200, result);
        }

        if (action === 'card') {
          const denied = requirePermission(auth, 'opportunity.view');
          if (denied) return sendJson(response, 403, denied);
          return sendJson(response, 200, await buildOpportunityCard(id));
        }

        if (action === 'graph') {
          const denied = requirePermission(auth, 'opportunity.graph');
          if (denied) return sendJson(response, 403, denied);
          const neo4jGraph = await getOpportunityGraphFromNeo4j(id);
          return sendJson(response, 200, neo4jGraph ?? buildOpportunityGraph(opportunity));
        }

        if (action === 'similar-cases') {
          return sendJson(response, 200, {
            opportunity_id: id,
            items: await getSimilarCases(opportunity, repository),
          });
        }

        if (action === 'recommendations') {
          return sendJson(response, 200, {
            opportunity_id: id,
            items: await repository.listRecommendations(id),
          });
        }

        return sendJson(response, 200, opportunity);
      }

      if (request.method === 'GET' && url.pathname === '/dashboard/manager') {
        const denied = requirePermission(auth, 'dashboard.manager');
        if (denied) return sendJson(response, 403, denied);
        return sendJson(response, 200, { items: await buildManagerDashboard() });
      }

      if (request.method === 'GET' && url.pathname === '/dashboard/manager/queue') {
        const denied = requirePermission(auth, 'dashboard.manager');
        if (denied) return sendJson(response, 403, denied);
        return sendJson(response, 200, {
          items: await buildManagerQueue({
            limit: Number(url.searchParams.get('limit') ?? 20),
            bucket: url.searchParams.get('bucket') ?? '',
            state: url.searchParams.get('state') ?? '',
            mode: url.searchParams.get('mode') ?? '',
            search: url.searchParams.get('search') ?? '',
          }),
        });
      }

      if (request.method === 'GET' && url.pathname === '/dashboard/rop') {
        const denied = requirePermission(auth, 'dashboard.rop');
        if (denied) return sendJson(response, 403, denied);
        return sendJson(response, 200, { items: await buildRopDashboard() });
      }

      if (request.method === 'GET' && url.pathname === '/dashboard/rop/escalations') {
        const denied = requirePermission(auth, 'dashboard.rop');
        if (denied) return sendJson(response, 403, denied);
        return sendJson(response, 200, {
          items: await buildRopEscalations({
            limit: Number(url.searchParams.get('limit') ?? 20),
            escalationType: url.searchParams.get('type') ?? '',
          }),
        });
      }

      if (request.method === 'GET' && url.pathname === '/dashboard/logistics') {
        const denied = requirePermission(auth, 'dashboard.logistics');
        if (denied) return sendJson(response, 403, denied);
        return sendJson(response, 200, {
          items: await buildLogisticsDashboard({
            limit: Number(url.searchParams.get('limit') ?? 20),
            mode: url.searchParams.get('mode') ?? '',
          }),
        });
      }

      if (request.method === 'GET' && url.pathname === '/dashboard/owner') {
        const denied = requirePermission(auth, 'dashboard.owner');
        if (denied) return sendJson(response, 403, denied);
        return sendJson(response, 200, await buildOwnerDashboard({
          limit: Number(url.searchParams.get('limit') ?? 20),
          strategy: url.searchParams.get('strategy') ?? '',
        }));
      }

      if (request.method === 'GET' && url.pathname === '/dashboard/data-quality') {
        const denied = requirePermission(auth, 'dashboard.data_quality');
        if (denied) return sendJson(response, 403, denied);
        return sendJson(response, 200, await buildDataQualityDashboard());
      }

      if (request.method === 'GET' && url.pathname === '/dashboard/normalization') {
        const denied = requirePermission(auth, 'dashboard.normalization');
        if (denied) return sendJson(response, 403, denied);
        return sendJson(response, 200, await buildNormalizationDashboard({
          action: url.searchParams.get('action') ?? '',
        }));
      }

      if (request.method === 'GET' && url.pathname === '/dashboard/feedback-learning') {
        const denied = requirePermission(auth, 'dashboard.feedback_learning');
        if (denied) return sendJson(response, 403, denied);
        return sendJson(response, 200, await buildFeedbackLearningDashboard());
      }

      if (request.method === 'GET' && url.pathname === '/dashboard/system-status') {
        const denied = requirePermission(auth, 'dashboard.data_quality');
        if (denied) return sendJson(response, 403, denied);
        return sendJson(response, 200, await buildSystemStatusDashboard());
      }

      if (request.method === 'GET' && url.pathname === '/dashboard/domain-summary') {
        const denied = requirePermission(auth, 'dashboard.manager');
        if (denied) return sendJson(response, 403, denied);
        return sendJson(response, 200, await buildDomainSummaryDashboard());
      }

      if (request.method === 'POST' && url.pathname === '/normalization/decision') {
        const denied = requirePermission(auth, 'dashboard.normalization');
        if (denied) return sendJson(response, 403, denied);
        const payload = await readJson(request);
        const saved = await repository.saveNormalizationDecision({
          candidate_key: payload.candidate_key,
          decision_status: payload.decision_status,
          note: payload.note ?? null,
          actor_name: auth?.user?.full_name ?? null,
          actor_role: auth?.user?.role_code ?? null,
        });
        await writeAuditLog(
          auth,
          'normalization_decision',
          'normalization_candidate',
          payload.candidate_key,
          { decision_status: payload.decision_status },
        );
        return sendJson(response, 200, { ok: true, item: saved });
      }

      if (request.method === 'GET' && url.pathname === '/audit/logs') {
        const denied = requirePermission(auth, 'audit.view');
        if (denied) return sendJson(response, 403, denied);
        return sendJson(response, 200, await buildAuditDashboard(Number(url.searchParams.get('limit') ?? 20)));
      }

      if (request.method === 'GET' && url.pathname.startsWith('/objects/')) {
        const [, resource, id, graphPart] = url.pathname.split('/');
        if (resource !== 'objects' || graphPart !== 'graph') {
          return notFound(response);
        }

        const opportunities = await repository.listOpportunities();
        const matched = opportunities.find((item) =>
          item.project_object?.resolved_entity_id === id
          || item.project_object?.normalized_value === id
          || item.project_object?.raw_value === id,
        );

        const neo4jGraph = await getObjectGraphFromNeo4j(id);
        return sendJson(response, 200, neo4jGraph ?? (matched ? buildOpportunityGraph(matched) : {
          object_id: id,
          nodes: [],
          edges: [],
        }));
      }

      if (request.method === 'POST' && url.pathname.startsWith('/actions/')) {
        const [, resource, id, feedbackPart] = url.pathname.split('/');
        if (resource !== 'actions' || feedbackPart !== 'feedback') {
          return notFound(response);
        }
        const denied = requirePermission(auth, 'feedback.write');
        if (denied) return sendJson(response, 403, denied);

        const payload = await readJson(request);
        const result = await repository.saveFeedback(id, payload);
        await writeAuditLog(auth, 'recommendation_feedback', 'recommendation', id, {
          accepted: payload.accepted ?? false,
          rejected: payload.rejected ?? false,
          executed: payload.executed ?? false,
        });
        return sendJson(response, 201, result);
      }

      return notFound(response);
    } catch (error) {
      return sendJson(response, 500, {
        error: 'Internal server error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

export function startServer() {
  const server = createAppServer();
  server.listen(PORT, HOST, () => {
    console.log(`AI Sales Decision Engine API listening on http://${HOST}:${PORT}`);
  });

  return server;
}

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  startServer();
}
