import {
  normalizeAddress,
  normalizeCompanyName,
  normalizeEquipmentType,
  normalizeObjectName,
  normalizePersonName,
} from './normalization.mjs';

const URGENCY_MARKERS = ['срочно', 'сегодня', 'завтра', 'утром', 'как можно быстрее', 'горит'];
const MONEY_MARKERS = ['кп', 'коммерческое', 'договор', 'счет', 'счёт', 'оплата', 'аванс'];
const COMPETITOR_MARKERS = ['конкурент', 'дешевле у', 'другая компания', 'уже стоят'];
const SUBRENT_MARKERS = ['субаренда', 'партнер', 'партнёр'];

function findMatch(text, regex) {
  const match = text.match(regex);
  return match?.groups ?? null;
}

function detectUrgency(text) {
  const lowered = text.toLowerCase();
  const matched = URGENCY_MARKERS.filter((marker) => lowered.includes(marker));
  return {
    value: matched.length ? 'high' : 'normal',
    markers: matched,
    confidence: matched.length ? 0.85 : 0.45,
  };
}

function detectMoneyReadiness(text) {
  const lowered = text.toLowerCase();
  const matched = MONEY_MARKERS.filter((marker) => lowered.includes(marker));
  return {
    value: matched.length ? 'commercial' : 'early',
    markers: matched,
    confidence: matched.length ? 0.8 : 0.45,
  };
}

function detectCompetitor(text) {
  const lowered = text.toLowerCase();
  const matched = COMPETITOR_MARKERS.filter((marker) => lowered.includes(marker));
  return {
    mentioned: matched.length > 0,
    markers: matched,
    confidence: matched.length ? 0.75 : 0.3,
  };
}

function detectSupplyMode(text) {
  const lowered = text.toLowerCase();
  if (SUBRENT_MARKERS.some((marker) => lowered.includes(marker))) {
    return 'subrent';
  }

  if (lowered.includes('своя техника') || lowered.includes('наш парк')) {
    return 'own';
  }

  return 'unknown';
}

export function extractEntitiesFromText(text) {
  const sourceText = String(text ?? '').trim();
  const company = findMatch(sourceText, /(?:клиент|компания)\s*[:\-]\s*(?<value>[^\n,;.]+)/i);
  const contact = findMatch(sourceText, /(?:контакт|прораб|лпр)\s*[:\-]\s*(?<value>[^\n,;.]+)/i);
  const projectObject = findMatch(sourceText, /(?:объект|площадка)\s*[:\-]\s*(?<value>[^\n;.]+)/i);
  const address = findMatch(sourceText, /(?:адрес)\s*[:\-]\s*(?<value>[^\n;.]+)/i);
  const equipment = findMatch(sourceText, /(?:техника|нужно|требуется)\s*[:\-]\s*(?<value>[^\n;.]+)/i);
  const nextTouch = findMatch(sourceText, /(?:следующ(?:ий|ее) шаг|перезвонить|follow-up)\s*[:\-]\s*(?<value>[^\n;.]+)/i);

  return {
    company: company ? normalizeCompanyName(company.value) : null,
    person: contact ? normalizePersonName(contact.value) : null,
    project_object: projectObject ? normalizeObjectName(projectObject.value) : null,
    address: address ? normalizeAddress(address.value) : null,
    equipment_type: equipment ? normalizeEquipmentType(equipment.value) : null,
    urgency: detectUrgency(sourceText),
    money_readiness: detectMoneyReadiness(sourceText),
    competitor: detectCompetitor(sourceText),
    supply_mode: detectSupplyMode(sourceText),
    next_touch_hint: nextTouch?.value?.trim() ?? null,
    extracted_at: new Date().toISOString(),
  };
}
