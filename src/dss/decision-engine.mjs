import { getAction } from './action-library.mjs';

const STATE_TO_ACTION = [
  {
    state: 'hot_unworked',
    action: 'sales_call',
    escalation: 'owner_escalation',
    priority: 95,
    why: 'Горячая сделка простаивает дольше SLA.',
  },
  {
    state: 'hot_urgent',
    action: 'send_offer',
    escalation: null,
    priority: 78,
    why: 'Клиент созрел до быстрой коммерческой реакции.',
  },
  {
    state: 'client_ready_for_contract',
    action: 'send_contract',
    escalation: null,
    priority: 92,
    why: 'Сделка дошла до договорной зрелости, нужно быстро перевести ее в оформление.',
  },
  {
    state: 'hot_own_equipment',
    action: 'reserve_own_equipment',
    escalation: 'reprice_deal',
    priority: 84,
    why: 'Есть смысл закрепить свою технику, пока окно не ушло.',
  },
  {
    state: 'hot_subrent_only',
    action: 'request_subrent',
    escalation: 'owner_escalation',
    priority: 82,
    why: 'Спрос реальный, но без субаренды шанс потерять сделку высокий.',
  },
  {
    state: 'spec_missing',
    action: 'clarify_specs',
    escalation: null,
    priority: 72,
    why: 'Без уточнений система не рекомендует агрессивный дожим.',
  },
  {
    state: 'decision_maker_reached',
    action: 'sales_call',
    escalation: null,
    priority: 80,
    why: 'Есть доступ к принимающему решение, стоит использовать окно прямого контакта.',
  },
  {
    state: 'competitor_attack_window',
    action: 'competitor_attack',
    escalation: 'owner_escalation',
    priority: 86,
    why: 'На объекте есть окно для атаки конкурента, и его лучше не терять.',
  },
  {
    state: 'cross_sell_open',
    action: 'cross_sell_offer',
    escalation: null,
    priority: 76,
    why: 'По графу виден соседний спрос, есть шанс расширить сделку через кросс-продажу.',
  },
  {
    state: 'debt_risk',
    action: 'debt_control',
    escalation: 'owner_escalation',
    priority: 98,
    why: 'Нужна проверка финансовых ограничений перед обещаниями клиенту.',
  },
  {
    state: 'noise_low_priority',
    action: 'stop_deal',
    escalation: null,
    priority: 99,
    why: 'Шумовую сделку лучше не перегревать ресурсами команды.',
  },
];

export function decideNextAction(opportunityState) {
  const matchedRules = STATE_TO_ACTION
    .map((rule) => {
      const matchedState = opportunityState.states.find((state) => state.state_code === rule.state);
      if (!matchedState) return null;
      return {
        ...rule,
        matched_state: matchedState,
        selection_score: Number((rule.priority + (matchedState.confidence_score ?? 0) * 10).toFixed(2)),
      };
    })
    .filter(Boolean)
    .sort((left, right) => right.selection_score - left.selection_score);

  const matched = matchedRules[0] ?? null;

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
      similar_case_hint: opportunityState.states.some((state) => state.state_code === 'cross_sell_open')
        ? 'Граф связей показывает соседний спрос на объекте, это усиливает сценарий расширения.'
        : opportunityState.states.some((state) => state.state_code === 'competitor_attack_window')
          ? 'По объекту есть сигнал конкурента, поэтому действие смещается в сторону управленческой атаки.'
          : 'В v1 это место зарезервировано под поиск похожих кейсов через Qdrant.',
      why_this_action: matched
        ? `${matched.why} Выбор сделан по состоянию ${matched.matched_state.state_code} с confidence ${matched.matched_state.confidence_score}.`
        : 'Базовое действие по умолчанию — дособрать недостающие данные.',
      risk_if_ignored: escalation
        ? 'При бездействии рекомендация должна быть эскалирована руководителю.'
        : 'При бездействии окно сделки может остыть или потерять точность.',
    },
  };
}
