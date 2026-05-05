import 'dotenv/config';

import { adaptBitrixWebhookPayload } from './bitrix-webhook-adapter.mjs';
import { bitrixGetByIds, bitrixList } from './services/bitrix-client.mjs';
import { PostgresOpportunityRepository } from './repositories/postgres-opportunity-repository.mjs';

const DEAL_LIMIT = Number(process.env.BITRIX_IMPORT_LIMIT || 200);
const ACTIVITY_LIMIT_PER_DEAL = Number(process.env.BITRIX_ACTIVITY_LIMIT_PER_DEAL || 10);
const TIMELINE_COMMENT_LIMIT_PER_DEAL = Number(process.env.BITRIX_TIMELINE_COMMENT_LIMIT_PER_DEAL || 10);

function dealToWebhookPayload(deal) {
  return adaptBitrixWebhookPayload({
    event: 'ONCRMDEALUPDATE',
    ts: Date.now(),
    data: { FIELDS: deal },
  });
}

function companyToWebhookPayload(company) {
  return adaptBitrixWebhookPayload({
    event: 'ONCRMCOMPANYUPDATE',
    ts: Date.now(),
    data: { FIELDS: company },
  });
}

function contactToWebhookPayload(contact) {
  return adaptBitrixWebhookPayload({
    event: 'ONCRMCONTACTUPDATE',
    ts: Date.now(),
    data: { FIELDS: contact },
  });
}

function userToPseudoContactPayload(user) {
  return adaptBitrixWebhookPayload({
    event: 'ONCRMCONTACTUPDATE',
    ts: Date.now(),
    data: {
      FIELDS: {
        ID: `bitrix-user-${user.ID}`,
        FULL_NAME: [user.NAME, user.LAST_NAME].filter(Boolean).join(' ').trim() || user.NAME || `Пользователь ${user.ID}`,
        POST: user.WORK_POSITION ?? user.UF_DEPARTMENT_NAME ?? 'Менеджер',
        ROLE: 'bitrix_user',
        PHONE: user.PERSONAL_MOBILE ?? user.WORK_PHONE ?? undefined,
      },
    },
  });
}

function dealCommentToWebhookPayload(deal) {
  if (!deal.COMMENTS) {
    return null;
  }

  return adaptBitrixWebhookPayload({
    event: 'ONCRMACTIVITYADD',
    ts: Date.now(),
    data: {
      FIELDS: {
        ID: `deal-comment-${deal.ID}`,
        OWNER_TYPE_ID: 'DEAL',
        OWNER_ID: String(deal.ID),
        COMPANY_ID: deal.COMPANY_ID ? String(deal.COMPANY_ID) : undefined,
        CONTACT_ID: deal.CONTACT_ID ? String(deal.CONTACT_ID) : undefined,
        SUBJECT: `Комментарий сделки ${deal.ID}`,
        DESCRIPTION: deal.COMMENTS,
        CREATED: deal.DATE_MODIFY ?? new Date().toISOString(),
        AUTHOR_ID: deal.ASSIGNED_BY_ID ? String(deal.ASSIGNED_BY_ID) : undefined,
        AUTHOR_NAME: deal.ASSIGNED_BY_NAME ?? undefined,
      },
    },
  });
}

function activityToWebhookPayload(activity, dealById, userById) {
  const ownerId = String(activity.OWNER_ID ?? activity.DEAL_ID ?? '');
  const relatedDeal = dealById.get(ownerId);
  const author = userById.get(String(activity.AUTHOR_ID ?? activity.RESPONSIBLE_ID ?? ''));
  const authorName = author?.FULL_NAME || [author?.NAME, author?.LAST_NAME].filter(Boolean).join(' ').trim() || undefined;

  return adaptBitrixWebhookPayload({
    event: 'ONCRMACTIVITYADD',
    ts: Date.now(),
    data: {
      FIELDS: {
        ...activity,
        OWNER_TYPE_ID: activity.OWNER_TYPE_ID ?? '2',
        OWNER_ID: ownerId || activity.OWNER_ID,
        COMPANY_ID: activity.COMPANY_ID ?? relatedDeal?.COMPANY_ID ?? undefined,
        CONTACT_ID: activity.CONTACT_ID ?? relatedDeal?.CONTACT_ID ?? undefined,
        AUTHOR_NAME: authorName,
      },
    },
  });
}

