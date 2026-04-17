import 'dotenv/config';

const { BITRIX24_WEBHOOK_URL } = process.env;

function getWebhookBaseUrl() {
  if (!BITRIX24_WEBHOOK_URL) {
    throw new Error('Missing BITRIX24_WEBHOOK_URL.');
  }

  return BITRIX24_WEBHOOK_URL.replace(/\/+$/, '');
}

function buildMethodUrl(method) {
  return `${getWebhookBaseUrl()}/${method}.json`;
}

export async function bitrixList(method, { select = ['*', 'UF_*'], filter = {}, limit = null } = {}) {
  const items = [];
  let start = 0;

  while (start !== null) {
    const url = new URL(buildMethodUrl(method));
    url.searchParams.set('start', String(start));

    for (const field of (select ?? [])) {
      url.searchParams.append('select[]', field);
    }

    for (const [key, value] of Object.entries(filter)) {
      if (value === undefined || value === null || value === '') continue;
      if (Array.isArray(value)) {
        for (const item of value) {
          url.searchParams.append(`filter[${key}][]`, String(item));
        }
      } else {
        url.searchParams.set(`filter[${key}]`, String(value));
      }
    }

    const response = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });

    if (!response.ok) {
      throw new Error(`Bitrix24 request failed for ${method}: ${response.status} ${response.statusText}`);
    }

    const payload = await response.json();
    if (payload.error) {
      throw new Error(`Bitrix24 API error for ${method}: ${payload.error} ${payload.error_description ?? ''}`.trim());
    }

    items.push(...(payload.result ?? []));
    if (limit && items.length >= limit) {
      return items.slice(0, limit);
    }

    start = typeof payload.next === 'number' ? payload.next : null;
  }

  return items;
}

export async function bitrixGetByIds(method, ids, { select = ['*', 'UF_*'] } = {}) {
  if (!ids.length) return [];

  const uniqueIds = Array.from(new Set(ids.map(String))).filter(Boolean);
  const results = [];

  for (const id of uniqueIds) {
    const items = await bitrixList(method, {
      select,
      filter: { ID: id },
      limit: 1,
    });
    if (items[0]) {
      results.push(items[0]);
    }
  }

  return results;
}
