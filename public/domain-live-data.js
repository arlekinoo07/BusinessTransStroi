function formatPercentValue(value, fallback = '—') {
  return Number.isFinite(value) ? `${value}%` : fallback;
}

function formatCountValue(value, fallback = '—') {
  return Number.isFinite(value) ? String(value) : fallback;
}

export function buildDomainLiveData({
  queueItems = [],
  ropItems = [],
  qualityPayload = {},
  normalizationPayload = {},
  feedbackPayload = {},
  ownerPayload = {},
  systemPayload = {},
}) {
  const qualitySummary = qualityPayload.summary ?? {};
  const normalizationSummary = normalizationPayload.summary ?? {};
  const feedbackSummary = feedbackPayload.summary ?? {};
  const ownerSummary = ownerPayload.summary ?? {};
  const systemIngest = systemPayload.ingest ?? {};

  const financeItems = queueItems.filter((item) => item.state_codes?.includes('debt_risk'));
  const salesItems = queueItems.filter((item) =>
    item.state_codes?.includes('hot_urgent') || item.state_codes?.includes('hot_unworked'),
  );
  const opsItems = queueItems.filter((item) =>
    (item.signal_markers ?? []).some((marker) => String(marker).toLowerCase().includes('subrent')),
  );

  return {
    Финансы: {
      summary: `Сейчас в финансовом контуре ${financeItems.length} сделок с риском по оплате или ограничениям и ${ropItems.length} управленческих эскалаций.`,
      kpis: [
        { label: 'Debt Risk Deals', value: formatCountValue(financeItems.length), tone: financeItems.length > 0 ? 'high' : 'low' },
        { label: 'Avg Margin', value: ownerSummary.average_margin_percent ? `${ownerSummary.average_margin_percent}%` : '—', tone: 'medium' },
        { label: 'Debt Exposure', value: formatPercentValue(ownerSummary.debt_exposure_share), tone: 'high' },
        { label: 'Ingest Freshness', value: systemIngest.freshness_state ?? '—', tone: systemIngest.freshness_state === 'stale' ? 'critical' : 'low' },
      ],
    },
    Маркетинг: {
      summary: `Маркетинговый контур опирается на качество данных и контур обучения: coverage рекомендаций ${Math.round((feedbackSummary.recommendation_coverage ?? 0) * 100)}%, заполненность client intent ${qualitySummary.client_intent_percent ?? 0}%.`,
      kpis: [
        { label: 'Client Intent', value: formatPercentValue(qualitySummary.client_intent_percent), tone: 'medium' },
        { label: 'Price Context', value: formatPercentValue(qualitySummary.price_context_percent), tone: 'low' },
        { label: 'Learning Coverage', value: `${Math.round((feedbackSummary.recommendation_coverage ?? 0) * 100)}%`, tone: 'medium' },
        { label: 'Duplicate Candidates', value: formatCountValue(normalizationSummary.duplicate_candidates), tone: (normalizationSummary.duplicate_candidates ?? 0) > 0 ? 'high' : 'low' },
      ],
    },
    Продажи: {
      summary: `В продажах сейчас ${salesItems.length} горячих сделок в очереди, ${ropItems.length} эскалаций и ${Math.round((feedbackSummary.accepted_rate ?? 0) * 100)}% принятия рекомендаций.`,
      kpis: [
        { label: 'Hot Deals', value: formatCountValue(salesItems.length), tone: salesItems.length > 0 ? 'high' : 'low' },
        { label: 'Escalations', value: formatCountValue(ropItems.length), tone: ropItems.length > 0 ? 'high' : 'low' },
        { label: 'Accepted Rate', value: `${Math.round((feedbackSummary.accepted_rate ?? 0) * 100)}%`, tone: 'medium' },
        { label: 'Executed Rate', value: `${Math.round((feedbackSummary.executed_rate ?? 0) * 100)}%`, tone: 'medium' },
      ],
    },
    Производство: {
      summary: `Производственный контур опирается на логистику, загрузку и качество данных: ${opsItems.length} сделок имеют признаки subrent/операционного давления, reserve coverage ${ownerSummary.reserve_coverage_share ?? 0}%.`,
      kpis: [
        { label: 'Ops Pressure', value: formatCountValue(opsItems.length), tone: opsItems.length > 0 ? 'high' : 'low' },
        { label: 'Reserve Coverage', value: formatPercentValue(ownerSummary.reserve_coverage_share), tone: 'medium' },
        { label: 'Partner Coverage', value: formatPercentValue(ownerSummary.partner_coverage_share), tone: 'medium' },
        { label: 'Logistics Context', value: formatPercentValue(qualitySummary.logistics_context_percent), tone: 'low' },
      ],
    },
  };
}
