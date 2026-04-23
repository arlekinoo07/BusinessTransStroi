import 'dotenv/config';

const {
  NEO4J_URI,
  NEO4J_USERNAME,
  NEO4J_PASSWORD,
  NEO4J_DATABASE = 'neo4j',
} = process.env;

let driverPromise;

export function hasNeo4jConfig() {
  return Boolean(NEO4J_URI && NEO4J_USERNAME && NEO4J_PASSWORD);
}

async function getDriver() {
  if (!hasNeo4jConfig()) {
    return null;
  }

  if (!driverPromise) {
    driverPromise = import('neo4j-driver')
      .then(({ default: neo4j }) => neo4j.driver(
        NEO4J_URI,
        neo4j.auth.basic(NEO4J_USERNAME, NEO4J_PASSWORD),
      ))
      .catch((error) => {
        driverPromise = null;
        throw error;
      });
  }

  return driverPromise;
}

async function withSession(mode, fn) {
  const driver = await getDriver();
  if (!driver) {
    return null;
  }

  const session = driver.session({
    database: NEO4J_DATABASE,
    defaultAccessMode: mode,
  });

  try {
    return await fn(session);
  } finally {
    await session.close();
  }
}

function makeNode(type, id, label, properties = {}) {
  return { type, id, label, properties };
}

function makeEdge(source, target, type, properties = {}) {
  return { source, target, type, properties };
}

function sanitizeNeo4jProperties(properties = {}) {
  const result = {};

  for (const [key, value] of Object.entries(properties)) {
    if (value === undefined || value === null) {
      continue;
    }

    if (['string', 'number', 'boolean'].includes(typeof value)) {
      result[key] = value;
      continue;
    }

    if (Array.isArray(value) && value.every((item) => ['string', 'number', 'boolean'].includes(typeof item))) {
      result[key] = value;
    }
  }

  return result;
}

function buildGraphRecordsFromOpportunity(opportunity) {
  const nodes = [];
  const edges = [];

  const opportunityId = `Opportunity:${opportunity.id}`;
  nodes.push(makeNode('Opportunity', opportunityId, opportunity.bitrix_deal_id ?? opportunity.id, {
    bitrix_deal_id: opportunity.bitrix_deal_id ?? null,
    commercial_stage: opportunity.commercial_stage ?? null,
    priority_score: opportunity.priority_score ?? null,
  }));

  let companyId = null;
  if (opportunity.company?.raw_value) {
    companyId = `Company:${opportunity.company.normalized_value ?? opportunity.company.raw_value}`;
    nodes.push(makeNode('Company', companyId, opportunity.company.raw_value, {
      normalized_name: opportunity.company.normalized_value ?? null,
    }));
    edges.push(makeEdge(opportunityId, companyId, 'FOR_COMPANY'));
  }

  let personId = null;
  if (opportunity.contact_person?.raw_value) {
    personId = `Person:${opportunity.contact_person.normalized_value ?? opportunity.contact_person.raw_value}`;
    nodes.push(makeNode('Person', personId, opportunity.contact_person.raw_value, {
      role: opportunity.contact_person.role ?? null,
    }));
    edges.push(makeEdge(opportunityId, personId, 'ASSIGNED_TO'));
    if (companyId) {
      edges.push(makeEdge(personId, companyId, 'WORKS_FOR'));
    }
  }

  let objectId = null;
  if (opportunity.project_object?.raw_value) {
    objectId = `ProjectObject:${opportunity.project_object.normalized_value ?? opportunity.project_object.raw_value}`;
    nodes.push(makeNode('ProjectObject', objectId, opportunity.project_object.raw_value, {
      normalized_name: opportunity.project_object.normalized_value ?? null,
    }));
    edges.push(makeEdge(opportunityId, objectId, 'FOR_OBJECT'));
  }

  let equipmentId = null;
  if (opportunity.equipment_type?.normalized_value || opportunity.equipment_type?.raw_value) {
    const equipmentLabel = opportunity.equipment_type.normalized_value ?? opportunity.equipment_type.raw_value;
    equipmentId = `EquipmentType:${equipmentLabel}`;
    nodes.push(makeNode('EquipmentType', equipmentId, equipmentLabel, {}));
    edges.push(makeEdge(opportunityId, equipmentId, 'NEEDS'));
    if (objectId) {
      edges.push(makeEdge(objectId, equipmentId, 'USES'));
    }
  }

  if (opportunity.graph_signals?.competitor_present && objectId) {
    const competitorId = `Competitor:${opportunity.id}`;
    nodes.push(makeNode('Competitor', competitorId, 'Конкурент на объекте', {}));
    edges.push(makeEdge(objectId, competitorId, 'HAS_COMPETITOR'));
    if (equipmentId) {
      edges.push(makeEdge(competitorId, equipmentId, 'SUPPLIES'));
    }
  }

  if (opportunity.graph_signals?.cross_sell_open) {
    const scenarioId = `Scenario:${opportunity.id}`;
    nodes.push(makeNode('Scenario', scenarioId, 'Кросс-продажа', {}));
    edges.push(makeEdge(opportunityId, scenarioId, 'CROSS_SELL_OPEN'));
  }

  for (const event of (opportunity.communication_events ?? []).slice(0, 5)) {
    const eventId = `CommunicationEvent:${event.id ?? `${opportunity.id}:${event.datetime ?? ''}`}`;
    nodes.push(makeNode('CommunicationEvent', eventId, event.summary ?? event.type ?? 'Event', {
      channel: event.channel ?? null,
      datetime: event.datetime ?? null,
    }));
    edges.push(makeEdge(opportunityId, eventId, 'HAS_EVENT'));
  }

  return {
    nodes: Array.from(new Map(nodes.map((node) => [node.id, node])).values()),
    edges: Array.from(new Map(edges.map((edge) => [`${edge.source}:${edge.target}:${edge.type}`, edge])).values()),
  };
}

