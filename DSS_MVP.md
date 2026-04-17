# AI Sales Decision Engine MVP

Этот репозиторий начал переход от точечного Bitrix24/Qdrant sync к `Decision Support System` для продаж спецтехники.

## Что уже заложено в v1

- `src/dss/normalization.mjs`
  нормализация компаний, объектов, адресов, контактов и типов техники с полями `raw_value / normalized_value / confidence_score / resolved_entity_id`
- `src/dss/nlp-extraction.mjs`
  эвристическое извлечение сущностей и сигналов из текстовых коммуникаций
- `src/dss/state-engine.mjs`
  расчет шести индексов `Need / Time / Spec / Access / Money / Fit`, `PriorityScore` и S3-состояний
- `src/dss/decision-engine.mjs`
  rule-based выбор действия и explainability блока
- `src/server.mjs`
  HTTP API-скелет под контракты из ТЗ
- `src/dss/contracts.mjs`
  формальные контракты ключевых JSON-сущностей
- `db/schema.sql`
  базовая SQL-схема операционного контура под PostgreSQL

## Реализованные эндпоинты v1

- `GET /health`
- `GET /meta/contracts`
- `POST /events/bitrix`
- `GET /events/bitrix/pending`
- `GET /events/bitrix/errors`
- `POST /events/bitrix/process`
- `POST /nlp/extract`
- `GET /opportunities/{id}`
- `GET /opportunities/{id}/state`
- `GET /opportunities/{id}/state-history`
- `GET /opportunities/{id}/decision`
- `GET /opportunities/{id}/card`
- `GET /opportunities/{id}/graph`
- `GET /opportunities/{id}/recommendations`
- `GET /dashboard/manager/queue`
- `GET /dashboard/rop/escalations`
- `GET /dashboard/data-quality`
- `GET /dashboard/manager`
- `GET /dashboard/rop`
- `GET /objects/{id}/graph`
- `POST /actions/{id}/feedback`

## Что это дает уже сейчас

- можно прогонять коммуникационный текст через extraction
- можно считать состояние Opportunity Unit
- можно получать рекомендацию следующего действия
- можно проверить, как будут выглядеть manager/ROP dashboards

## Что следующим этапом

1. Подключить `PostgreSQL` и вынести `opportunityStore` из памяти в реальные таблицы.
2. Подключить ingest из `Bitrix24` к журналу событий и повторной обработке.
3. Добавить Qdrant-поиск похожих кейсов в explainability.
4. Добавить Neo4j-sync для объектов, клиентов, контактов и конкурентов.
5. Заменить эвристический extraction на LLM/NLP pipeline с confidence и review queue.
