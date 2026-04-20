import {
  normalizeAddress,
  normalizeCompanyName,
  normalizeEquipmentType,
  normalizeObjectName,
  normalizePersonName,
} from './normalization.mjs';

const URGENCY_MARKERS = ['срочно', 'сегодня', 'завтра', 'утром', 'как можно быстрее', 'горит', 'в ближайшее время'];
const MONEY_MARKERS = ['кп', 'коммерческое', 'договор', 'счет', 'счёт', 'оплата', 'аванс', 'смета'];
const COMPETITOR_MARKERS = ['конкурент', 'дешевле у', 'другая компания', 'уже стоят', 'конкуренты'];
const SUBRENT_MARKERS = ['субаренда', 'партнер', 'партнёр'];
const NEXT_STEP_MARKERS = [
  ['отправить кп', 'send_offer'],
  ['выслать кп', 'send_offer'],
  ['коммерческое предложение', 'send_offer'],
  ['просит кп', 'send_offer'],
  ['ждет кп', 'send_offer'],
  ['ждёт кп', 'send_offer'],
  ['отправить договор', 'send_contract'],
  ['выслать договор', 'send_contract'],
  ['нужен договор', 'send_contract'],
  ['просит договор', 'send_contract'],
  ['отправить счет', 'send_invoice'],
  ['выслать счет', 'send_invoice'],
  ['нужен счет', 'send_invoice'],
  ['нужен счёт', 'send_invoice'],
  ['уточнить параметры', 'clarify_specs'],
  ['уточнить тех', 'clarify_specs'],
  ['перезвонить', 'follow_up_reminder'],
  ['созвон', 'sales_call'],
  ['позвонить', 'sales_call'],
];
const OBJECT_KEYWORDS = ['жк', 'бц', 'тц', 'трц', 'ск', 'объект', 'площадка', 'стройка', 'склад', 'завод'];
const SYSTEM_NOISE_MARKERS = [
  'приоритетность сделки',
  'категория зрелости',
  'вектор зрелости',
  'need score',
  'time score',
  'spec score',
  'access score',
  'money score',
  'fit score',
  'no next tag',
];
const MONTH_MAP = new Map([
  ['января', 0],
  ['февраля', 1],
  ['марта', 2],
  ['апреля', 3],
  ['мая', 4],
  ['июня', 5],
  ['июля', 6],
  ['августа', 7],
  ['сентября', 8],
  ['октября', 9],
  ['ноября', 10],
  ['декабря', 11],
]);

function cleanText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function splitSentences(text) {
  return String(text ?? '')
    .split(/[\n.;]+/g)
    .map((item) => item.trim())
    .filter(Boolean);
}

function findMatch(text, regex) {
  const match = text.match(regex);
  return match?.groups ?? null;
}

function sentenceAfterKeyword(sentences, patterns) {
  const loweredPatterns = patterns.map((item) => item.toLowerCase());
  return sentences.find((sentence) => loweredPatterns.some((pattern) => sentence.toLowerCase().includes(pattern))) ?? null;
}

