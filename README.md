# AI Sales Decision Engine / BTS DSS

Репозиторий теперь содержит два слоя:

- `Bitrix24 -> Qdrant sync` для индексации CRM-данных
- `Decision Support System v1` для оценки Opportunity Unit, вычисления состояний и выдачи следующего действия

## Подготовка

1. Установите зависимости:

```bash
npm install
```

2. Заполните переменные окружения:

```bash
cp .env.example .env
```

Нужны как минимум:

- `QDRANT_URL`
- `BITRIX24_WEBHOOK_URL` уже заполнен вашим webhook
- для live-контура также понадобятся `DATABASE_URL` и `NEO4J_URI/NEO4J_USERNAME/NEO4J_PASSWORD`

`QDRANT_API_KEY` нужен только если ваш Qdrant защищен ключом.

## Production Stack

Для локального или серверного live-контура теперь есть [docker-compose.yml](/Users/arlekinoo07/Documents/New%20project/docker-compose.yml):

```bash
docker compose up -d
```

Это поднимет:

- `PostgreSQL`
- `Qdrant`
- `Neo4j`

Базовая связка env для такого запуска уже добавлена в `.env.example`.

После старта live-контура рекомендуемый порядок такой:

```bash
npm run db:init
npm run db:seed
npm run sync:postgres
npm run sync:qdrant:dss
npm run sync:neo4j:dss
npm run serve
```

Если нужен быстрый health-check по live-контуру:

```bash
curl http://127.0.0.1:3000/system/status
curl http://127.0.0.1:3000/graph/status
curl http://127.0.0.1:3000/vectors/status
```

## Запуск sync в Qdrant

```bash
npm run sync
```

По умолчанию создается коллекция `bitrix24_records`, если ее еще нет.

## Запуск DSS API v1

```bash
npm run serve
```

Веб-интерфейс `v1` доступен по адресу:

- `GET /`
- `GET /app`

После старта доступны:

- `GET /health`
- `GET /meta/contracts`
- `GET /events/bitrix/pending`
- `GET /events/bitrix/errors`
- `POST /nlp/extract`
- `POST /events/bitrix`
- `POST /events/bitrix/process`
- `GET /dashboard/manager/queue`
- `GET /dashboard/rop/escalations`
- `GET /dashboard/data-quality`
- `GET /opportunities/opp-1001/state`
- `GET /opportunities/opp-1001/state-history`
- `GET /opportunities/opp-1001/decision`
- `GET /opportunities/opp-1001/card`
- `GET /opportunities/opp-1001/graph`
- `GET /opportunities/opp-1001/recommendations`
- `GET /dashboard/manager`

## Демонстрация движка решений

```bash
npm run demo:decision
```

Проверка ingest-контура без поднятия сервера:

```bash
npm run smoke:ingest
```

Проверка webhook-адаптера под типовой payload Bitrix24:

```bash
npm run smoke:webhook
```

Быстрый чек уже сделанного:

```bash
npm run smoke:api
npm run smoke:ingest
npm run smoke:webhook
```

Что должно считаться успешной проверкой:

- `smoke:api` показывает `card_has_recommendation: true`
- `smoke:api` показывает `card_graph_nodes` больше `0`
- `smoke:api` показывает `card_similar_cases` больше `0`
- `smoke:webhook` показывает `webhook_opportunity_found: true`
- `smoke:ingest` показывает `processed_count > 0`

Ручная проверка в UI:

1. Запустить `npm run serve`
2. Открыть [http://127.0.0.1:3000/app](http://127.0.0.1:3000/app)
3. Проверить:
   - manager queue заполнена
   - карточка сделки открывается
   - кнопки `Принять / Отклонить / Выполнено` меняют статус рекомендации
   - есть блок `ROP / Escalations`
   - есть блок `Data Quality`
   - в карточке есть `Similar Cases`
   - в карточке есть `Graph View`

## PostgreSQL

Если хотите переключить API с in-memory данных на реальный `PostgreSQL`, заполните `DATABASE_URL` и выполните:

```bash
npm install
npm run db:init
npm run db:seed
```

После этого `src/repositories/opportunity-repository.mjs` автоматически выберет `PostgreSQL`-репозиторий вместо in-memory.

## Живые данные Bitrix24 -> PostgreSQL

Если `PostgreSQL` поднят и `BITRIX24_WEBHOOK_URL` заполнен, можно загрузить тестовые сделки Bitrix в текущую модель DSS:

```bash
npm run db:init
npm run sync:postgres
```

По умолчанию импортируется до `200` сделок. Лимит можно переопределить:

```bash
BITRIX_IMPORT_LIMIT=50 npm run sync:postgres
```

## Документация

- [PRIORITY_SCORING.md](/Users/arlekinoo07/Documents/New%20project/PRIORITY_SCORING.md)
- [DSS_MVP.md](/Users/arlekinoo07/Documents/New%20project/DSS_MVP.md)
- [POSTGRES_ROADMAP.md](/Users/arlekinoo07/Documents/New%20project/POSTGRES_ROADMAP.md)
- [db/schema.sql](/Users/arlekinoo07/Documents/New%20project/db/schema.sql)
