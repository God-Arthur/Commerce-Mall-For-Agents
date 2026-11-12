/** 实验共用的可复现随机数、汇总和落盘。不引入第三方统计库。 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    return s / 4294967296;
  };
}

export function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

export function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) ** 2;
  return Math.sqrt(s / (xs.length - 1));
}

export function pearson(xs: number[], ys: number[]): number | null {
  if (xs.length !== ys.length || xs.length < 3) return null;
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < xs.length; i++) {
    const a = xs[i]! - mx;
    const b = ys[i]! - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  if (dx === 0 || dy === 0) return null;
  return num / Math.sqrt(dx * dy);
}

export function clamp01(x: number): number {
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

export function round(x: number, digits = 4): number {
  const p = 10 ** digits;
  return Math.round(x * p) / p;
}

const HERE = dirname(fileURLToPath(import.meta.url));

export function resultsDir(): string {
  return join(HERE, "results");
}

export function writeResult(name: string, data: unknown): string {
  const dir = resultsDir();
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.json`);
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
  return path;
}