async function syncOpportunity(session, opportunity) {
  const graph = buildGraphRecordsFromOpportunity(opportunity);

  for (const node of graph.nodes) {
    const properties = sanitizeNeo4jProperties(node.properties);
    await session.run(
      `
        MERGE (n:${node.type} {external_id: $id})
        SET n.label = $label,
            n.type = $type
        ${Object.keys(properties).length ? 'SET n += $properties' : ''}
      `,
      {
        id: node.id,
        label: node.label,
        type: node.type,
        properties,
      },
    );
  }

  for (const edge of graph.edges) {
    const properties = sanitizeNeo4jProperties(edge.properties);
    await session.run(
      `
        MATCH (a {external_id: $source}), (b {external_id: $target})
        MERGE (a)-[r:${edge.type}]->(b)
        ${Object.keys(properties).length ? 'SET r += $properties' : ''}
      `,
      {
        source: edge.source,
        target: edge.target,
        properties,
      },
    );
  }

  return graph;
}

function mapGraphResult(records) {
  const nodes = new Map();
  const edges = new Map();

  for (const record of records) {
    const source = record.get('source');
    const rel = record.get('rel');
    const target = record.get('target');

    for (const node of [source, target]) {
      if (!node) continue;
      const externalId = node.properties.external_id;
      nodes.set(externalId, {
        id: externalId,
        label: node.properties.label ?? externalId,
        type: Array.isArray(node.labels) ? node.labels[0] : 'Node',
      });
    }

    if (source && rel && target) {
      const key = `${source.properties.external_id}:${target.properties.external_id}:${rel.type}`;
      edges.set(key, {
        source: source.properties.external_id,
        target: target.properties.external_id,
        type: rel.type,
      });
    }
  }

  return {
    nodes: Array.from(nodes.values()),
    edges: Array.from(edges.values()),
  };
}

export async function syncRepositoryToNeo4j(repository) {
  if (!hasNeo4jConfig()) {
    return {
      enabled: false,
      reason: 'Neo4j env is not configured',
      database: NEO4J_DATABASE,
    };
  }

  const opportunities = await repository.listOpportunities();
  const result = await withSession('WRITE', async (session) => {
    for (const opportunity of opportunities) {
      await syncOpportunity(session, opportunity);
    }
    return { synced_opportunities: opportunities.length };
  });

  return {
    enabled: true,
    database: NEO4J_DATABASE,
    ...result,
  };
}

export async function getNeo4jStatus() {
  if (!hasNeo4jConfig()) {
    return {
      enabled: false,
      database: NEO4J_DATABASE,
      configured: false,
    };
  }

  try {
    const info = await withSession('READ', async (session) => {
      const probe = await session.run('RETURN 1 AS ok');
      return { ok: probe.records[0]?.get('ok') === 1 };
    });

    return {
      enabled: true,
      configured: true,
      database: NEO4J_DATABASE,
      reachable: Boolean(info?.ok),
    };
  } catch (error) {
    return {
      enabled: true,
      configured: true,
      database: NEO4J_DATABASE,
      reachable: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function getOpportunityGraphFromNeo4j(opportunityId) {
  if (!hasNeo4jConfig()) {
    return null;
  }

  return withSession('READ', async (session) => {
    const result = await session.run(
      `
        MATCH (o:Opportunity {external_id: $id})-[rel]-(target)
        RETURN o AS source, rel, target
      `,
      { id: `Opportunity:${opportunityId}` },
    );

    if (!result.records.length) {
      return null;
    }

    const mapped = mapGraphResult(result.records);
    return {
      opportunity_id: opportunityId,
      object_id: null,
      nodes: mapped.nodes,
      edges: mapped.edges,
      source: 'neo4j',
    };
  });
}

export async function getObjectGraphFromNeo4j(objectId) {
  if (!hasNeo4jConfig()) {
    return null;
  }

  const objectKeys = [
    `ProjectObject:${objectId}`,
    objectId,
  ];

  return withSession('READ', async (session) => {
    for (const key of objectKeys) {
      const result = await session.run(
        `
          MATCH (o:ProjectObject {external_id: $id})-[rel]-(target)
          RETURN o AS source, rel, target
        `,
        { id: key },
      );

      if (result.records.length) {
        const mapped = mapGraphResult(result.records);
        return {
          opportunity_id: null,
          object_id: objectId,
          nodes: mapped.nodes,
          edges: mapped.edges,
          source: 'neo4j',
        };
      }
    }

    return null;
  });
}
