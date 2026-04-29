import { listActions } from './action-library.mjs';

export const DICTIONARIES = {
  equipment_types: [
    'Автокран',
    'Экскаватор',
    'Миниэкскаватор',
    'Манипулятор',
    'Автовышка',
    'Погрузчик',
    'Бульдозер',
  ],
  equipment_models: [
    'Автокран 25т',
    'Автокран 50т',
    'Экскаватор-погрузчик',
    'Манипулятор 10т',
    'Автовышка 28м',
  ],
  own_equipment_units: [
    { registry_id: 'EQ-001', type_name: 'Автокран', model: 'Автокран 25т', own_flag: true, availability_status: 'available', region: 'Москва', base_location: 'Северная база' },
    { registry_id: 'EQ-002', type_name: 'Манипулятор', model: 'Манипулятор 10т', own_flag: true, availability_status: 'busy', region: 'МО', base_location: 'Южная база' },
    { registry_id: 'EQ-003', type_name: 'Автовышка', model: 'Автовышка 28м', own_flag: true, availability_status: 'available', region: 'Москва', base_location: 'Западная база' },
  ],
  subrent_partners: [
    { id: 'partner-1', name: 'Субрент Север', region: 'Москва', reliability: 0.82, equipment_types: ['Автокран', 'Автовышка'], shoulder_km: 18, margin_pressure: 0.12 },
    { id: 'partner-2', name: 'Монолит Партнер', region: 'МО', reliability: 0.74, equipment_types: ['Манипулятор', 'Экскаватор'], shoulder_km: 42, margin_pressure: 0.18 },
    { id: 'partner-3', name: 'Кран Резерв', region: 'Москва', reliability: 0.88, equipment_types: ['Автокран'], shoulder_km: 25, margin_pressure: 0.16 },
  ],
  competitors: [
    { id: 'competitor-1', name: 'ТехноРент', confidence_level: 0.78 },
    { id: 'competitor-2', name: 'КранЛогистик', confidence_level: 0.69 },
  ],
  object_types: ['ЖК', 'БЦ', 'ТЦ', 'ТРЦ', 'Склад', 'Завод', 'Инфраструктурный объект'],
  win_reasons: ['Быстрая реакция', 'Своя техника в наличии', 'ЛПР на связи', 'Сильная экономика сделки'],
  loss_reasons: ['Медленная реакция', 'Нет своей техники', 'Цена конкурента ниже', 'Высокий дебиторский риск'],
  contact_roles: ['ЛПР', 'Прораб', 'Снабженец', 'Механик', 'Закупки', 'Логист'],
  entity_dictionary: ['company', 'person', 'project_object', 'address', 'equipment_type', 'competitor'],
  stop_signals: ['blacklist', 'negative_margin', 'credit_blocked', 'low_confidence_extraction'],
  maturity_markers: ['просит КП', 'нужен договор', 'готов к оплате', 'мобилизация завтра', 'своя техника доступна'],
  action_library: listActions(),
};

export function getDictionariesOverview() {
  return JSON.parse(JSON.stringify(DICTIONARIES));
}
