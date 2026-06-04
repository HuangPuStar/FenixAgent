import { inArray } from "drizzle-orm";
import { db } from "../db";
import { organization } from "../db/schema";

export interface IOrganizationRepo {
  listNamesByIds(ids: string[]): Promise<Map<string, string>>;
}

class PgOrganizationRepo implements IOrganizationRepo {
  async listNamesByIds(ids: string[]) {
    if (ids.length === 0) return new Map<string, string>();
    const rows = await db
      .select({ id: organization.id, name: organization.name })
      .from(organization)
      .where(inArray(organization.id, ids));
    return new Map(rows.map((row) => [row.id, row.name]));
  }
}

export const organizationRepo: IOrganizationRepo = new PgOrganizationRepo();
