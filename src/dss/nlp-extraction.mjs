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
const DEBT_RISK_MARKERS = ['дебитор', 'дебиторка', 'просрочка', 'долг', 'не платят', 'задержка оплаты', 'лимит', 'стоп по отгрузке', 'только по предоплате'];
const DECISION_MAKER_MARKERS = ['лпр', 'директор', 'собственник', 'гендир', 'ген. директор', 'руководитель', 'главный инженер'];
const INFLUENCER_MARKERS = ['прораб', 'снабженец', 'закупки', 'механик', 'мастер', 'логист'];
const PAYMENT_READY_MARKERS = ['готовы оплатить', 'готовы к оплате', 'готовы подписать', 'ждет договор', 'ждёт договор', 'просит счет', 'просит счёт', 'нужен счет', 'нужен счёт', 'согласовали кп', 'согласовали договор', 'аванс'];
const OFFER_STAGE_MARKERS = ['просит кп', 'ждет кп', 'ждёт кп', 'коммерческое предложение', 'отправить кп', 'выслать кп'];
const CONTRACT_STAGE_MARKERS = ['просит договор', 'нужен договор', 'отправить договор', 'выслать договор', 'на согласование договор'];
const INVOICE_STAGE_MARKERS = ['просит счет', 'просит счёт', 'нужен счет', 'нужен счёт', 'выставить счет', 'выставить счёт'];
const TECH_SPEC_MARKERS = ['грузоподъем', 'грузоподъ', 'тонн', 'тн', 'вылет', 'стрела', 'высота', 'глубина', 'объем ковша', 'объём ковша', 'длина', 'смена', 'режим работы', 'график', 'габарит'];
const WORK_CONDITION_MARKERS = ['пропуск', 'ночная смена', 'круглосуточно', 'стесненные условия', 'стеснённые условия', 'заезд', 'окно', 'мобилизация', 'плечо', 'база', 'предоплата', 'безнал', 'ндс'];
const PRICE_MARKERS = ['ставка', 'цена', 'бюджет', 'маржа', 'дорого', 'дешевле', 'скидка', 'руб', 'р/смена', 'за смену'];
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

