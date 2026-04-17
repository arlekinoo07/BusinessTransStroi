export const bitrixWebhookFixtures = [
  {
    event: 'ONCRMCOMPANYUPDATE',
    ts: Date.now(),
    data: {
      FIELDS: {
        ID: '3002',
        TITLE: 'ООО Монолит Регион',
      },
    },
  },
  {
    event: 'ONCRMDEALUPDATE',
    ts: Date.now(),
    data: {
      FIELDS: {
        ID: '9100',
        TITLE: 'Манипулятор на объект Восток',
        COMPANY_ID: '3002',
        COMPANY_TITLE: 'ООО Монолит Регион',
        CONTACT_ID: '4100',
        COMMENTS: 'Объект: ТЦ Восток. Техника: манипулятор. Срочно нужен КП сегодня.',
        STAGE_ID: 'PREPARATION',
        BEGINDATE: new Date(Date.now() + 12 * 3_600_000).toISOString(),
        UF_CRM_DURATION_DAYS: '5',
        UF_CRM_OBJECT_NAME: 'ТЦ Восток',
      },
    },
  },
  {
    event: 'ONCRMACTIVITYADD',
    ts: Date.now(),
    data: {
      FIELDS: {
        ID: '7100',
        OWNER_TYPE_ID: 'DEAL',
        OWNER_ID: '9100',
        SUBJECT: 'Клиент просит договор сегодня',
        DESCRIPTION: 'Клиент готов быстро двигаться, объект подтвержден.',
        CREATED: new Date().toISOString(),
      },
    },
  },
];
