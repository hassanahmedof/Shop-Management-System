import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { COOCCURRENCE_CACHE_VERSION } from '../shared/upsellCacheSchema';
import {
  evictServerMemoryCache,
  getServerCooccurrenceSnapshot,
  hydrateServerCooccurrenceFromExternalSnapshot,
  recordServerCooccurrenceBatch,
  resetServerCooccurrenceStore,
} from './upsellCooccurrenceStore';

describe('server/upsellCooccurrenceStore', () => {
  let tempDir = '';
  const shopId = 'vitest_server_cache_shop';

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caremart-cache-test-'));
  });

  afterEach(() => {
    resetServerCooccurrenceStore(shopId, tempDir);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('persists completed sales atomically, ignores cancelled sales, and deduplicates repeat saleIds', () => {
    const first = recordServerCooccurrenceBatch(
      shopId,
      [
        { saleId: 's1', status: 'completed', productIds: ['a', 'b'] },
        { saleId: 's2', status: 'cancelled', productIds: ['a', 'c'] },
        { saleId: 's1', status: 'completed', productIds: ['a', 'b'] }, // duplicate inside same batch
      ],
      { cacheDir: tempDir }
    );

    expect(first.ingestedCount).toBe(1);
    expect(first.skippedDuplicateCount).toBe(1);
    expect(first.snapshot.version).toBe(COOCCURRENCE_CACHE_VERSION);
    expect(first.snapshot.totalCompletedSales).toBe(1);
    expect(first.snapshot.pairCounts.a?.b).toBe(1);
    expect(first.snapshot.pairCounts.a?.c).toBeUndefined();

    // Evict memory cache and verify cold reload from shared disk cache preserves state
    evictServerMemoryCache(shopId, tempDir);
    const reloaded = getServerCooccurrenceSnapshot(shopId, tempDir);
    expect(reloaded.recovered).toBe(false);
    expect(reloaded.snapshot.totalCompletedSales).toBe(1);
    expect(reloaded.snapshot.pairCounts.a?.b).toBe(1);

    // Retry same saleId in subsequent request -> skipped safely
    const repeat = recordServerCooccurrenceBatch(
      shopId,
      [{ saleId: 's1', status: 'completed', productIds: ['a', 'b'] }],
      { cacheDir: tempDir }
    );
    expect(repeat.ingestedCount).toBe(0);
    expect(repeat.skippedDuplicateCount).toBe(1);
    expect(repeat.snapshot.totalCompletedSales).toBe(1);
  });

  it('safely recovers from corrupt JSON and outdated-version cache files on disk', () => {
    recordServerCooccurrenceBatch(
      shopId,
      [{ saleId: 's_seed', status: 'completed', productIds: ['x', 'y'] }],
      { cacheDir: tempDir }
    );
    const [cacheFile] = fs.readdirSync(tempDir);
    const fullPath = path.join(tempDir, cacheFile);

    // 1. Corrupt JSON recovery
    evictServerMemoryCache(shopId, tempDir);
    fs.writeFileSync(fullPath, '{corrupted_json: [', 'utf8');
    const recoveredFromCorrupt = getServerCooccurrenceSnapshot(shopId, tempDir);
    expect(recoveredFromCorrupt.recovered).toBe(true);
    expect(recoveredFromCorrupt.snapshot.version).toBe(COOCCURRENCE_CACHE_VERSION);
    expect(recoveredFromCorrupt.snapshot.totalCompletedSales).toBe(0);

    // 2. Outdated version recovery
    evictServerMemoryCache(shopId, tempDir);
    fs.writeFileSync(
      fullPath,
      JSON.stringify({ version: 1, shopId, totalCompletedSales: 999 }),
      'utf8'
    );
    const recoveredFromVersion = getServerCooccurrenceSnapshot(shopId, tempDir);
    expect(recoveredFromVersion.recovered).toBe(true);
    expect(recoveredFromVersion.snapshot.version).toBe(COOCCURRENCE_CACHE_VERSION);
    expect(recoveredFromVersion.snapshot.totalCompletedSales).toBe(0);
  });

  it('hydrates cold server cache from external durable Firestore snapshot and rejects invalid versions', () => {
    const rejected = hydrateServerCooccurrenceFromExternalSnapshot(
      shopId,
      { version: 1, shopId, totalCompletedSales: 10 },
      tempDir
    );
    expect(rejected).toBeNull();

    const hydrated = hydrateServerCooccurrenceFromExternalSnapshot(
      shopId,
      {
        version: COOCCURRENCE_CACHE_VERSION,
        shopId,
        revision: 4,
        totalCompletedSales: 3,
        saleCountsByProduct: { p1: 3, p2: 2 },
        pairCounts: { p1: { p2: 2 }, p2: { p1: 2 } },
        processedSaleIds: ['s1', 's2', 's3'],
        updatedAt: Date.now(),
      },
      tempDir
    );
    expect(hydrated).not.toBeNull();
    expect(hydrated?.revision).toBe(4);
    expect(hydrated?.totalCompletedSales).toBe(3);

    evictServerMemoryCache(shopId, tempDir);
    const afterEvict = getServerCooccurrenceSnapshot(shopId, tempDir);
    expect(afterEvict.snapshot.pairCounts.p1?.p2).toBe(2);
  });
});
