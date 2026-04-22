const els = {
  refreshAll: document.querySelector('#refreshAll'),
  loadFirstCard: document.querySelector('#loadFirstCard'),
  processIngestButton: document.querySelector('#processIngestButton'),
  loadCardButton: document.querySelector('#loadCardButton'),
  queueLimit: document.querySelector('#queueLimit'),
  queueBucket: document.querySelector('#queueBucket'),
  queueState: document.querySelector('#queueState'),
  queueMode: document.querySelector('#queueMode'),
  queueSearch: document.querySelector('#queueSearch'),
  ropType: document.querySelector('#ropType'),
  logisticsMode: document.querySelector('#logisticsMode'),
  ownerStrategy: document.querySelector('#ownerStrategy'),
  userRole: document.querySelector('#userRole'),
  cardIdInput: document.querySelector('#cardIdInput'),
  heroStats: document.querySelector('#heroStats'),
  queueList: document.querySelector('#queueList'),
  ropList: document.querySelector('#ropList'),
  qualitySummary: document.querySelector('#qualitySummary'),
  qualityList: document.querySelector('#qualityList'),
  normalizationSummary: document.querySelector('#normalizationSummary'),
  normalizationList: document.querySelector('#normalizationList'),
  feedbackLearningSummary: document.querySelector('#feedbackLearningSummary'),
  feedbackLearningList: document.querySelector('#feedbackLearningList'),
  feedbackRecentList: document.querySelector('#feedbackRecentList'),
  auditList: document.querySelector('#auditList'),
  logisticsList: document.querySelector('#logisticsList'),
  ownerSummary: document.querySelector('#ownerSummary'),
  ownerList: document.querySelector('#ownerList'),
  cardView: document.querySelector('#cardView'),
  pendingList: document.querySelector('#pendingList'),
  errorList: document.querySelector('#errorList'),
};

const uiState = {
  currentCardId: 'opp-1001',
  auth: null,
};

