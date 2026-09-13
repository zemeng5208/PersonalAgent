import { ProtocolError } from '@personal-agent/contracts';
import type { StoragePort, ProtocolContracts } from '@personal-agent/contracts';
import type { Freshness, PublishedTimeKind, ResearchMaterial, ResearchProvider, ResearchSearchInput } from './provider.js';

type ConnectorItem = ProtocolContracts['connectorItem'];

export interface ResearchServiceOptions {
  now: () => number;
  /** 材料时效窗口：发布时间早于 now-maxAgeMs 记 stale。默认 365 天。 */
  maxAgeMs?: number;
  /** 提供商结果缓存 TTL：失败时回退 stale 缓存并披露 lastError（weather 同款）。默认 10 分钟。 */
  cacheTtlMs?: number;
}

export interface MaterialResult {
  record: ConnectorItem;
  freshness: Freshness;
  publishedAt: string | null;
  publishedTimeKind: PublishedTimeKind;
  ageMs: number;
}

export interface ResearchResult {
  results: MaterialResult[];
  cache: {
    state: 'fresh' | 'fetched' | 'stale';
    fetchedAt: string;
    ageMs: number;
    ttlMs: number;
    lastError?: {code: string; message: string; retryable: boolean};
  };
}

interface CacheEntry {
  materials: ResearchMaterial[];
  fetchedAtMs: number;
}

const CACHE_LIMIT = 100;

export class ResearchService {
  private readonly maxAgeMs: number;
  private readonly cacheTtlMs: number;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly provider: ResearchProvider,
    private readonly options: ResearchServiceOptions,
  ) {
    if (!provider) throw new ProtocolError('INVALID_ARGUMENT', 'Research provider must be explicitly provided');
    const maxAge = options.maxAgeMs ?? 365 * 86_400_000;
    if (!Number.isSafeInteger(maxAge) || maxAge < 3_600_000) {
      throw new ProtocolError('INVALID_ARGUMENT', 'maxAgeMs must be an integer of at least 3600000 (1 hour)');
    }
    this.maxAgeMs = maxAge;
    const ttl = options.cacheTtlMs ?? 600_000;
    if (!Number.isSafeInteger(ttl) || ttl < 1) {
      throw new ProtocolError('INVALID_ARGUMENT', 'cacheTtlMs must be a positive integer');
    }
    this.cacheTtlMs = ttl;
  }

  /**
   * 检索并规范化。失败/过期区分（PA-010）：
   * - 提供商失败 → 可重试错误且有未过期缓存时回退 stale + lastError；否则照实抛出，不用旧结果冒充；
   * - 材料过旧 → 仍返回但 freshness: 'stale'（消费方取舍）；
   * - 无发布时间的材料 → occurredAt 回退抓取时刻，publishedTimeKind 显式标注 fetched_fallback。
   */
  async search(accountRef: string, query: string, options: {limit?: number; signal?: AbortSignal}): Promise<ResearchResult> {
    const limit = options?.limit ?? 10;
    if (typeof query !== 'string' || query.trim().length === 0) throw new ProtocolError('INVALID_ARGUMENT', 'Query must be a non-empty string');
    const cacheKey = `${this.provider.providerKind}|${limit}|${query.trim().toLowerCase()}`;
    const now = this.options.now();
    const cached = this.cache.get(cacheKey);
    const cacheFresh = cached !== undefined && now - cached.fetchedAtMs < this.cacheTtlMs;

    let materials: ResearchMaterial[];
    let state: ResearchResult['cache']['state'];
    let lastError: ResearchResult['cache']['lastError'];
    if (cacheFresh && cached !== undefined) {
      materials = cached.materials;
      state = 'fresh';
    } else {
      try {
        const searchArgs: ResearchSearchInput = {query, limit};
        if (options?.signal !== undefined) searchArgs.signal = options.signal;
        materials = await this.provider.search(accountRef, searchArgs);
        state = 'fetched';
        if (this.cache.size >= CACHE_LIMIT) {
          const oldest = this.cache.keys().next().value;
          if (oldest !== undefined) this.cache.delete(oldest);
        }
        this.cache.set(cacheKey, {materials: structuredClone(materials), fetchedAtMs: now});
      } catch (error) {
        const protocolError = asProtocolError(error);
        if (protocolError !== undefined && protocolError.retryable && cached !== undefined) {
          materials = cached.materials;
          state = 'stale';
          lastError = {code: protocolError.code, message: protocolError.message, retryable: true};
        } else if (protocolError !== undefined) {
          throw protocolError;
        } else {
          throw error;
        }
      }
    }

    const fetchedAt = this.isoNow();
    const results: MaterialResult[] = materials.slice(0, limit).map(material => {
      const record = this.materialToItem(material, accountRef, fetchedAt);
      const ageMs = material.publishedAt === null ? 0 : Math.max(0, now - Date.parse(material.publishedAt));
      const freshness: Freshness = material.publishedAt !== null && ageMs > this.maxAgeMs ? 'stale' : 'fresh';
      const publishedAt = material.publishedAt ?? fetchedAt;
      const publishedTimeKind: PublishedTimeKind = material.publishedAt === null ? 'fetched_fallback' : 'date_only';
      return {record, freshness, publishedAt, publishedTimeKind, ageMs};
    });
    const result: ResearchResult = {
      results,
      cache: {
        state,
        fetchedAt,
        ageMs: cached === undefined ? 0 : Math.max(0, now - cached.fetchedAtMs),
        ttlMs: this.cacheTtlMs,
      },
    };
    if (lastError !== undefined) result.cache.lastError = lastError;
    return structuredClone(result);
  }

  providerVerification(): 'mock' | 'conditional' {
    return this.provider.verification;
  }

  private materialToItem(material: ResearchMaterial, accountRef: string, fetchedAt: string): ConnectorItem {
    const occurredAt = material.publishedAt ?? fetchedAt;
    const authors = material.authors.length > 0 ? material.authors.join(', ') : '作者未知';
    const venue = material.venue === undefined ? '' : `｜${material.venue}`;
    const noDate = material.publishedAt === null ? '｜无发布时间，取抓取时刻' : '｜日期精度到日';
    const record: ConnectorItem = {
      source: 'research',
      accountRef,
      externalId: material.externalId,
      occurredAt,
      fetchedAt,
      contentRef: `${material.title}｜${authors}${venue}${noDate}`,
      sensitivity: 'public',
      dedupeKey: `research:${material.externalId}`,
    };
    if (material.publishedAt !== null) {
      // 时效窗口：[发布时刻, 发布时刻 + maxAgeMs]，与 freshness 判定同源。
      record.validFor = `${material.publishedAt}/${new Date(Date.parse(material.publishedAt) + this.maxAgeMs).toISOString().slice(0, 19)}.000Z`;
    }
    if (material.url !== undefined) record.contentRef = `${record.contentRef}｜${material.url}`;
    return record;
  }

  private isoNow(): string {
    return `${new Date(this.options.now()).toISOString().slice(0, 19)}.000Z`;
  }
}

function asProtocolError(error: unknown): ProtocolError | undefined {
  return error instanceof ProtocolError ? error : undefined;
}