function detectDecisionAccess(sourceText) {
  const lowered = sourceText.toLowerCase();
  const decisionMarkers = DECISION_MAKER_MARKERS.filter((marker) => lowered.includes(marker));
  if (decisionMarkers.length) {
    return {
      value: 'decision_maker',
      markers: decisionMarkers,
      confidence: 0.86,
    };
  }

  const influencerMarkers = INFLUENCER_MARKERS.filter((marker) => lowered.includes(marker));
  if (influencerMarkers.length) {
    return {
      value: 'influencer',
      markers: influencerMarkers,
      confidence: 0.7,
    };
  }

  return {
    value: 'unknown',
    markers: [],
    confidence: 0.35,
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

function detectDebtRisk(text) {
  const lowered = text.toLowerCase();
  const matched = DEBT_RISK_MARKERS.filter((marker) => lowered.includes(marker));
  const prepaymentOnly = lowered.includes('предоплат');
  return {
    mentioned: matched.length > 0,
    markers: matched,
    requires_prepayment: prepaymentOnly,
    confidence: matched.length ? 0.82 : 0.25,
  };
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

  if (!sentence) {
    return null;
  }

  const cleaned = sentence.replace(/^(на|по)\s+/i, '').trim();
  const lowered = cleaned.toLowerCase();
  const genericOnly = (
    (lowered.includes('объект') || lowered.includes('площадк'))
    && !OBJECT_KEYWORDS.some((keyword) => keyword !== 'объект' && keyword !== 'площадка' && lowered.includes(keyword))
    && (lowered.includes('конкурент') || lowered.includes('уже стоит') || lowered.includes('люди конкурента'))
  );

  return genericOnly ? null : normalizeObjectName(cleaned);
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

function detectEquipmentModel(sourceText, equipmentType) {
  if (!equipmentType?.raw_value && !equipmentType?.normalized_value) {
    return null;
  }

  const labeled = findMatch(
    sourceText,
    /(?:модель|модификация)\s*[:\-]\s*(?<value>[^\n;.]+)/i,
  );
  if (labeled?.value) {
    return cleanText(labeled.value);
  }

  const typeValue = equipmentType?.raw_value ?? '';
  const sentence = splitSentences(sourceText).find((item) =>
    item.toLowerCase().includes((typeValue || '').toLowerCase())
    && /\b(?:25т|32т|50т|16т|28м|45м|jcb|liebherr|zoomlion|xcmg)\b/i.test(item));
  if (!sentence) return null;
  const match = sentence.match(/\b((?:автокран|кран|экскаватор|миниэкскаватор|манипулятор|автовышка|погрузчик|бульдозер)[^,.;\n]{0,80})/i);
  return cleanText(match?.[1] ?? sentence);
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

function detectCommercialStage(sourceText) {
  const lowered = sourceText.toLowerCase();
  if (CONTRACT_STAGE_MARKERS.some((marker) => lowered.includes(marker))) {
    return 'contract_requested';
  }

  if (INVOICE_STAGE_MARKERS.some((marker) => lowered.includes(marker))) {
    return 'invoice_requested';
  }

  if (OFFER_STAGE_MARKERS.some((marker) => lowered.includes(marker))) {
    return 'offer_requested';
  }

  return 'qualified';
}

function detectPriceContext(sourceText) {
  const sentences = splitSentences(sourceText);
  const matched = sentences.filter((sentence) => {
    const lowered = sentence.toLowerCase();
    return PRICE_MARKERS.some((marker) => lowered.includes(marker)) || /\b\d[\d\s]{2,}\s*(?:руб|₽)\b/i.test(sentence);
  });

  return {
    raw_value: matched[0] ?? null,
    markers: matched.slice(0, 4),
    confidence: matched.length ? 0.76 : 0.28,
  };
}

function detectWorkConditions(sourceText) {
  const sentences = splitSentences(sourceText);
  const matched = sentences.filter((sentence) => {
    const lowered = sentence.toLowerCase();
    return WORK_CONDITION_MARKERS.some((marker) => lowered.includes(marker));
  });
  return Array.from(new Set(matched.map((item) => cleanText(item)).filter(Boolean))).slice(0, 6);
}

function detectClientExpectedNextStep(sourceText) {
  const sentences = splitSentences(sourceText);
  const sentence = sentenceAfterKeyword(sentences, [
    'ждет',
    'ждёт',
    'ожидает',
    'просит',
    'нужен договор',
    'нужен счет',
    'нужен счёт',
    'подтвердить',
  ]);
  return sentence ? cleanText(sentence) : null;
}

function detectReadinessSignals(sourceText) {
  const lowered = sourceText.toLowerCase();
  return {
    contract_ready: CONTRACT_STAGE_MARKERS.some((marker) => lowered.includes(marker)),
    payment_ready: PAYMENT_READY_MARKERS.some((marker) => lowered.includes(marker)),
    urgency_high: URGENCY_MARKERS.some((marker) => lowered.includes(marker)),
  };
}

function detectGeoHint(sourceText, address) {
  if (address?.normalized_value) {
    return {
      raw_value: address.raw_value,
      normalized_value: address.normalized_value,
      confidence: address.confidence_score ?? 0.8,
    };
  }
  return null;
}

function detectPaymentReadiness(sourceText) {
  const lowered = sourceText.toLowerCase();
  if (PAYMENT_READY_MARKERS.some((marker) => lowered.includes(marker))) {
    return 'ready';
  }

  if (MONEY_MARKERS.some((marker) => lowered.includes(marker))) {
    return 'commercial';
  }

  return 'early';
}

function detectTechnicalRequirements(sourceText) {
  const sentences = splitSentences(sourceText);
  const collected = sentences.filter((sentence) => {
    const lowered = sentence.toLowerCase();
    return TECH_SPEC_MARKERS.some((marker) => lowered.includes(marker))
      || /\b\d+\s*(?:т|тонн|м|метр|метров|час|смен)\b/i.test(sentence);
  });

  return Array.from(new Set(collected.map((item) => cleanText(item)).filter(Boolean))).slice(0, 6);
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
  const decisionAccess = detectDecisionAccess(sourceText);
  const commercialStage = detectCommercialStage(sourceText);
  const paymentReadiness = detectPaymentReadiness(sourceText);
  const technicalRequirements = detectTechnicalRequirements(sourceText);
  const company = detectCompany(sourceText);
  const person = detectPerson(sourceText);
  const projectObject = detectObject(sourceText);
  const address = detectAddress(sourceText);
  const equipmentType = detectEquipment(sourceText);
  const priceContext = detectPriceContext(sourceText);
  const workConditions = detectWorkConditions(sourceText);
  const readinessSignals = detectReadinessSignals(sourceText);

  return {
    company,
    person,
    project_object: projectObject,
    address,
    geo_hint: detectGeoHint(sourceText, address),
    equipment_type: equipmentType,
    equipment_model: detectEquipmentModel(sourceText, equipmentType),
    urgency: detectUrgency(sourceText),
    money_readiness: detectMoneyReadiness(sourceText),
    decision_access: decisionAccess,
    competitor: detectCompetitor(sourceText),
    supply_mode: detectSupplyMode(sourceText),
    debt_risk: detectDebtRisk(sourceText),
    commercial_stage: commercialStage,
    payment_readiness: paymentReadiness,
    technical_requirements: technicalRequirements,
    work_conditions: workConditions,
    price_context: priceContext,
    client_expected_next_step: detectClientExpectedNextStep(sourceText),
    readiness_signals: readinessSignals,
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
