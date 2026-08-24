// Database-level tenant isolation (src/rls.js).
//
// These assertions are about Postgres itself refusing to return or accept
// rows -- not about the app's own `where orgId` clauses, which are covered
// by orgIsolation.test.js and would pass whether or not RLS existed. So the
// whole file is skipped unless the suite is pointed at Postgres:
//
//   ./scripts/setup-test-postgres.sh
//   REKONO_TEST_PG_URL=postgres://rekono_app:apppw@127.0.0.1:5432 npm test
import { QueryTypes } from "sequelize";
import { sequelize } from "../src/db.js";
import { Invoice, LineItem, Organization } from "../src/models/index.js";
import { RLS_TABLES, rlsSupported, runWithOrgContext, runWithSystemContext, verifyRlsEffective } from "../src/rls.js";
import { resetDb } from "./testUtils.js";

const onPostgres = rlsSupported() ? describe : describe.skip;

onPostgres("row-level security", () => {
  beforeEach(resetDb);

  async function twoOrgsWithAnInvoiceEach() {
    return runWithSystemContext(async () => {
      await Organization.create({ id: "org-a", name: "Org A" });
      await Organization.create({ id: "org-b", name: "Org B" });
      await Invoice.create({ id: "inv-a", orgId: "org-a", originalFilename: "a.pdf", storagePath: "/a" });
      await Invoice.create({ id: "inv-b", orgId: "org-b", originalFilename: "b.pdf", storagePath: "/b" });
    });
  }

  test("every table that holds tenant data has the policy attached and forced", async () => {
    const rows = await sequelize.query(
      `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
       WHERE relname = ANY($tables) AND relkind = 'r'`,
      { type: QueryTypes.SELECT, bind: { tables: RLS_TABLES } }
    );

    expect(rows).toHaveLength(RLS_TABLES.length);
    for (const row of rows) {
      // FORCE is the half that's easy to miss: without it the table's owner
      // -- which is what the app connects as on every managed provider --
      // is exempt from the policy, and nothing is actually enforced.
      expect({ table: row.relname, enabled: row.relrowsecurity, forced: row.relforcerowsecurity }).toEqual({
        table: row.relname,
        enabled: true,
        forced: true,
      });
    }
  });

  test("the role the app connects as is one that row security actually applies to", async () => {
    // Postgres silently skips row security for superusers and BYPASSRLS
    // roles, which would make every other assertion here vacuous.
    await expect(verifyRlsEffective()).resolves.toEqual({ effective: true });
  });

  test("an org context sees only its own rows", async () => {
    await twoOrgsWithAnInvoiceEach();

    const seenByA = await runWithOrgContext("org-a", () => Invoice.findAll());
    expect(seenByA.map((i) => i.id)).toEqual(["inv-a"]);

    const seenByB = await runWithOrgContext("org-b", () => Invoice.findAll());
    expect(seenByB.map((i) => i.id)).toEqual(["inv-b"]);
  });

  test("a query that forgets to scope itself still can't reach another org", async () => {
    await twoOrgsWithAnInvoiceEach();

    // Deliberately no `where orgId` -- the exact mistake this layer exists
    // to catch. Under app-level scoping alone this would return both rows.
    const all = await runWithOrgContext("org-a", () => Invoice.findAll({ where: {} }));

    expect(all.map((i) => i.id)).toEqual(["inv-a"]);
  });

  test("fetching another org's row by its exact id finds nothing", async () => {
    await twoOrgsWithAnInvoiceEach();

    const stolen = await runWithOrgContext("org-a", () => Invoice.findByPk("inv-b"));

    expect(stolen).toBeNull();
  });

  test("writing a row into another org is rejected outright", async () => {
    await twoOrgsWithAnInvoiceEach();

    await expect(
      runWithOrgContext("org-a", () =>
        Invoice.create({ id: "inv-x", orgId: "org-b", originalFilename: "x.pdf", storagePath: "/x" })
      )
    ).rejects.toThrow(/row-level security/i);
  });

  test("re-homing one's own row into another org is rejected too", async () => {
    await twoOrgsWithAnInvoiceEach();

    await expect(
      runWithOrgContext("org-a", async () => {
        const invoice = await Invoice.findByPk("inv-a");
        invoice.orgId = "org-b";
        await invoice.save();
      })
    ).rejects.toThrow(/row-level security/i);
  });

  test("no context at all sees nothing -- the default is closed, not open", async () => {
    await twoOrgsWithAnInvoiceEach();

    // Bypasses runWith*Context entirely, so neither GUC is set. This is the
    // state any code path that forgot to establish a context runs in.
    const rows = await sequelize.query(
      `SELECT id FROM invoices WHERE current_setting('rekono.system', true) IS DISTINCT FROM 'on'`,
      { type: QueryTypes.SELECT }
    );

    expect(rows).toEqual([]);
  });

  test("a child table is scoped through its parent, not by an orgId of its own", async () => {
    await twoOrgsWithAnInvoiceEach();
    await runWithSystemContext(() =>
      LineItem.create({ id: "li-b", invoiceId: "inv-b", description: "Org B line", quantity: 1, unitPrice: 10, amount: 10 })
    );

    const seenByA = await runWithOrgContext("org-a", () =>
      sequelize.query(`SELECT id FROM line_items`, { type: QueryTypes.SELECT })
    );

    expect(seenByA).toEqual([]);
  });
});
