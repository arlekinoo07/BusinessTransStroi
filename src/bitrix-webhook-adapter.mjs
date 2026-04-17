function mapEventNameToEntityType(eventName) {
  const normalized = String(eventName ?? '').toUpperCase();

  if (normalized.includes('CRMDEAL')) return 'deal';
  if (normalized.includes('CRMCOMPANY')) return 'company';
  if (normalized.includes('CRMCONTACT')) return 'contact';
  if (normalized.includes('CRMACTIVITY')) return 'activity';
  if (normalized.includes('CRMTIMELINECOMMENT')) return 'comment';
  if (normalized.includes('TASK')) return 'task';
  return 'unknown';
}

function mapEventNameToAction(eventName) {
  const normalized = String(eventName ?? '').toUpperCase();
  if (normalized.endsWith('ADD')) return 'created';
  if (normalized.endsWith('UPDATE')) return 'updated';
  if (normalized.endsWith('DELETE')) return 'deleted';
  return 'updated';
}

function extractEntityId(payload) {
  return String(
    payload?.data?.FIELDS?.ID
      ?? payload?.data?.ID
      ?? payload?.FIELDS?.ID
      ?? payload?.ID
      ?? '',
  );
}

export function adaptBitrixWebhookPayload(payload) {
  const entityType = mapEventNameToEntityType(payload?.event);
  const entityId = extractEntityId(payload);

  return {
    source: 'bitrix24',
    entity_type: entityType,
    entity_id: entityId,
    event_type: mapEventNameToAction(payload?.event),
    occurred_at: payload?.ts ? new Date(payload.ts).toISOString() : new Date().toISOString(),
    payload: {
      auth: payload?.auth ?? null,
      data: payload?.data ?? {},
      fields: payload?.data?.FIELDS ?? payload?.FIELDS ?? payload?.data ?? payload,
    },
  };
}
