import { expect,test } from "bun:test";
import { SOURCES } from "../src/domain/sources";

test("source ids are unique",()=>{
  const ids=SOURCES.map(s=>s.id);
  expect(new Set(ids).size).toBe(ids.length);
});

test("source registry has broad coverage",()=>{
  expect(SOURCES.length).toBeGreaterThan(30);
  expect(SOURCES.some(s=>s.domain==="elecciones")).toBe(true);
  expect(SOURCES.some(s=>s.domain==="compras-publicas")).toBe(true);
  expect(SOURCES.some(s=>s.domain==="geografia")).toBe(true);
});
