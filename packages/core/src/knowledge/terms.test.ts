import { describe, expect, it } from "vitest";
import { bundleText, keywordMatches, keywordOf, symbolMatches, symbolOf } from "./terms.js";

const symbolIn = (symbol: string, patch: string) =>
  symbolMatches(symbolOf(symbol), bundleText(patch));
const keywordIn = (keyword: string, patch: string) =>
  keywordMatches(keywordOf(keyword), bundleText(patch));

describe("a symbol in a patch", () => {
  it.each([
    ["createCharge", "+ create_charge(order)"],
    ["create_charge", "+ createCharge(order)"],
    ["createCharge", "+ CreateCharge.new(order)"],
    ["cacheKey", "+ CACHE_KEY = 'k'"],
    ["HTTPServer", "+ http_server.listen()"],
    ["pool.connect", "+ this.pool?.connect()"],
    ["user.name", "+ user!.name"],
    ["logger.info", "+ $this->logger->info('sent');"],
    ["Pool.connect", "+ let c = Pool::connect(&url)?;"],
    ["std::mem::take", "+ std.mem.take(x)"],
  ])("finds %s in %s", (symbol, patch) => {
    expect(symbolIn(symbol, patch)).toBe(true);
  });

  it.each([
    ["USER", "+ const user = load();"],
    ["limit", "+ SELECT id FROM t LIMIT 10"],
    ["createCharge", "+ create(charge)"],
    ["createCharge", "+ createChargeLater()"],
    ["cacheKey", "+ cache.key"],
  ])("does not find %s in %s", (symbol, patch) => {
    expect(symbolIn(symbol, patch)).toBe(false);
  });
});

describe("a keyword in a patch", () => {
  it.each([
    ["retry", "+ // three retries"],
    ["retries", "+ retry(fn)"],
    ["connection pool", "+ const pools = connections.map(open)"],
    ["cache", "+ // clear the caches"],
    ["batch", "+ batches.forEach(run)"],
    ["连接泄漏", "+ // 避免连接泄漏问题"],
    ["重复消费", "+ // 修复：不再重复消费"],
    ["接続リーク", "+ // これは接続リークです"],
    ["Redis 连接", "+ // Redis 连接池耗尽"],
  ])("finds %s in %s", (keyword, patch) => {
    expect(keywordIn(keyword, patch)).toBe(true);
  });

  it.each([
    ["uses", "+ use strict"],
    ["status", "+ const statu = 1"],
    ["retry", "+ retrieve(item)"],
    ["连接泄漏", "+ // 连接已关闭"],
  ])("does not find %s in %s", (keyword, patch) => {
    expect(keywordIn(keyword, patch)).toBe(false);
  });
});
