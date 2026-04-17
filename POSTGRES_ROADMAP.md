# PostgreSQL Roadmap

В проект добавлена начальная SQL-схема: [db/schema.sql](/Users/arlekinoo07/Documents/New%20project/db/schema.sql)

## Что это покрывает

- операционный контур `companies / persons / project_objects / opportunities`
- журнал событий `ingest_events`
- слой коммуникаций `communication_events`
- слой нормализации `normalization_results`
- снимки состояний `state_snapshots`
- рекомендации и обратную связь `recommendations / recommendation_feedback`

## Как переносить текущий in-memory v1 на PostgreSQL

1. Установить зависимости через `npm install`, чтобы подтянулся `pg`.
2. Выполнить `npm run db:init`.
3. Выполнить `npm run db:seed`.
4. Проверить API уже на `PostgreSQL`, а не на in-memory store.
5. На каждой пересборке состояния писать:
   - score-поля обратно в `opportunities`
   - детальные состояния в `state_snapshots`
6. На каждой выдаче рекомендации писать:
   - запись в `recommendations`
   - переход статусов по мере `shown / accepted / rejected / executed`

## Что важно не потерять

- `Opportunity Unit` остается внутренней агрегированной моделью, даже если данные лежат в нескольких таблицах
- движки `state-engine` и `decision-engine` не должны знать о SQL
- explainability нужно хранить как `JSONB`, а не расплющивать по десяткам колонок