function normalizeHour(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function buildDateFromParts(baseDate, day, month, hour = 9, minute = 0) {
  const date = new Date(baseDate.getTime());
  date.setHours(hour, minute, 0, 0);
  date.setMonth(month);
  date.setDate(day);
  if (date.getTime() < baseDate.getTime() - (24 * 3_600_000)) {
    date.setFullYear(date.getFullYear() + 1);
  }
  return date.toISOString();
}

function parseDateHint(text) {
  const sourceText = cleanText(text);
  const now = new Date();
  const lowered = sourceText.toLowerCase();
  const explicitDate = sourceText.match(/\b(?<day>\d{1,2})[.\-/](?<month>\d{1,2})(?:[.\-/](?<year>\d{2,4}))?(?:\s*(?:в|к|до)?\s*(?<hour>\d{1,2})(?::(?<minute>\d{2}))?)?/i);
  if (explicitDate?.groups) {
    const date = new Date(now.getTime());
    const year = explicitDate.groups.year ? Number(explicitDate.groups.year) : now.getFullYear();
    date.setFullYear(year < 100 ? 2000 + year : year);
    date.setMonth(Number(explicitDate.groups.month) - 1);
    date.setDate(Number(explicitDate.groups.day));
    date.setHours(normalizeHour(explicitDate.groups.hour, 9), normalizeHour(explicitDate.groups.minute, 0), 0, 0);
    return date.toISOString();
  }

  const textMonth = sourceText.match(/\b(?<day>\d{1,2})\s+(?<month>[а-я]+)(?:\s*(?:в|к|до)?\s*(?<hour>\d{1,2})(?::(?<minute>\d{2}))?)?/i);
  if (textMonth?.groups) {
    const monthIndex = MONTH_MAP.get(textMonth.groups.month.toLowerCase());
    if (monthIndex !== undefined) {
      return buildDateFromParts(
        now,
        Number(textMonth.groups.day),
        monthIndex,
        normalizeHour(textMonth.groups.hour, 9),
        normalizeHour(textMonth.groups.minute, 0),
      );
    }
  }

  if (lowered.includes('сегодня')) {
    const date = new Date(now.getTime());
    const timeMatch = sourceText.match(/\b(?:до|к|в)\s*(?<hour>\d{1,2})(?::(?<minute>\d{2}))?/i);
    date.setHours(normalizeHour(timeMatch?.groups?.hour, 16), normalizeHour(timeMatch?.groups?.minute, 0), 0, 0);
    return date.toISOString();
  }

  if (lowered.includes('завтра')) {
    const date = new Date(now.getTime() + 24 * 3_600_000);
    if (lowered.includes('утром')) {
      date.setHours(9, 0, 0, 0);
    } else {
      const timeMatch = sourceText.match(/\b(?:до|к|в)\s*(?<hour>\d{1,2})(?::(?<minute>\d{2}))?/i);
      date.setHours(normalizeHour(timeMatch?.groups?.hour, 10), normalizeHour(timeMatch?.groups?.minute, 0), 0, 0);
    }
    return date.toISOString();
  }

  if (lowered.includes('послезавтра')) {
    const date = new Date(now.getTime() + 48 * 3_600_000);
    date.setHours(10, 0, 0, 0);
    return date.toISOString();
  }

  return null;
}

function parseDurationHint(text) {
  const sourceText = cleanText(text).toLowerCase();
  const daysMatch = sourceText.match(/\bна\s+(?<days>\d{1,3})\s*(?:дн|дня|дней|суток)\b/i);
  if (daysMatch?.groups?.days) {
    return Number(daysMatch.groups.days);
  }

  if (/\bна\s+недел/i.test(sourceText)) return 7;
  if (/\bна\s+2\s+недел/i.test(sourceText)) return 14;
  if (/\bна\s+месяц\b/i.test(sourceText)) return 30;
  if (/\bдлительно\b/i.test(sourceText)) return 30;
  return null;
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

function detectLabeledEntity(sourceText, regex, normalizer) {
  const match = findMatch(sourceText, regex);
  return match?.value ? normalizer(match.value) : null;
}

function detectCompany(sourceText) {
  const labeled = detectLabeledEntity(
    sourceText,
    /(?:клиент|компания|заказчик)\s*[:\-]\s*(?<value>[^\n,;.]+)/i,
    normalizeCompanyName,
  );
  if (labeled) {
    return labeled;
  }

  const explicit = sourceText.match(/\b(?<value>(?:ООО|АО|ПАО|ЗАО|ИП)\s+[«"][^"»]+[»"]|(?:ООО|АО|ПАО|ЗАО|ИП)\s+[A-Za-zА-Яа-я0-9 _-]{2,60})/i);
  return explicit?.groups?.value ? normalizeCompanyName(explicit.groups.value) : null;
}

function detectPerson(sourceText) {
  const labeled = detectLabeledEntity(
    sourceText,
    /(?:контакт|прораб|лпр|менеджер|директор)\s*[:\-]\s*(?<value>[^\n,;.]+)/i,
    normalizePersonName,
  );
  if (labeled) {
    return labeled;
  }

  const byPromise = sourceText.match(/\b(?:с\s+кем|кому|отправить|перезвонить)\s+(?<value>[А-ЯЁ][а-яё]+(?:\s+[А-ЯЁ][а-яё]+){0,2})/);
  return byPromise?.groups?.value ? normalizePersonName(byPromise.groups.value) : null;
}

function detectObject(sourceText) {
  const labeled = detectLabeledEntity(
    sourceText,
    /(?:объект|площадка|стройка)\s*[:\-]\s*(?<value>[^\n;.]+)/i,
    normalizeObjectName,
  );
  if (labeled) {
    return labeled;
  }

  const sentence = splitSentences(sourceText).find((item) => {
    const lowered = item.toLowerCase();
    return OBJECT_KEYWORDS.some((keyword) => lowered.includes(keyword));
  });

  return sentence ? normalizeObjectName(sentence.replace(/^(на|по)\s+/i, '')) : null;
}

function detectAddress(sourceText) {
  const labeled = detectLabeledEntity(
    sourceText,
    /(?:адрес|локация|место)\s*[:\-]\s*(?<value>[^\n;.]+)/i,
    normalizeAddress,
  );
  if (labeled) {
    return labeled;
  }

  const inline = sourceText.match(/\b(?<value>(?:ул\.?|улица|пр-т|проспект|шоссе|д\.?|дом)\s+[^\n,;]+)/i);
  return inline?.groups?.value ? normalizeAddress(inline.groups.value) : null;
}

function detectEquipment(sourceText) {
  const labeled = detectLabeledEntity(
    sourceText,
    /(?:техника|нужно|требуется|нужен|нужна|нужны)\s*[:\-]?\s*(?<value>[^\n;.]+)/i,
    normalizeEquipmentType,
  );
  if (labeled) {
    return labeled;
  }

  const inline = sourceText.match(/\b(?<value>(?:автокран|кран|экскаватор|миниэкскаватор|манипулятор|автовышка|погрузчик|бульдозер)[^,.;\n]*)/i);
  return inline?.groups?.value ? normalizeEquipmentType(inline.groups.value) : null;
}

function detectNextStep(sourceText) {
  const sentences = splitSentences(sourceText);
  const labeled = findMatch(
    sourceText,
    /(?:следующ(?:ий|ее)\s+шаг|follow-up|дальше|обещал(?:и)?)\s*[:\-]\s*(?<value>[^\n;.]+)/i,
  );
  const fallbackSentence = sentenceAfterKeyword(sentences, NEXT_STEP_MARKERS.map(([label]) => label));
  const rawValue = cleanText(labeled?.value ?? fallbackSentence);
  const matchedAction = NEXT_STEP_MARKERS.find(([label]) => rawValue.toLowerCase().includes(label));

  return {
    raw_value: rawValue || null,
    action_code: matchedAction?.[1] ?? null,
    due_at: parseDateHint(rawValue || sourceText),
  };
}

function detectManagerPromise(sourceText) {
  const sentences = splitSentences(sourceText);
  const promiseSentence = sentenceAfterKeyword(sentences, ['обещал', 'обещали', 'сказал что', 'должен отправить', 'должен выслать']);
  if (!promiseSentence) {
    return null;
  }

  return {
    raw_value: promiseSentence,
    due_at: parseDateHint(promiseSentence),
  };
}

function detectRequestedStartAt(sourceText) {
  const sentences = splitSentences(sourceText);
  const scheduleSentence = sentenceAfterKeyword(sentences, [
    'мобилизац',
    'заезд',
    'выход',
    'подача',
    'начало работ',
    'нужен на объект',
    'нужна на объект',
    'нужны на объект',
  ]);

  if (!scheduleSentence) {
    return null;
  }

  return parseDateHint(scheduleSentence);
}

function detectNoise(sourceText) {
  const lowered = sourceText.toLowerCase();
  const matchedMarkers = SYSTEM_NOISE_MARKERS.filter((marker) => lowered.includes(marker));
  if (matchedMarkers.length >= 2) {
    return {
      is_noise: true,
      reason: 'system_priority_annotation',
      markers: matchedMarkers,
    };
  }

  if (/^комментарий сделки\s+\d+$/i.test(sourceText.trim())) {
    return {
      is_noise: true,
      reason: 'generic_subject_only',
      markers: ['комментарий сделки'],
    };
  }

  return {
    is_noise: false,
    reason: null,
    markers: [],
  };
}

export function extractEntitiesFromText(text) {
  const sourceText = cleanText(text);
  const nextStep = detectNextStep(sourceText);
  const managerPromise = detectManagerPromise(sourceText);
  const requestedStartAt = detectRequestedStartAt(sourceText);
  const requestedDurationDays = parseDurationHint(sourceText);
  const noise = detectNoise(sourceText);

  return {
    company: detectCompany(sourceText),
    person: detectPerson(sourceText),
    project_object: detectObject(sourceText),
    address: detectAddress(sourceText),
    equipment_type: detectEquipment(sourceText),
    urgency: detectUrgency(sourceText),
    money_readiness: detectMoneyReadiness(sourceText),
    competitor: detectCompetitor(sourceText),
    supply_mode: detectSupplyMode(sourceText),
    next_touch_hint: nextStep.raw_value,
    next_touch_action_code: nextStep.action_code,
    next_touch_due_at: nextStep.due_at,
    manager_promise: managerPromise,
    requested_start_at: requestedStartAt,
    requested_duration_days: requestedDurationDays,
    is_noise: noise.is_noise,
    noise_reason: noise.reason,
    noise_markers: noise.markers,
    extracted_at: new Date().toISOString(),
  };
}
