import { getAction } from './action-library.mjs';

const STATE_TO_ACTION = [
  {
    state: 'hot_unworked',
    action: 'sales_call',
    escalation: 'owner_escalation',
    why: 'Горячая сделка простаивает дольше SLA.',
  },
  {
    state: 'hot_urgent',
    action: 'send_offer',
    escalation: null,
    why: 'Клиент созрел до быстрой коммерческой реакции.',
  },
  {
    state: 'hot_own_equipment',
    action: 'reserve_own_equipment',
    escalation: 'reprice_deal',
    why: 'Есть смысл закрепить свою технику, пока окно не ушло.',
  },
  {
    state: 'hot_subrent_only',
    action: 'request_subrent',
    escalation: 'owner_escalation',
    why: 'Спрос реальный, но без субаренды шанс потерять сделку высокий.',
  },
  {
    state: 'spec_missing',
    action: 'clarify_specs',
    escalation: null,
    why: 'Без уточнений система не рекомендует агрессивный дожим.',
  },
  {
    state: 'debt_risk',
    action: 'debt_control',
    escalation: 'owner_escalation',
    why: 'Нужна проверка финансовых ограничений перед обещаниями клиенту.',
  },
  {
    state: 'noise_low_priority',
    action: 'stop_deal',
    escalation: null,
    why: 'Шумовую сделку лучше не перегревать ресурсами команды.',
  },
];

export function decideNextAction(opportunityState) {
  const matched = STATE_TO_ACTION.find((rule) =>
    opportunityState.states.some((state) => state.state_code === rule.state),
  );

  const action = getAction(matched?.action ?? 'clarify_specs');
  const escalation = matched?.escalation ? getAction(matched.escalation) : null;
  const topStates = opportunityState.states.slice(0, 3);

  return {
    opportunity_id: opportunityState.opportunity_id,
    recommended_action: action,
    escalation_action: escalation,
    deadline_at: new Date(Date.now() + ((action?.deadline_sla_minutes ?? 60) * 60_000)).toISOString(),
    explainability: {
      why_important: topStates.map((state) => state.reason),
      triggered_signals: topStates.map((state) => state.state_code),
      similar_case_hint: 'В v1 это место зарезервировано под поиск похожих кейсов через Qdrant.',
      why_this_action: matched?.why ?? 'Базовое действие по умолчанию — дособрать недостающие данные.',
      risk_if_ignored: escalation
        ? 'При бездействии рекомендация должна быть эскалирована руководителю.'
        : 'При бездействии окно сделки может остыть или потерять точность.',
    },
  };
}
