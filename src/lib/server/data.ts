import airtable from "./airtable";
import TTLCache from "@isaacs/ttlcache";
import type { FieldSet, Record as AirtableRecord } from "airtable";
import { writeFile } from "node:fs/promises";
import { getShop } from "./shop";
import { db } from "./db";
import { shopOrdersTable } from "./db/schema";
import { eq } from "drizzle-orm";

const debugShips = false;

const createShipGroup = (ship: Ship): ShipGroup => ({
  title: ship.title,
  created: new Date(ship.createdTime),
  totalDoubloons: ship.doubloonPayout || 0,
  totalHours: ship.creditedHours || 0,
  isInYswsBase: ship.isInYswsBase,
  ships: [ship],
});

const updateShipGroup = (group: ShipGroup, ship: Ship): void => {
  group.totalHours += ship.creditedHours || 0;
  group.totalDoubloons += ship.doubloonPayout;
  group.title = ship.title;
  group.isInYswsBase = ship.isInYswsBase;
  group.ships.push(ship);
};

// Cache ships per slack user with 5-minute TTL
export const shipsCache = new TTLCache<string, ShipGroup[]>({
  max: 1000,
  ttl: 300_000,
});

export const personCache = new TTLCache({
  ttl: 1000 * 60 * 4,
});

function mapRawPerson(person: AirtableRecord<FieldSet>): Person {
  return {
    fullName: person.fields.full_name as string,
    email: person.fields.email as string,
    autonumber: person.fields.autonumber as number,
    voteBalance: person.fields.vote_balance as number,
    shipsAwaitingVoteRequirement: person.fields
      .ships_awaiting_vote_requirement as number,
    totalHoursLogged: person.fields.total_hours_logged as number,
    doubloonsBalance: person.fields.doubloons_balance as number,
    doubloonsReceived: person.fields.doubloons_received as number,
    doubloonsSpent: person.fields.doubloons_spent as number,
    averageDoubloonsPerHour: person.fields.average_doubloons_per_hour as number,
    voteCount: person.fields.vote_count as number,
    averageVoteTime: person.fields.mean_vote_time as number,
    realMoneySpent: person.fields.total_real_money_we_spent as number,
    recordId: person.id,
  };
}
export async function fetchPerson(userId: string) {
  const cachedPerson = personCache.get(userId);
  if (cachedPerson)
    return mapRawPerson(cachedPerson as AirtableRecord<FieldSet>);
  const people = await airtable("people")
    .select({
      filterByFormula: `{slack_id} = "${userId}"`,
      maxRecords: 1,
    })
    .all();

  const person = people[0];
  personCache.set(userId, person);
  console.log("fetchPerson - person not cached");
  return mapRawPerson(person);
}

export async function fetchPersonByRecordId(recordId: string, userId: string) {
  const cachedPerson = personCache.get(userId);
  if (cachedPerson)
    return mapRawPerson(cachedPerson as AirtableRecord<FieldSet>);
  const person = await airtable("people").find(recordId);
  personCache.set(userId, person);
  console.log("fetchPersonByRecordId - person not cached");
  return mapRawPerson(person);
}

export function flushCaches(userId: string) {
  shipsCache.delete(`${userId}-all`);
  personCache.delete(userId);
}

export async function fetchShips(
  slackId: string,
  maxRecords?: number
): Promise<ShipGroup[]> {
  const cacheKey = `${slackId}-${maxRecords ?? "all"}`;
  const cached = shipsCache.get(cacheKey);
  if (cached) {
    if (debugShips) {
      await writeFile("ships.json", JSON.stringify(cached, null, 2));
    }
    return cached;
  }

  const filterFormula = `AND(
    '${slackId}' = {entrant__slack_id},
    {project_source} = 'high_seas',
    {ship_status} != 'deleted'
  )`;

  const unmappedShips = await airtable("ships")
    .select({
      filterByFormula: filterFormula,
      ...(maxRecords && { maxRecords }),
    })
    .all();
  if (debugShips) {
    await writeFile("ships.json", JSON.stringify(unmappedShips, null, 2));
  }

  const shipGroups: ShipGroup[] = [];
  const shipGroupMap = new Map<string, ShipGroup>();

  // Process ships in a single pass
  for (const record of unmappedShips) {
    const fields = record.fields as Record<string, unknown>;

    const ship: Ship = {
      id: record.id,
      autonumber: fields.autonumber as number,
      title: fields.title as string,
      repoUrl: fields.repo_url as string,
      deploymentUrl: fields.deploy_url as string,
      readmeUrl: fields.readme_url as string,
      screenshotUrl: fields.screenshot_url as string,
      voteRequirementMet: Boolean(fields.vote_requirement_met),
      voteBalanceExceedsRequirement: Boolean(
        fields.vote_balance_exceeds_requirement
      ),
      matchupsCount: fields.matchups_count as number,
      doubloonPayout: fields.doubloon_payout as number,
      shipType: fields.ship_type as ShipType,
      shipStatus: fields.ship_status as ShipStatus,
      wakatimeProjectNames: ((fields.wakatime_project_name as string) ?? "")
        .split("$$xXseparatorXx$$")
        .filter(Boolean),
      hours: fields.hours as number,
      creditedHours: fields.credited_hours as number,
      totalHours: fields.total_hours as number,
      createdTime: fields.created_time as string,
      updateDescription: fields.update_description as string | null,
      reshippedFromId: (fields.reshipped_from as string[])?.[0] ?? null,
      reshippedToId: (fields.reshipped_to as string[])?.[0] ?? null,
      reshippedAll: fields.reshipped_all as string[] | null,
      reshippedFromAll: fields.reshipped_from_all as string[] | null,
      paidOut: Boolean(fields.paid_out),
      yswsType: fields.yswsType as YswsType,
      feedback: fields.ai_feedback_summary as string | null,
      isInYswsBase: Boolean(fields.has_ysws_submission_id),
    };

    if (!ship.reshippedFromId) {
      const group = createShipGroup(ship);
      shipGroups.push(group);
      shipGroupMap.set(ship.id, group);
      continue;
    }

    const parentGroup = shipGroupMap.get(ship.reshippedFromId);
    if (parentGroup) {
      updateShipGroup(parentGroup, ship);
      shipGroupMap.set(ship.id, parentGroup);
    }
  }

  const finalGroups = shipGroups
    .map((group) => ({
      ...group,
      totalDoubloons: group.totalDoubloons * (group.isInYswsBase ? 1.1 : 1),
    }))
    .sort((a, b) => +new Date(b.created) - +new Date(a.created));

  // Update cache
  shipsCache.set(cacheKey, finalGroups);

  return finalGroups;
}