async function api(path, options) {
  const headers = new Headers(options?.headers ?? {});
  headers.set('x-user-role', els.userRole.value || 'admin');
  headers.set('x-user-name', `UI ${els.userRole.value || 'admin'}`);
  headers.set('x-user-id', `ui-${els.userRole.value || 'admin'}`);

  const response = await fetch(path, {
    ...options,
    headers,
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return response.json();
}

function formatDateTime(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString('ru-RU');
}

function badgeClass(bucket) {
  return `badge badge-${bucket}`;
}

function renderHeroStats(queueItems, ropItems, pendingItems, errorItems) {
  const critical = queueItems.filter((item) => item.priority_bucket === 'critical').length;
  const withRisk = queueItems.filter((item) => item.state_codes.includes('debt_risk') || item.state_codes.includes('hot_unworked')).length;

  els.heroStats.innerHTML = `
    <div class="stat-card">
      <span class="stat-label">Роль</span>
      <strong>${uiState.auth?.user?.role_code ?? 'admin'}</strong>
    </div>
    <div class="stat-card">
      <span class="stat-label">Критичные</span>
      <strong>${critical}</strong>
    </div>
    <div class="stat-card">
      <span class="stat-label">В очереди</span>
      <strong>${queueItems.length}</strong>
    </div>
    <div class="stat-card">
      <span class="stat-label">С риском</span>
      <strong>${withRisk}</strong>
    </div>
    <div class="stat-card">
      <span class="stat-label">Эскалации</span>
      <strong>${ropItems.length}</strong>
    </div>
    <div class="stat-card">
      <span class="stat-label">Ingest</span>
      <strong>${pendingItems.length}/${errorItems.length}</strong>
    </div>
  `;
}

function renderQueue(items) {
  if (!items.length) {
    els.queueList.innerHTML = '<div class="empty">Очередь пока пустая.</div>';
    return;
  }

  els.queueList.innerHTML = items.map((item) => `
    <article class="queue-item" data-opportunity-id="${item.opportunity_id}">
      <div class="queue-top">
        <div>
          <h3 class="queue-title">${item.company ?? 'Без компании'}</h3>
          <div class="queue-subtitle">${item.object ?? 'Объект не определён'}</div>
        </div>
        <span class="${badgeClass(item.priority_bucket)}">${item.priority_bucket} · ${item.priority_score}</span>
      </div>
      <div class="queue-meta">
        <span class="pill">Следующее действие: ${item.next_action ?? '—'}</span>
        <span class="pill">Дедлайн: ${formatDateTime(item.deadline_at)}</span>
        <span class="pill">Owner: ${item.recommended_owner ?? '—'}</span>
      </div>
      <div class="muted">${item.why_now ?? 'Причина не указана'}</div>
      ${item.loss_risk_reason ? `<div class="muted">loss risk (${item.loss_risk_level ?? '—'}): ${item.loss_risk_reason}</div>` : ''}
      ${item.alternative_action ? `<div class="muted">alternative: ${item.alternative_action}</div>` : ''}
      ${item.why_blocked?.length ? `<div class="muted">blocked: ${item.why_blocked.join(' · ')}</div>` : ''}
      ${item.why_low_priority?.length ? `<div class="muted">low priority: ${item.why_low_priority.join(' · ')}</div>` : ''}
      <div class="badge-row">
        ${(item.priority_reasons ?? []).map((reason) => `<span class="badge badge-low">${reason}</span>`).join('')}
        ${item.state_codes.map((stateCode) => `<span class="badge badge-low">${stateCode}</span>`).join('')}
        ${item.target_role ? `<span class="badge badge-low">${item.target_role}</span>` : ''}
        ${item.loss_risk_level ? `<span class="badge badge-low">loss ${item.loss_risk_level}</span>` : ''}
        ${item.action_effectiveness ? `<span class="badge badge-low">accept ${Math.round((item.action_effectiveness.accepted_rate ?? 0) * 100)}%</span>` : ''}
        ${item.action_effectiveness ? `<span class="badge badge-low">exec ${Math.round((item.action_effectiveness.executed_rate ?? 0) * 100)}%</span>` : ''}
      </div>
      <div class="score-row">
        ${Object.entries(item.score_vector).map(([key, value]) => `<span class="score-pill">${key}: ${value}</span>`).join('')}
      </div>
    </article>
  `).join('');

  document.querySelectorAll('.queue-item').forEach((node) => {
    node.addEventListener('click', () => {
      els.cardIdInput.value = node.dataset.opportunityId;
      loadCard(node.dataset.opportunityId);
    });
  });
}

function renderRopEscalations(items) {
  if (!items.length) {
    els.ropList.innerHTML = '<div class="empty">Управленческих эскалаций сейчас нет.</div>';
    return;
  }

  els.ropList.innerHTML = items.map((item) => `
    <article class="queue-item escalation" data-opportunity-id="${item.opportunity_id}">
      <div class="queue-top">
        <div>
          <h3 class="queue-title">${item.company ?? 'Без компании'}</h3>
          <div class="queue-subtitle">${item.object ?? 'Объект не определён'}</div>
        </div>
        <span class="badge badge-high">${item.escalation_type} · ${item.priority_score}</span>
      </div>
      <div class="queue-meta">
        <span class="pill">Действие: ${item.recommended_action ?? '—'}</span>
        <span class="pill">Deadline: ${formatDateTime(item.deadline_at)}</span>
      </div>
      <div class="muted">${item.escalation_reason ?? 'Причина не указана'}</div>
      <div class="muted">
        evidence:
        competitor ${item.evidence_summary?.competitor_mentions ?? 0},
        debt ${item.evidence_summary?.debt_markers ?? 0},
        subrent ${item.evidence_summary?.subrent_markers ?? 0},
        promises ${item.evidence_summary?.promise_markers ?? 0}
      </div>
      <div class="badge-row">
        ${item.state_codes.map((stateCode) => `<span class="badge badge-low">${stateCode}</span>`).join('')}
        ${(item.evidence_markers ?? []).map((marker) => `<span class="badge badge-low">${marker}</span>`).join('')}
        ${item.action_effectiveness ? `<span class="badge badge-low">accept ${Math.round((item.action_effectiveness.accepted_rate ?? 0) * 100)}%</span>` : ''}
        ${item.action_effectiveness ? `<span class="badge badge-low">exec ${Math.round((item.action_effectiveness.executed_rate ?? 0) * 100)}%</span>` : ''}
      </div>
    </article>
  `).join('');

  document.querySelectorAll('.queue-item.escalation').forEach((node) => {
    node.addEventListener('click', () => {
      els.cardIdInput.value = node.dataset.opportunityId;
      loadCard(node.dataset.opportunityId);
    });
  });
}

function renderLogisticsQueue(items) {
  if (!items.length) {
    els.logisticsList.innerHTML = '<div class="empty">Срочных задач для логистики сейчас нет.</div>';
    return;
  }

  els.logisticsList.innerHTML = items.map((item) => `
    <article class="queue-item" data-opportunity-id="${item.opportunity_id}">
      <div class="queue-top">
        <div>
          <h3 class="queue-title">${item.company ?? 'Без компании'}</h3>
          <div class="queue-subtitle">${item.object ?? 'Объект не определён'}</div>
        </div>
        <span class="badge badge-high">${item.urgency_bucket} · ${item.priority_score}</span>
      </div>
      <div class="queue-meta">
        <span class="pill">Техника: ${item.equipment_type ?? '—'}</span>
        <span class="pill">Действие: ${item.recommended_action ?? '—'}</span>
      </div>
      <div class="muted">${item.partner_hint ?? '—'}</div>
      <div class="muted">${item.demand_cluster_hint ?? '—'}</div>
      <div class="badge-row">
        ${item.state_codes.map((stateCode) => `<span class="badge badge-low">${stateCode}</span>`).join('')}
      </div>
    </article>
  `).join('');

  document.querySelectorAll('#logisticsList .queue-item').forEach((node) => {
    node.addEventListener('click', () => {
      els.cardIdInput.value = node.dataset.opportunityId;
      loadCard(node.dataset.opportunityId);
    });
  });
}

function renderOwnerDashboard(payload) {
  const summary = payload.summary ?? {};
  const items = payload.items ?? [];

  els.ownerSummary.innerHTML = `
    <div class="stat-card">
      <span class="stat-label">Own Fleet Share</span>
      <strong>${summary.own_equipment_share ?? 0}%</strong>
    </div>
    <div class="stat-card">
      <span class="stat-label">Subrent Dependency</span>
      <strong>${summary.subrent_dependency_share ?? 0}%</strong>
    </div>
    <div class="stat-card">
      <span class="stat-label">Debt Exposure</span>
      <strong>${summary.debt_exposure_share ?? 0}%</strong>
    </div>
    <div class="stat-card">
      <span class="stat-label">Avg Margin</span>
      <strong>${summary.average_margin_percent ?? '—'}%</strong>
    </div>
    <div class="stat-card">
      <span class="stat-label">Accepted</span>
      <strong>${summary.recommendation_accepted_rate ?? 0}%</strong>
    </div>
    <div class="stat-card">
      <span class="stat-label">Executed</span>
      <strong>${summary.recommendation_executed_rate ?? 0}%</strong>
    </div>
  `;

  if (!items.length) {
    els.ownerList.innerHTML = '<div class="empty">Стратегических отклонений сейчас нет.</div>';
    return;
  }

  els.ownerList.innerHTML = items.map((item) => `
    <article class="queue-item" data-opportunity-id="${item.opportunity_id}">
      <div class="queue-top">
        <div>
          <h3 class="queue-title">${item.company ?? 'Без компании'}</h3>
          <div class="queue-subtitle">${item.object ?? 'Объект не определён'}</div>
        </div>
        <span class="badge badge-high">${item.strategy_flag} · ${item.priority_score}</span>
      </div>
      <div class="queue-meta">
        <span class="pill">Маржа: ${item.margin_percent ?? '—'}%</span>
        <span class="pill">Действие: ${item.recommended_action ?? '—'}</span>
      </div>
      <div class="muted">${item.owner_signal ?? '—'}</div>
      <div class="badge-row">
        <span class="badge badge-low">own: ${item.own_equipment_available ?? '—'}</span>
        <span class="badge badge-low">subrent: ${item.subrent_required ?? '—'}</span>
        <span class="badge badge-low">debt: ${item.debt_risk ? 'yes' : 'no'}</span>
      </div>
    </article>
  `).join('');

  document.querySelectorAll('#ownerList .queue-item').forEach((node) => {
    node.addEventListener('click', () => {
      els.cardIdInput.value = node.dataset.opportunityId;
      loadCard(node.dataset.opportunityId);
    });
  });
}

function renderQualityDashboard(payload) {
  const summary = payload.summary ?? {};
  const criticalFields = summary.critical_fields ?? [];
  els.qualitySummary.innerHTML = `
    <div class="stat-card">
      <span class="stat-label">Opportunities</span>
      <strong>${summary.total_opportunities ?? 0}</strong>
    </div>
    <div class="stat-card">
      <span class="stat-label">Linked Events</span>
      <strong>${summary.linked_events_percent ?? 0}%</strong>
    </div>
    <div class="stat-card">
      <span class="stat-label">Normalized Objects</span>
      <strong>${summary.normalized_objects_percent ?? 0}%</strong>
    </div>
    <div class="stat-card">
      <span class="stat-label">No Next Step</span>
      <strong>${summary.opportunities_without_next_step ?? 0}</strong>
    </div>
    <div class="stat-card">
      <span class="stat-label">Missing Equipment</span>
      <strong>${summary.opportunities_missing_equipment ?? 0}</strong>
    </div>
    <div class="stat-card">
      <span class="stat-label">Failed Ingest</span>
      <strong>${summary.failed_ingest_events ?? 0}</strong>
    </div>
    ${criticalFields.map((item) => `
      <div class="stat-card">
        <span class="stat-label">${item.label}</span>
        <strong>${item.filled_percent}%</strong>
      </div>
    `).join('')}
  `;

  const items = payload.items ?? [];
  const criticalFieldsHtml = criticalFields.length
    ? `
      <article class="queue-item">
        <div class="queue-top">
          <div>
            <h3 class="queue-title">Критичные поля Opportunity Unit</h3>
            <div class="queue-subtitle">Покрытие обязательных полей из ТЗ</div>
          </div>
        </div>
        <div class="badge-row">
          ${criticalFields.map((item) => `<span class="badge badge-${item.status === 'ok' ? 'low' : item.status === 'warning' ? 'high' : 'critical'}">${item.label}: ${item.filled_percent}%</span>`).join('')}
        </div>
      </article>
    `
    : '';

  if (!items.length) {
    els.qualityList.innerHTML = `${criticalFieldsHtml}<div class="empty">Критичных проблем качества данных сейчас нет.</div>`;
    return;
  }

  els.qualityList.innerHTML = criticalFieldsHtml + items.slice(0, 8).map((item) => `
    <article class="queue-item" data-opportunity-id="${item.opportunity_id}">
      <div class="queue-top">
        <div>
          <h3 class="queue-title">${item.company ?? 'Без компании'}</h3>
          <div class="queue-subtitle">${item.object ?? 'Объект не определён'}</div>
        </div>
        <span class="badge badge-low">quality ${item.quality_score}</span>
      </div>
      <div class="badge-row">
        ${item.issues.map((issue) => `<span class="badge badge-low">${issue}</span>`).join('')}
      </div>
    </article>
  `).join('');

  document.querySelectorAll('#qualityList .queue-item').forEach((node) => {
    node.addEventListener('click', () => {
      els.cardIdInput.value = node.dataset.opportunityId;
      loadCard(node.dataset.opportunityId);
    });
  });
}

function renderNormalizationDashboard(payload) {
  const summary = payload.summary ?? {};
  els.normalizationSummary.innerHTML = `
    <div class="stat-card">
      <span class="stat-label">Companies</span>
      <strong>${summary.companies_seen ?? 0}</strong>
    </div>
    <div class="stat-card">
      <span class="stat-label">Objects</span>
      <strong>${summary.objects_seen ?? 0}</strong>
    </div>
    <div class="stat-card">
      <span class="stat-label">Persons</span>
      <strong>${summary.persons_seen ?? 0}</strong>
    </div>
    <div class="stat-card">
      <span class="stat-label">Candidates</span>
      <strong>${summary.duplicate_candidates ?? 0}</strong>
    </div>
  `;

  const items = payload.items ?? [];
  if (!items.length) {
    els.normalizationList.innerHTML = '<div class="empty">Явных кандидатов на дубли сейчас не найдено.</div>';
    return;
  }

  els.normalizationList.innerHTML = items.slice(0, 10).map((item) => `
    <article class="queue-item">
      <div class="queue-top">
        <div>
          <h3 class="queue-title">${item.left_label}</h3>
          <div class="queue-subtitle">${item.right_label}</div>
        </div>
        <span class="badge badge-high">${item.entity_kind} · ${item.similarity_score}</span>
      </div>
      <div class="muted">suggested id: ${item.suggested_resolved_entity_id ?? '—'}</div>
    </article>
  `).join('');
}

function renderFeedbackLearningDashboard(payload) {
  const summary = payload.summary ?? {};
  els.feedbackLearningSummary.innerHTML = `
    <div class="stat-card">
      <span class="stat-label">Feedback</span>
      <strong>${summary.total_feedback ?? 0}</strong>
    </div>
    <div class="stat-card">
      <span class="stat-label">Accepted</span>
      <strong>${Math.round((summary.accepted_rate ?? 0) * 100)}%</strong>
    </div>
    <div class="stat-card">
      <span class="stat-label">Executed</span>
      <strong>${Math.round((summary.executed_rate ?? 0) * 100)}%</strong>
    </div>
    <div class="stat-card">
      <span class="stat-label">Rejected</span>
      <strong>${Math.round((summary.rejected_rate ?? 0) * 100)}%</strong>
    </div>
    <div class="stat-card">
      <span class="stat-label">Coverage</span>
      <strong>${Math.round((summary.recommendation_coverage ?? 0) * 100)}%</strong>
    </div>
  `;

  const actionItems = payload.action_metrics ?? [];
  els.feedbackLearningList.innerHTML = actionItems.length
    ? actionItems.map((item) => `
      <article class="queue-item">
        <div class="queue-top">
          <div>
            <h3 class="queue-title">${item.action_code ?? 'unknown'}</h3>
            <div class="queue-subtitle">feedback: ${item.total}</div>
          </div>
          <span class="badge badge-high">${Math.round((item.executed_rate ?? 0) * 100)}% executed</span>
        </div>
        <div class="badge-row">
          <span class="badge badge-low">accepted ${Math.round((item.accepted_rate ?? 0) * 100)}%</span>
          <span class="badge badge-low">executed ${Math.round((item.executed_rate ?? 0) * 100)}%</span>
          <span class="badge badge-low">rejected ${Math.round((item.rejected_rate ?? 0) * 100)}%</span>
        </div>
      </article>
    `).join('')
    : '<div class="empty">По рекомендациям пока мало данных для обучения.</div>';

  const recentItems = payload.recent_feedback ?? [];
  els.feedbackRecentList.innerHTML = recentItems.length
    ? recentItems.map((item) => `
      <article class="queue-item">
        <div class="queue-top">
          <div>
            <h3 class="queue-title">${item.company ?? 'Без компании'}</h3>
            <div class="queue-subtitle">${item.action_code ?? 'unknown'} · ${item.status}</div>
          </div>
          <span class="badge badge-low">${formatDateTime(item.recorded_at)}</span>
        </div>
      </article>
    `).join('')
    : '<div class="empty">Последних feedback-событий пока нет.</div>';
}

function renderAuditLogs(items) {
  if (!items.length) {
    els.auditList.innerHTML = '<div class="empty">Журнал пока пуст.</div>';
    return;
  }

  els.auditList.innerHTML = items.map((item) => `
    <article class="queue-item">
      <div class="queue-top">
        <div>
          <h3 class="queue-title">${item.action_code}</h3>
          <div class="queue-subtitle">${item.actor_name ?? item.actor_external_id ?? 'unknown'} · ${item.actor_role ?? '—'}</div>
        </div>
        <span class="badge badge-low">${formatDateTime(item.created_at)}</span>
      </div>
      <div class="muted">${item.resource_type}${item.resource_id ? ` / ${item.resource_id}` : ''} · ${item.outcome_code}</div>
    </article>
  `).join('');
}

function renderDetailRows(details) {
  return Object.entries(details).map(([label, value]) => `
    <div class="detail-row">
      <dt>${label}</dt>
      <dd>${value ?? '—'}</dd>
    </div>
  `).join('');
}

function renderGraphBlock(graph) {
  if (!graph || !graph.nodes?.length) {
    return '<div class="empty">Граф связей пока пуст.</div>';
  }

  return `
    <div class="graph-board">
      <div class="graph-nodes">
        ${graph.nodes.map((node) => `
          <div class="graph-node">
            <span class="graph-node-type">${node.type}</span>
            <strong>${node.label}</strong>
          </div>
        `).join('')}
      </div>
      <div class="graph-edges">
        ${graph.edges.map((edge) => `
          <div class="graph-edge">${edge.source} -> ${edge.type} -> ${edge.target}</div>
        `).join('')}
      </div>
    </div>
  `;
}

function renderCommunicationHistory(items) {
  if (!items?.length) {
    return '<div class="empty">Коммуникаций по сделке пока нет.</div>';
  }

  return `
    <div class="history-list">
      ${items.map((item) => `
        <div class="history-item">
          <strong>${item.summary ?? item.type ?? 'Событие'}</strong>
          <div class="muted">${item.channel ?? 'channel?'} · ${item.author_name ?? 'без автора'} · ${formatDateTime(item.datetime)}</div>
          <div>${item.text ?? '—'}</div>
        </div>
      `).join('')}
    </div>
  `;
}

function renderEvidenceList(items, formatter) {
  if (!items?.length) {
    return '<div class="empty">Нет подтверждающих событий.</div>';
  }

  return `
    <div class="history-list">
      ${items.map((item) => `
        <div class="history-item">
          ${formatter(item)}
        </div>
      `).join('')}
    </div>
  `;
}

function renderRiskEvidence(evidence) {
  if (!evidence) {
    return '<div class="empty">Evidence пока не собрано.</div>';
  }

  const flags = evidence.flags ?? {};
  const counters = evidence.counters ?? {};

  return `
    <div class="history-list">
      <div class="history-item">
        <strong>Flags</strong>
        <div class="badge-row">
          <span class="badge badge-low">competitor: ${flags.competitor_present ? 'yes' : 'no'}</span>
          <span class="badge badge-low">debt: ${flags.debt_risk ? 'yes' : 'no'}</span>
          <span class="badge badge-low">subrent: ${flags.subrent_required ? 'yes' : 'no'}</span>
          <span class="badge badge-low">promise overdue: ${flags.manager_promise_overdue ? 'yes' : 'no'}</span>
        </div>
      </div>
      <div class="history-item">
        <strong>Counters</strong>
        <div class="badge-row">
          ${Object.entries(counters).map(([key, value]) => `<span class="badge badge-low">${key}: ${value}</span>`).join('')}
        </div>
      </div>
    </div>
    <div class="card-grid compact-grid">
      <section class="card-section">
        <p class="panel-kicker">Evidence</p>
        <h3>Competitor</h3>
        ${renderEvidenceList(evidence.evidence?.competitor, (item) => `
          <strong>${item.summary ?? '—'}</strong>
          <div class="muted">${item.channel ?? '—'} · ${formatDateTime(item.datetime)}</div>
          <div>markers: ${(item.markers ?? []).join(', ') || '—'}</div>
        `)}
      </section>
      <section class="card-section">
        <p class="panel-kicker">Evidence</p>
        <h3>Debt Risk</h3>
        ${renderEvidenceList(evidence.evidence?.debt_risk, (item) => `
          <strong>${item.summary ?? '—'}</strong>
          <div class="muted">${item.channel ?? '—'} · ${formatDateTime(item.datetime)}</div>
          <div>markers: ${(item.markers ?? []).join(', ') || '—'}</div>
        `)}
      </section>
      <section class="card-section">
        <p class="panel-kicker">Evidence</p>
        <h3>Subrent</h3>
        ${renderEvidenceList(evidence.evidence?.subrent, (item) => `
          <strong>${item.summary ?? '—'}</strong>
          <div class="muted">${item.channel ?? '—'} · ${formatDateTime(item.datetime)}</div>
        `)}
      </section>
      <section class="card-section">
        <p class="panel-kicker">Evidence</p>
        <h3>Manager Promises</h3>
        ${renderEvidenceList(evidence.evidence?.manager_promises, (item) => `
          <strong>${item.promise ?? item.summary ?? '—'}</strong>
          <div class="muted">${item.channel ?? '—'} · ${formatDateTime(item.datetime)}</div>
          <div>due: ${formatDateTime(item.due_at)} · action: ${item.action_code ?? '—'}</div>
        `)}
      </section>
    </div>
  `;
}

function renderDecisionTimeline(items) {
  if (!items?.length) {
    return '<div class="empty">Timeline решений пока пуст.</div>';
  }

  return `
    <div class="history-list">
      ${items.map((item) => `
        <div class="history-item">
          <strong>${item.title ?? item.event_type}</strong>
          <div class="muted">${item.event_type} · ${formatDateTime(item.created_at)}</div>
          <div>${item.subtitle ?? '—'}</div>
          ${item.event_type === 'feedback' ? `
            <div class="badge-row">
              ${item.payload?.effect_after_1_day ? `<span class="badge badge-low">1d</span>` : ''}
              ${item.payload?.effect_after_3_days ? `<span class="badge badge-low">3d</span>` : ''}
              ${item.payload?.effect_after_7_days ? `<span class="badge badge-low">7d</span>` : ''}
              ${item.payload?.effect_after_30_days ? `<span class="badge badge-low">30d</span>` : ''}
            </div>
            <div class="muted">
              ${item.payload?.effect_after_1_day ?? item.payload?.effect_after_3_days ?? item.payload?.effect_after_7_days ?? item.payload?.effect_after_30_days ?? item.payload?.deal_result ?? ''}
            </div>
          ` : ''}
        </div>
      `).join('')}
    </div>
  `;
}

function renderStopSignals(stopSignals) {
  if (!stopSignals) {
    return '<div class="empty">Стоп-сигналы пока не рассчитаны.</div>';
  }

  const renderList = (items, emptyLabel) => (
    items?.length
      ? `<div class="history-list">${items.map((item) => `<div class="history-item">${item}</div>`).join('')}</div>`
      : `<div class="empty">${emptyLabel}</div>`
  );

  return `
    <div class="card-grid compact-grid">
      <section class="card-section">
        <p class="panel-kicker">Why Not Now</p>
        <h3>Блокирующие причины</h3>
        ${renderList(stopSignals.blocked_reasons, 'Явных блокеров сейчас нет.')}
      </section>
      <section class="card-section">
        <p class="panel-kicker">Why Not Now</p>
        <h3>Почему приоритет ниже</h3>
        ${renderList(stopSignals.low_priority_reasons, 'Сделка не выглядит искусственно заниженной.')}
      </section>
      <section class="card-section">
        <p class="panel-kicker">Stop Signals</p>
        <h3>Стратегические предупреждения</h3>
        ${renderList(stopSignals.strategy_warnings, 'Стратегических стоп-сигналов пока нет.')}
      </section>
      <section class="card-section">
        <p class="panel-kicker">Before Attack</p>
        <h3>Что нужно сделать до дожима</h3>
        ${renderList(stopSignals.wait_conditions, 'Сделку можно атаковать без дополнительных стоп-условий.')}
      </section>
    </div>
  `;
}

function renderFeedbackHistory(items) {
  if (!items?.length) {
    return '<div class="empty">Feedback по рекомендации пока нет.</div>';
  }

  return `
    <div class="history-list">
      ${items.map((item) => {
        let status = 'shown';
        if (item.executed) status = 'executed';
        else if (item.accepted) status = 'accepted';
        else if (item.rejected) status = 'rejected';

        return `
          <div class="history-item">
            <strong>${item.action_code ?? 'recommendation'} · ${status}</strong>
            <div class="muted">${formatDateTime(item.recorded_at)}</div>
            <div>${item.rejection_reason ?? item.deal_result ?? '—'}</div>
            <div class="badge-row">
              ${item.effect_after_1_day ? '<span class="badge badge-low">1d</span>' : ''}
              ${item.effect_after_3_days ? '<span class="badge badge-low">3d</span>' : ''}
              ${item.effect_after_7_days ? '<span class="badge badge-low">7d</span>' : ''}
              ${item.effect_after_30_days ? '<span class="badge badge-low">30d</span>' : ''}
            </div>
            <div class="muted">
              ${item.effect_after_1_day ?? item.effect_after_3_days ?? item.effect_after_7_days ?? item.effect_after_30_days ?? ''}
            </div>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

function getFeedbackFormValues() {
  return {
    deal_result: document.querySelector('#feedbackDealResult')?.value?.trim() || null,
    effect_after_1_day: document.querySelector('#feedback1d')?.value?.trim() || null,
    effect_after_3_days: document.querySelector('#feedback3d')?.value?.trim() || null,
    effect_after_7_days: document.querySelector('#feedback7d')?.value?.trim() || null,
    effect_after_30_days: document.querySelector('#feedback30d')?.value?.trim() || null,
  };
}

function renderCard(card) {
  if (!card) {
    els.cardView.innerHTML = '<div class="empty">Сделка не найдена.</div>';
    return;
  }

  els.cardView.innerHTML = `
    <div class="card-grid">
      <section class="card-section">
        <p class="panel-kicker">Summary</p>
        <h3>${card.summary.company ?? 'Без компании'}</h3>
        <dl class="detail-list">
          ${renderDetailRows({
            Контакт: card.summary.contact,
            Менеджер: card.summary.owner_manager,
            Объект: card.summary.object,
            Техника: card.summary.equipment_type,
            Стадия: card.summary.commercial_stage,
            'Последнее касание': formatDateTime(card.summary.last_touch_at),
          })}
        </dl>
      </section>
      <section class="card-section">
        <p class="panel-kicker">Decision</p>
        <h3>${card.recommendation.action_name ?? 'Рекомендации нет'}</h3>
        <dl class="detail-list">
          ${renderDetailRows({
            Приоритет: card.priority_score,
            Статус: card.recommendation.recommendation_status,
            Роль: card.recommendation.target_role,
            Дедлайн: formatDateTime(card.recommendation.deadline_at),
            Эскалация: card.recommendation.escalation_action_code,
            'Accept rate': card.recommendation.action_effectiveness ? `${Math.round((card.recommendation.action_effectiveness.accepted_rate ?? 0) * 100)}%` : '—',
            'Exec rate': card.recommendation.action_effectiveness ? `${Math.round((card.recommendation.action_effectiveness.executed_rate ?? 0) * 100)}%` : '—',
          })}
        </dl>
        <div class="action-row">
          <button class="button button-success" data-feedback="accepted">Принять</button>
          <button class="button button-danger" data-feedback="rejected">Отклонить</button>
          <button class="button button-secondary" data-feedback="executed">Выполнено</button>
        </div>
        <div class="status-line">
          Recommendation ID: ${card.recommendation.recommendation_id ?? '—'}
        </div>
        <div class="history-list" style="margin-top: 12px;">
          <div class="history-item">
            <strong>Feedback Form</strong>
            <div class="queue-search" style="margin-top: 10px;">
              <input id="feedbackDealResult" type="text" placeholder="Итог по сделке / комментарий" />
              <input id="feedback1d" type="text" placeholder="Effect after 1 day" />
              <input id="feedback3d" type="text" placeholder="Effect after 3 days" />
              <input id="feedback7d" type="text" placeholder="Effect after 7 days" />
              <input id="feedback30d" type="text" placeholder="Effect after 30 days" />
            </div>
          </div>
        </div>
      </section>
      <section class="card-section full">
        <p class="panel-kicker">Explainability</p>
        <h3>Почему сейчас</h3>
        <div class="history-list">
          ${(card.recommendation.explainability?.why_important ?? []).map((item) => `<div class="history-item">${item}</div>`).join('') || '<div class="empty">Пока без explainability.</div>'}
        </div>
      </section>
      <section class="card-section full">
        <p class="panel-kicker">Risk / Evidence</p>
        <h3>Сигналы и подтверждения</h3>
        ${renderRiskEvidence(card.risk_evidence)}
      </section>
      <section class="card-section full">
        <p class="panel-kicker">Why Not Now / Stop Signals</p>
        <h3>Почему не всегда нужно атаковать прямо сейчас</h3>
        ${renderStopSignals(card.stop_signals)}
      </section>
      <section class="card-section">
        <p class="panel-kicker">Score Vector</p>
        <h3>Индексы</h3>
        <div class="score-row">
          ${Object.entries(card.score_vector).map(([key, value]) => `<span class="score-pill">${key}: ${value}</span>`).join('')}
        </div>
      </section>
      <section class="card-section">
        <p class="panel-kicker">State History</p>
        <h3>Состояния</h3>
        <div class="history-list">
          ${(card.state_history ?? []).slice(0, 6).map((item) => `
            <div class="history-item">
              <strong>${item.state_code}</strong><br />
              <span class="muted">${item.reason ?? ''}</span>
            </div>
          `).join('') || '<div class="empty">История пока пуста.</div>'}
        </div>
      </section>
      <section class="card-section full">
        <p class="panel-kicker">Recommendations History</p>
        <h3>История рекомендаций</h3>
        <div class="history-list">
          ${(card.recommendations_history ?? []).map((item) => `
            <div class="history-item">
              <strong>${item.action_code ?? '—'}</strong>
              <div class="muted">status: ${item.status ?? '—'} · deadline: ${formatDateTime(item.deadline_at)}</div>
            </div>
          `).join('') || '<div class="empty">История рекомендаций пока пуста.</div>'}
        </div>
      </section>
      <section class="card-section full">
        <p class="panel-kicker">Decision Timeline</p>
        <h3>Хронология решений и feedback</h3>
        ${renderDecisionTimeline(card.decision_timeline)}
      </section>
      <section class="card-section full">
        <p class="panel-kicker">Feedback History</p>
        <h3>Эффект рекомендаций</h3>
        ${renderFeedbackHistory(card.feedback_history)}
      </section>
      <section class="card-section full">
        <p class="panel-kicker">Communication History</p>
        <h3>История касаний</h3>
        ${renderCommunicationHistory(card.communication_history)}
      </section>
      <section class="card-section full">
        <p class="panel-kicker">Similar Cases</p>
        <h3>Похожие кейсы</h3>
        <div class="history-list">
          ${(card.similar_cases ?? []).map((item) => `
            <div class="history-item">
              <strong>${item.title ?? 'Без названия'}</strong>
              <div class="muted">outcome: ${item.outcome ?? '—'} · source: ${item.source ?? 'unknown'}</div>
              <div>${item.hint ?? '—'}</div>
            </div>
          `).join('') || '<div class="empty">Похожие кейсы пока не найдены.</div>'}
        </div>
      </section>
      <section class="card-section full">
        <p class="panel-kicker">Graph View</p>
        <h3>Связи по сделке</h3>
        ${renderGraphBlock(card.graph)}
      </section>
    </div>
  `;

  document.querySelectorAll('[data-feedback]').forEach((button) => {
    button.addEventListener('click', async () => {
      const recommendationId = card.recommendation.recommendation_id;
      if (!recommendationId) return;

      const mode = button.dataset.feedback;
      const payload = {
        shown: true,
        accepted: mode === 'accepted',
        rejected: mode === 'rejected',
        executed: mode === 'executed',
        rejection_reason: mode === 'rejected' ? 'Отклонено из UI manager card' : null,
        result_after_days: mode === 'executed' ? 'Отмечено как выполненное из UI' : null,
        ...getFeedbackFormValues(),
      };

      await api(`/actions/${encodeURIComponent(recommendationId)}/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      await loadCard(uiState.currentCardId);
    });
  });
}

function renderSimpleList(element, items, formatter) {
  if (!items.length) {
    element.innerHTML = '<div class="empty">Пусто.</div>';
    return;
  }

  element.innerHTML = items.map((item) => `<div class="simple-item">${formatter(item)}</div>`).join('');
}

async function loadQueue() {
  const params = new URLSearchParams({
    limit: String(Number(els.queueLimit.value)),
  });

  if (els.queueBucket.value) params.set('bucket', els.queueBucket.value);
  if (els.queueState.value) params.set('state', els.queueState.value);
  if (els.queueMode.value) params.set('mode', els.queueMode.value);
  if (els.queueSearch.value.trim()) params.set('search', els.queueSearch.value.trim());

  const data = await api(`/dashboard/manager/queue?${params.toString()}`);
  renderQueue(data.items);
  return data.items;
}

async function loadCard(opportunityId = els.cardIdInput.value.trim()) {
  if (!opportunityId) return null;
  uiState.currentCardId = opportunityId;
  try {
    const card = await api(`/opportunities/${opportunityId}/card`);
    renderCard(card);
    return card;
  } catch (error) {
    renderCard(null);
    return null;
  }
}

async function loadIngestMonitor() {
  const [pending, errors] = await Promise.all([
    api('/events/bitrix/pending'),
    api('/events/bitrix/errors'),
  ]);

  renderSimpleList(els.pendingList, pending.items, (item) =>
    `<strong>${item.source_event_id ?? item.id}</strong><div class="muted">${item.processing_status}</div>`,
  );
  renderSimpleList(els.errorList, errors.items, (item) =>
    `<strong>${item.source_event_id ?? item.id}</strong><div class="muted">${item.error_message ?? 'Без сообщения'}</div>`,
  );

  return { pending: pending.items, errors: errors.items };
}

async function loadRopEscalations() {
  const params = new URLSearchParams({ limit: '12' });
  if (els.ropType.value) params.set('type', els.ropType.value);
  const data = await api(`/dashboard/rop/escalations?${params.toString()}`);
  renderRopEscalations(data.items);
  return data.items;
}

async function loadDataQuality() {
  const payload = await api('/dashboard/data-quality');
  renderQualityDashboard(payload);
  return payload;
}

async function loadNormalizationDashboard() {
  const payload = await api('/dashboard/normalization');
  renderNormalizationDashboard(payload);
  return payload;
}

async function loadFeedbackLearningDashboard() {
  const payload = await api('/dashboard/feedback-learning');
  renderFeedbackLearningDashboard(payload);
  return payload;
}

async function loadAuditLogs() {
  try {
    const payload = await api('/audit/logs?limit=12');
    renderAuditLogs(payload.items ?? []);
    return payload.items ?? [];
  } catch {
    renderAuditLogs([]);
    return [];
  }
}

async function loadAuthMe() {
  uiState.auth = await api('/auth/me');
  return uiState.auth;
}

async function loadLogisticsDashboard() {
  const params = new URLSearchParams({ limit: '12' });
  if (els.logisticsMode.value) params.set('mode', els.logisticsMode.value);
  const data = await api(`/dashboard/logistics?${params.toString()}`);
  renderLogisticsQueue(data.items);
  return data.items;
}

async function loadOwnerDashboard() {
  const params = new URLSearchParams({ limit: '12' });
  if (els.ownerStrategy.value) params.set('strategy', els.ownerStrategy.value);
  const payload = await api(`/dashboard/owner?${params.toString()}`);
  renderOwnerDashboard(payload);
  return payload.items ?? [];
}

async function refreshAll() {
  try {
    await loadAuthMe();
    const [queueItems, ropItems, monitor] = await Promise.all([loadQueue(), loadRopEscalations(), loadIngestMonitor()]);
    await Promise.all([
      loadDataQuality(),
      loadNormalizationDashboard(),
      loadFeedbackLearningDashboard(),
      loadAuditLogs(),
      loadLogisticsDashboard(),
      loadOwnerDashboard(),
    ]);
    const currentCard = await loadCard();
    if (!currentCard && queueItems[0]) {
      els.cardIdInput.value = queueItems[0].opportunity_id;
      await loadCard(queueItems[0].opportunity_id);
    }
    renderHeroStats(queueItems, ropItems, monitor.pending, monitor.errors);
  } catch (error) {
    els.cardView.innerHTML = `<div class="empty">Ошибка загрузки: ${error.message}</div>`;
  }
}

els.refreshAll.addEventListener('click', refreshAll);
els.loadFirstCard.addEventListener('click', async () => {
  const queue = await loadQueue();
  if (queue[0]) {
    els.cardIdInput.value = queue[0].opportunity_id;
    await loadCard(queue[0].opportunity_id);
  }
});
els.loadCardButton.addEventListener('click', () => loadCard());
els.queueLimit.addEventListener('change', refreshAll);
els.queueBucket.addEventListener('change', refreshAll);
els.queueState.addEventListener('change', refreshAll);
els.queueMode.addEventListener('change', refreshAll);
els.ropType.addEventListener('change', refreshAll);
els.logisticsMode.addEventListener('change', refreshAll);
els.ownerStrategy.addEventListener('change', refreshAll);
els.userRole.addEventListener('change', refreshAll);
els.queueSearch.addEventListener('input', () => {
  clearTimeout(els.queueSearch._debounceId);
  els.queueSearch._debounceId = setTimeout(refreshAll, 250);
});
els.processIngestButton.addEventListener('click', async () => {
  await api('/events/bitrix/process', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ limit: 50 }),
  });
  await refreshAll();
});

refreshAll();
