import { describe, expect, it } from "vitest";
import { indexColumns } from "../src/db/schema.js";

describe("indexColumns (pg_indexes.indexdef)", () => {
  const cases: Array<[string, string[]]> = [
    ["CREATE UNIQUE INDEX users_email_idx ON public.users USING btree (email)", ["email"]],
    ["CREATE INDEX t_ab_idx ON public.t USING btree (a, b)", ["a", "b"]],
    ['CREATE INDEX t_q_idx ON public.t USING btree ("Mixed Case", "a""b")', ["Mixed Case", 'a"b']],
    ["CREATE INDEX t_lower_idx ON public.users USING btree (lower((email)::text))", ["lower((email)::text)"]],
    ["CREATE INDEX t_co_idx ON public.t USING btree (COALESCE(a, b), c)", ["COALESCE(a, b)", "c"]],
    ["CREATE INDEX t_ops_idx ON public.t USING btree (name text_pattern_ops)", ["name"]],
    ["CREATE INDEX t_desc_idx ON public.t USING btree (created_at DESC NULLS LAST, id)", ["created_at", "id"]],
    ['CREATE INDEX t_coll_idx ON public.t USING btree (name COLLATE "C")', ["name"]],
    ["CREATE INDEX t_inc_idx ON public.t USING btree (a) INCLUDE (b, c)", ["a"]],
    ["CREATE INDEX t_part_idx ON public.t USING btree (a) WHERE (deleted_at IS NULL)", ["a"]],
    ['CREATE INDEX t_paren_idx ON public."we(ird" USING btree (a)', ["a"]],
    ["CREATE INDEX t_expr_idx ON public.t USING btree ((a + b) DESC)", ["(a + b)"]],
  ];
  for (const [def, expected] of cases) {
    it(def.replace(/^CREATE (UNIQUE )?INDEX \S+ ON /, ""), () => {
      expect(indexColumns(def)).toEqual(expected);
    });
  }
});