interface Order {
  name: string;
  doubloonsPaid: number;
  dollarCost: number;
  imageUrl?: string;
}

export async function getUserShopOrders(userId: string): Promise<Order[]> {
  const start = performance.now();

  const cachedOrders = await db
    .select()
    .from(shopOrdersTable)
    .where(eq(shopOrdersTable.userId, userId));
  if (cachedOrders.length > 0) {
    const orders = JSON.parse(cachedOrders[0].json) as Order[];
    console.log(
      `fetching user orders from Turso took ${performance.now() - start}ms`
    );
    return orders;
  }

  // If not in Turso, fetch from Airtable
  const shop = await getShop();
  const orders = (
    await airtable("shop_orders")
      .select({
        filterByFormula: `
        AND(
          {recipient:slack_id} = "${userId}",
          {status} != "REJECTED",
          {created_at} > "2024-10-30T12:00:00.000Z"
        )`,
      })
      .all()
  ).map((order) => {
    const shopItem = shop.find(
      (item) => item.recordId === (order.fields.shop_item as string[])[0]
    );
    return {
      dollarCost:
        (order.fields.dollar_cost as number) ||
        shopItem?.fairMarketValue ||
        0.5,
      name: (order.fields["shop_item:name"] as string[])[0] as string,
      doubloonsPaid: order.fields.tickets_paid as number,
      imageUrl: shopItem?.imageUrl === null ? undefined : shopItem?.imageUrl,
    };
  });

  // Cache the orders in Turso
  await db
    .insert(shopOrdersTable)
    .values({
      userId,
      json: JSON.stringify(orders),
    })
    .onConflictDoUpdate({
      target: shopOrdersTable.userId,
      set: { json: JSON.stringify(orders) },
    });

  console.log(
    `fetching user orders from Airtable and caching took ${
      performance.now() - start
    }ms`
  );
  return orders;
}

// #region Types
export type ShipType = "project" | "update";
export type ShipStatus = "shipped" | "staged" | "deleted";
export type YswsType =
  | "none"
  | "onboard"
  | "blot"
  | "sprig"
  | "bin"
  | "hackpad"
  | "llm"
  | "boba"
  | "cascade"
  | "retrospect"
  | "hackcraft"
  | "cider"
  | "browser buddy"
  | "cargo-cult"
  | "fraps"
  | "riceathon"
  | "counterspell"
  | "anchor"
  | "dessert"
  | "asylum";
export interface Ship extends EditableShipFields {
  id: string; // The Airtable row's ID.
  autonumber: number;
  // doubloonsPaid?: number;
  matchupsCount: number;
  hours: number | null;
  creditedHours: number | null;
  totalHours: number | null;
  voteRequirementMet: boolean;
  voteBalanceExceedsRequirement: boolean;
  doubloonPayout: number;
  shipType: ShipType;
  shipStatus: ShipStatus;
  wakatimeProjectNames: string[];
  createdTime: string;
  updateDescription: string | null;
  reshippedFromId: string | null;
  reshippedToId: string | null;
  reshippedAll: string[] | null;
  reshippedFromAll: string[] | null;
  paidOut: boolean;
  yswsType: YswsType;
  feedback: string | null;
  isInYswsBase: boolean;
}
export interface EditableShipFields {
  title: string;
  repoUrl: string;
  deploymentUrl?: string;
  readmeUrl: string;
  screenshotUrl: string;
}
export interface Person {
  fullName: string;
  recordId: string;
  email: string;
  autonumber: number;
  voteBalance: number;
  shipsAwaitingVoteRequirement: number;
  totalHoursLogged: number;
  doubloonsBalance: number;
  doubloonsReceived: number;
  doubloonsSpent: number;
  averageDoubloonsPerHour: number;
  voteCount: number;
  averageVoteTime: number;
  realMoneySpent: number;
}
export type ShipGroup = {
  title: string;
  created: Date;
  totalDoubloons: number;
  totalHours: number;
  isInYswsBase: boolean;
  ships: Ship[];
};
// #endregion Types
