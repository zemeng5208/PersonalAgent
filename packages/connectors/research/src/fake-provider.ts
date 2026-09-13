import { ProtocolError } from '@personal-agent/contracts';
import type { ResearchMaterial, ResearchProvider, ResearchSearchInput } from './provider.js';

/**
 * Fake 资料夹具（测试专用），三种形态齐全：
 * - 两篇正常论文（一篇较新、一篇超过默认 365 天窗口 → stale）；
 * - 一篇无 publication_date（occurredAt 回退抓取时刻并显式标注）。
 */
export const defaultResearchFixtures: ResearchMaterial[] = [
  {
    externalId: 'W-fixture-2026',
    title: 'Personal agent architectures for weather-grounded assistance',
    publishedAt: '2026-06-15T00:00:00.000Z',
    authors: ['A. Researcher', 'B. Author'],
    venue: 'Journal of Agent Systems',
    url: 'https://doi.org/10.fixture/2026',
    citedBy: 3,
    language: 'en',
  },
  {
    externalId: 'W-fixture-1999',
    title: 'Early survey of automated research assistants',
    publishedAt: '1999-12-01T00:00:00.000Z',
    authors: ['C. Pioneer'],
    venue: 'AI Review (Historical)',
    url: 'https://doi.org/10.fixture/1999',
    citedBy: 4483,
    language: 'en',
  },
  {
    externalId: 'W-fixture-nodate',
    title: 'Preprint without a publication date',
    publishedAt: null,
    authors: ['D. Anonymous'],
    language: 'en',
  },
];

export class FakeResearchProvider implements ResearchProvider {
  readonly providerKind = 'fixture';
  readonly verification = 'mock' as const;
  private failure: ProtocolError | null = null;

  constructor(private readonly fixtures: ResearchMaterial[] = defaultResearchFixtures) {}

  setFailure(error: ProtocolError | null): void {
    this.failure = error;
  }

  async search(_accountRef: string, input: ResearchSearchInput): Promise<ResearchMaterial[]> {
    if (this.failure) throw this.failure;
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 20) {
      throw new ProtocolError('INVALID_ARGUMENT', 'limit must be 1..20');
    }
    const terms = input.query.toLowerCase().split(/\s+/).filter(term => term.length > 0);
    const matched = this.fixtures.filter(material =>
      terms.some(term => material.title.toLowerCase().includes(term)),
    );
    return structuredClone(matched.slice(0, input.limit));
  }
}