function timelineCommentToWebhookPayload(comment, dealById, userById) {
  const entityId = String(comment.ENTITY_ID ?? comment.OWNER_ID ?? '');
  const relatedDeal = dealById.get(entityId);
  const author = userById.get(String(comment.AUTHOR_ID ?? ''));
  const authorName = author?.FULL_NAME || [author?.NAME, author?.LAST_NAME].filter(Boolean).join(' ').trim() || undefined;

  return adaptBitrixWebhookPayload({
    event: 'ONCRMTIMELINECOMMENTADD',
    ts: Date.now(),
    data: {
      FIELDS: {
        ID: `timeline-comment-${comment.ID}`,
        DEAL_ID: entityId || undefined,
        OWNER_TYPE_ID: 'DEAL',
        OWNER_ID: entityId || undefined,
        COMPANY_ID: relatedDeal?.COMPANY_ID ? String(relatedDeal.COMPANY_ID) : undefined,
        CONTACT_ID: relatedDeal?.CONTACT_ID ? String(relatedDeal.CONTACT_ID) : undefined,
        COMMENT: comment.COMMENT,
        CREATED: comment.CREATED ?? new Date().toISOString(),
        AUTHOR_ID: comment.AUTHOR_ID ?? undefined,
        AUTHOR_NAME: authorName,
      },
    },
  });
}

async function fetchDealActivities(deals) {
  const dealById = new Map(deals.map((deal) => [String(deal.ID), deal]));
  const activityGroups = await Promise.all(deals.map(async (deal) => {
    try {
      return await bitrixList('crm.activity.list', {
        select: ['*'],
        filter: {
          OWNER_TYPE_ID: 2,
          OWNER_ID: String(deal.ID),
        },
        limit: ACTIVITY_LIMIT_PER_DEAL,
      });
    } catch (error) {
      return [];
    }
  }));

  const activities = activityGroups
    .flat()
    .filter((item) => item && (item.DESCRIPTION || item.SUBJECT));

  return {
    dealById,
    activities,
  };
}

async function fetchDealTimelineComments(deals) {
  const dealById = new Map(deals.map((deal) => [String(deal.ID), deal]));
  const commentGroups = await Promise.all(deals.map(async (deal) => {
    try {
      return await bitrixList('crm.timeline.comment.list', {
        select: [],
        filter: {
          ENTITY_ID: String(deal.ID),
          ENTITY_TYPE: 'deal',
        },
        limit: TIMELINE_COMMENT_LIMIT_PER_DEAL,
      });
    } catch {
      return [];
    }
  }));

  const comments = commentGroups
    .flat()
    .filter((item) => item && item.COMMENT);

  return {
    dealById,
    comments,
  };
}

async function main() {
  const repository = new PostgresOpportunityRepository();

  const deals = await bitrixList('crm.deal.list', {
    select: ['*', 'UF_*'],
    limit: DEAL_LIMIT,
  });

  const companyIds = deals.map((deal) => deal.COMPANY_ID).filter(Boolean);
  const contactIds = deals.map((deal) => deal.CONTACT_ID).filter(Boolean);
  const [{ dealById, activities }, { comments: timelineComments }] = await Promise.all([
    fetchDealActivities(deals),
    fetchDealTimelineComments(deals),
  ]);

  const assignedUserIds = deals.map((deal) => deal.ASSIGNED_BY_ID).filter(Boolean).map(String);
  const authorUserIds = [
    ...activities.map((item) => item.AUTHOR_ID ?? item.RESPONSIBLE_ID).filter(Boolean).map(String),
    ...timelineComments.map((item) => item.AUTHOR_ID).filter(Boolean).map(String),
  ];
  const userIds = Array.from(new Set([...assignedUserIds, ...authorUserIds]));

  const [companies, contacts, users] = await Promise.all([
    bitrixGetByIds('crm.company.list', companyIds),
    bitrixGetByIds('crm.contact.list', contactIds),
    userIds.length
      ? bitrixGetByIds('user.get', userIds, { select: ['*'] })
      : Promise.resolve([]),
  ]);
  const userById = new Map(users.map((user) => [String(user.ID), {
    ...user,
    FULL_NAME: [user.NAME, user.LAST_NAME].filter(Boolean).join(' ').trim(),
  }]));

  const enrichedDeals = deals.map((deal) => ({
    ...deal,
    ASSIGNED_BY_NAME: userById.get(String(deal.ASSIGNED_BY_ID ?? ''))?.FULL_NAME ?? undefined,
  }));

  const events = [
    ...companies.map(companyToWebhookPayload),
    ...contacts.map(contactToWebhookPayload),
    ...users.map(userToPseudoContactPayload),
    ...enrichedDeals.map(dealToWebhookPayload),
    ...enrichedDeals.map(dealCommentToWebhookPayload).filter(Boolean),
    ...activities.map((activity) => activityToWebhookPayload(activity, dealById, userById)),
    ...timelineComments.map((comment) => timelineCommentToWebhookPayload(comment, dealById, userById)),
  ];

  for (const event of events) {
    await repository.saveIngestEvent(event);
  }

  const processed = await repository.processPendingIngestEvents(events.length + 10);

  console.log(JSON.stringify({
    imported_deals: deals.length,
    imported_companies: companies.length,
    imported_contacts: contacts.length,
    imported_users: users.length,
    imported_activities: activities.length,
    imported_timeline_comments: timelineComments.length,
    queued_events: events.length,
    processed_count: processed.processed_count,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
