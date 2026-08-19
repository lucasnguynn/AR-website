export type QualityTier = 'HIGH' | 'MEDIUM' | 'LOW';

export interface FrameStatistics {
  readonly averageMs: number;
  readonly p95Ms: number;
  readonly overBudgetMs: number;
  readonly underBudgetMs: number;
  readonly sampleCount: number;
}

const ORDER: readonly QualityTier[] = ['HIGH', 'MEDIUM', 'LOW'];

/** Rolling, hysteretic quality policy. Renderer selection is deliberately not part of this class. */
export class AdaptiveQualityController {
  private readonly samples: number[] = [];
  private tier: QualityTier;
  private overBudgetMs = 0;
  private underBudgetMs = 0;

  constructor(initial: QualityTier = 'HIGH', private readonly windowSize = 120) {
    this.tier = initial;
  }

  get quality(): QualityTier { return this.tier; }

  sample(frameMs: number): { quality: QualityTier; changed: boolean; statistics: FrameStatistics } {
    const bounded = Math.min(Math.max(frameMs, 0), 250);
    this.samples.push(bounded);
    if (this.samples.length > this.windowSize) this.samples.shift();
    const averageMs = this.samples.reduce((sum, value) => sum + value, 0) / this.samples.length;
    const sorted = [...this.samples].sort((a, b) => a - b);
    const p95Ms = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
    const overloaded = this.samples.length >= 30 && (averageMs > 22 || p95Ms > 32);
    const recovered = this.samples.length >= 60 && averageMs < 17.5 && p95Ms < 22;
    this.overBudgetMs = overloaded ? this.overBudgetMs + bounded : 0;
    this.underBudgetMs = recovered ? this.underBudgetMs + bounded : 0;

    let changed = false;
    const index = ORDER.indexOf(this.tier);
    if (this.overBudgetMs >= 1_500 && index < ORDER.length - 1) {
      this.tier = ORDER[index + 1];
      this.overBudgetMs = 0;
      this.underBudgetMs = 0;
      changed = true;
    } else if (this.underBudgetMs >= 5_000 && index > 0) {
      this.tier = ORDER[index - 1];
      this.overBudgetMs = 0;
      this.underBudgetMs = 0;
      changed = true;
    }
    return { quality: this.tier, changed, statistics: { averageMs, p95Ms, overBudgetMs: this.overBudgetMs, underBudgetMs: this.underBudgetMs, sampleCount: this.samples.length } };
  }
}

export const qualitySettings: Record<QualityTier, { dpr: number; shadows: boolean; depthIntervalMs: number }> = {
  HIGH: { dpr: 2, shadows: true, depthIntervalMs: 66 },
  MEDIUM: { dpr: 1.5, shadows: false, depthIntervalMs: 100 },
  LOW: { dpr: 1, shadows: false, depthIntervalMs: 180 },
};
