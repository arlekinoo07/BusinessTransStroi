const COMPANY_SUFFIXES = [
  'ооо',
  'зао',
  'пао',
  'ип',
  'ao',
  'oao',
  'ooo',
  'zao',
  'pao',
  'llc',
];

const EQUIPMENT_ALIASES = new Map([
  ['автокран', 'Автокран'],
  ['кран', 'Автокран'],
  ['экскаватор', 'Экскаватор'],
  ['миниэкскаватор', 'Миниэкскаватор'],
  ['манипулятор', 'Манипулятор'],
  ['автовышка', 'Автовышка'],
  ['погрузчик', 'Погрузчик'],
  ['бульдозер', 'Бульдозер'],
]);

const NOISE_SEGMENTS = [
  'следующий шаг',
  'клиент просит',
  'клиент готов',
  'контакт',
  'адрес',
  'техника',
  'priority score',
  'need score',
  'time score',
  'spec score',
  'access score',
  'money score',
  'fit score',
];

function cleanupText(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

function trimNoiseTail(value) {
  const raw = cleanupText(value);
  if (!raw) return raw;
  const lowered = raw.toLowerCase();
  const indexes = NOISE_SEGMENTS
    .map((segment) => lowered.indexOf(segment))
    .filter((index) => index > 0);
  if (!indexes.length) return raw;
  return raw.slice(0, Math.min(...indexes)).trim();
}

function normalizeToken(value) {
  return cleanupText(value)
    .toLowerCase()
    .replace(/[«»"'.,/#!$%^&*;:{}=_`~()\\[\]+-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function uniqueTokens(value) {
  return Array.from(new Set(normalizeToken(value).split(' ').filter(Boolean)));
}

function stableEntityId(prefix, normalized, fallbackRaw) {
  const source = normalizeToken(normalized || fallbackRaw);
  return source ? `${prefix}:${source}` : null;
}

function normalizeObjectMarkers(value) {
  return normalizeToken(value)
    .replace(/\bжк\b/g, 'жилой комплекс')
    .replace(/\bбц\b/g, 'бизнес центр')
    .replace(/\bтц\b/g, 'торговый центр')
    .replace(/\bтрц\b/g, 'торгово развлекательный центр')
    .replace(/\bск\b/g, 'складской комплекс');
}

function normalizeAddressMarkers(value) {
  return normalizeToken(value)
    .replace(/\bул\b/g, 'улица')
    .replace(/\bул\.\b/g, 'улица')
    .replace(/\bпр-т\b/g, 'проспект')
    .replace(/\bпросп\b/g, 'проспект')
    .replace(/\bд\b/g, 'дом')
    .replace(/\bд\.\b/g, 'дом')
    .replace(/\bкорп\b/g, 'корпус')
    .replace(/\bкорп\.\b/g, 'корпус');
}

function scoreTokenSimilarity(left, right) {
  const a = new Set(uniqueTokens(left));
  const b = new Set(uniqueTokens(right));
  if (!a.size || !b.size) return 0;

  const intersection = Array.from(a).filter((token) => b.has(token)).length;
  const union = new Set([...a, ...b]).size;
  return union ? intersection / union : 0;
}

export function scoreEntitySimilarity(left, right) {
  const leftNorm = normalizeToken(left);
  const rightNorm = normalizeToken(right);
  if (!leftNorm || !rightNorm) return 0;
  if (leftNorm === rightNorm) return 1;
  return Number(scoreTokenSimilarity(leftNorm, rightNorm).toFixed(3));
}

export function findDuplicateCandidates(items, {
  threshold = 0.74,
  kind = 'entity',
  getLabel = (item) => item?.raw_value ?? item?.normalized_value ?? '',
  getNormalized = (item) => item?.normalized_value ?? '',
  getReferenceId = (item, index) => item?.resolved_entity_id ?? `${kind}:${index}`,
} = {}) {
  const candidates = [];

  for (let index = 0; index < items.length; index += 1) {
    for (let cursor = index + 1; cursor < items.length; cursor += 1) {
      const left = items[index];
      const right = items[cursor];
      const leftLabel = getLabel(left);
      const rightLabel = getLabel(right);
      const leftNorm = getNormalized(left);
      const rightNorm = getNormalized(right);

      if (!leftLabel || !rightLabel || leftLabel === rightLabel) {
        continue;
      }

      const similarity = scoreEntitySimilarity(leftNorm || leftLabel, rightNorm || rightLabel);
      if (similarity < threshold) {
        continue;
      }

      candidates.push({
        entity_kind: kind,
        left_ref: getReferenceId(left, index),
        right_ref: getReferenceId(right, cursor),
        left_label: leftLabel,
        right_label: rightLabel,
        similarity_score: similarity,
        suggested_resolved_entity_id: stableEntityId(kind, leftNorm || rightNorm, `${leftLabel} ${rightLabel}`),
      });
    }
  }

  return candidates
    .sort((left, right) => right.similarity_score - left.similarity_score)
    .slice(0, 100);
}

export function findContextualDuplicateCandidates(items, {
  threshold = 0.78,
  kind = 'entity',
  getReferenceId = (item, index) => item?.resolved_entity_id ?? `${kind}:${index}`,
  getLabel = (item) => item?.raw_value ?? item?.normalized_value ?? '',
  getPrimary = (item) => item?.normalized_value ?? item?.raw_value ?? '',
  getContext = () => ({}),
} = {}) {
  const candidates = [];

  for (let index = 0; index < items.length; index += 1) {
    for (let cursor = index + 1; cursor < items.length; cursor += 1) {
      const left = items[index];
      const right = items[cursor];
      const leftPrimary = getPrimary(left);
      const rightPrimary = getPrimary(right);
      const leftLabel = getLabel(left);
      const rightLabel = getLabel(right);
      if (!leftPrimary || !rightPrimary || !leftLabel || !rightLabel) {
        continue;
      }

      const baseScore = scoreEntitySimilarity(leftPrimary, rightPrimary);
      const leftContext = getContext(left) ?? {};
      const rightContext = getContext(right) ?? {};
      const reasons = [];
      let bonus = 0;

      if (leftContext.address && rightContext.address) {
        const addressScore = scoreEntitySimilarity(leftContext.address, rightContext.address);
        if (addressScore >= 0.72) {
          bonus += 0.18;
          reasons.push('address_match');
        }
      }

      if (leftContext.role && rightContext.role) {
        const roleScore = scoreEntitySimilarity(leftContext.role, rightContext.role);
        if (roleScore >= 0.85) {
          bonus += 0.1;
          reasons.push('role_match');
        }
      }

      if (leftContext.equipment && rightContext.equipment) {
        const equipmentScore = scoreEntitySimilarity(leftContext.equipment, rightContext.equipment);
        if (equipmentScore >= 0.85) {
          bonus += 0.1;
          reasons.push('equipment_match');
        }
      }

      if (leftContext.company && rightContext.company) {
        const companyScore = scoreEntitySimilarity(leftContext.company, rightContext.company);
        if (companyScore >= 0.8) {
          bonus += 0.12;
          reasons.push('company_match');
        }
      }

      const similarity = Number(Math.min(1, baseScore + bonus).toFixed(3));
      if (similarity < threshold) {
        continue;
      }

      candidates.push({
        entity_kind: kind,
        left_ref: getReferenceId(left, index),
        right_ref: getReferenceId(right, cursor),
        left_label: leftLabel,
        right_label: rightLabel,
        similarity_score: similarity,
        match_reasons: ['name_match', ...reasons],
        suggested_resolved_entity_id: stableEntityId(kind, leftPrimary || rightPrimary, `${leftLabel} ${rightLabel}`),
      });
    }
  }

  return candidates
    .sort((left, right) => right.similarity_score - left.similarity_score)
    .slice(0, 100);
}

export function normalizeCompanyName(rawValue) {
  const raw = trimNoiseTail(rawValue);
  const normalized = normalizeToken(raw)
    .split(' ')
    .filter((token) => token && !COMPANY_SUFFIXES.includes(token))
    .join(' ');

  return {
    raw_value: raw,
    normalized_value: normalized || raw.toLowerCase(),
    confidence_score: normalized ? 0.9 : 0.4,
    resolved_entity_id: stableEntityId('company', normalized, raw),
  };
}

export function normalizeObjectName(rawValue) {
  const raw = trimNoiseTail(rawValue)
    .replace(/\bконтакт\s*:\s*.*$/i, '')
    .replace(/\bадрес\s*:\s*.*$/i, '')
    .replace(/\bтехника\s*:\s*.*$/i, '')
    .trim();
  const normalized = normalizeObjectMarkers(raw);

  return {
    raw_value: raw,
    normalized_value: normalized,
    confidence_score: normalized ? 0.85 : 0.3,
    resolved_entity_id: stableEntityId('object', normalized, raw),
  };
}

export function normalizeAddress(rawValue) {
  const raw = trimNoiseTail(rawValue);
  const normalized = normalizeAddressMarkers(raw);

  return {
    raw_value: raw,
    normalized_value: normalized,
    confidence_score: normalized ? 0.8 : 0.3,
    resolved_entity_id: stableEntityId('address', normalized, raw),
  };
}

export function normalizeEquipmentType(rawValue) {
  const raw = trimNoiseTail(rawValue)
    .replace(/\bследующий шаг\s*:\s*.*$/i, '')
    .trim();
  const normalizedToken = normalizeToken(raw);

  for (const [alias, canonical] of EQUIPMENT_ALIASES.entries()) {
    if (normalizedToken.includes(alias)) {
      return {
        raw_value: raw,
        normalized_value: canonical,
        confidence_score: 0.92,
        resolved_entity_id: `equipment_type:${canonical.toLowerCase()}`,
      };
    }
  }

  return {
    raw_value: raw,
    normalized_value: raw,
    confidence_score: raw ? 0.45 : 0.2,
    resolved_entity_id: raw ? `equipment_type:${normalizedToken}` : null,
  };
}

export function normalizePersonName(rawValue) {
  const raw = trimNoiseTail(rawValue);
  const normalized = normalizeToken(raw);

  return {
    raw_value: raw,
    normalized_value: normalized,
    confidence_score: normalized ? 0.75 : 0.25,
    resolved_entity_id: stableEntityId('person', normalized, raw),
  };
}

export function normalizeCommunicationEvent(event) {
  return {
    ...event,
    summary: cleanupText(event.summary),
    text: cleanupText(event.text),
  };
}
