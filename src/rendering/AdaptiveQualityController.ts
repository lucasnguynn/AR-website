import { AR_RUNTIME_CONFIG } from '../config/arRuntimeConfig';

export type QualityTier = 'HIGH' | 'MEDIUM' | 'LOW';

export interface FrameStatistics {
  readonly averageMs: number;
  readonly p95Ms: number;
  readonly overBudgetMs: number;
  readonly underBudgetMs: number;
  readonly sampleCount: number;
}

const ORDER: readonly QualityTier[] = [
  'HIGH',
  'MEDIUM',
  'LOW',
];

const MIN_OVERLOAD_SAMPLES = 30;
const MIN_RECOVERY_SAMPLES = 60;

const OVERLOAD_AVERAGE_MS = 22;
const OVERLOAD_P95_MS = 32;

const RECOVERY_AVERAGE_MS = 17.5;
const RECOVERY_P95_MS = 22;

const DOWNGRADE_AFTER_MS = 1_500;
const UPGRADE_AFTER_MS = 7_500;

/**
 * Rolling quality controller.
 *
 * Policy:
 *
 * - quality degradation reacts relatively quickly to sustained overload;
 * - quality recovery is deliberately slower;
 * - rolling average/p95 act as stability gates;
 * - streak timers measure actual consecutive frame health;
 * - a healthy frame immediately cancels an overload streak;
 * - a slow frame immediately cancels a recovery streak.
 *
 * Separating "streak duration" from "rolling-window confidence" avoids an
 * important failure mode where old slow frames keep accumulating overload time
 * even after the renderer has already recovered.
 */
export class AdaptiveQualityController {
  private readonly samples: number[] = [];

  private tier: QualityTier;

  private overBudgetMs = 0;

  private underBudgetMs = 0;

  constructor(
    initial: QualityTier = 'HIGH',
    private readonly windowSize = 120,
  ) {
    this.tier = initial;
  }

  get quality(): QualityTier {
    return this.tier;
  }

  sample(
    frameMs: number,
  ): {
    quality: QualityTier;
    changed: boolean;
    statistics: FrameStatistics;
  } {
    /**
     * A broken performance.now()/measurement source must never poison the
     * rolling average with NaN/Infinity.
     *
     * Invalid samples are treated conservatively as a very slow frame.
     */
    const normalized = Number.isFinite(frameMs)
      ? frameMs
      : 250;

    const bounded = Math.min(
      Math.max(normalized, 0),
      250,
    );

    this.samples.push(bounded);

    if (this.samples.length > this.windowSize) {
      this.samples.shift();
    }

    const averageMs =
      this.samples.reduce(
        (sum, value) => sum + value,
        0,
      ) / this.samples.length;

    const sorted = [
      ...this.samples,
    ].sort(
      (a, b) => a - b,
    );

    const p95Index = Math.min(
      sorted.length - 1,
      Math.floor(
        (sorted.length - 1) * 0.95,
      ),
    );

    const p95Ms = sorted[p95Index];

    /**
     * Rolling-window confidence gates.
     */
    const overloaded =
      this.samples.length >= MIN_OVERLOAD_SAMPLES
      && (
        averageMs > OVERLOAD_AVERAGE_MS
        || p95Ms > OVERLOAD_P95_MS
      );

    const recovered =
      this.samples.length >= MIN_RECOVERY_SAMPLES
      && averageMs < RECOVERY_AVERAGE_MS
      && p95Ms < RECOVERY_P95_MS;

    /**
     * Streak classification.
     *
     * Do NOT keep counting overload time merely because the rolling window
     * still contains historic slow frames.
     *
     * Example:
     *
     *   old frames: 30 ms
     *   new frames: 16 ms
     *
     * The rolling average may remain overloaded temporarily, but the current
     * renderer has already recovered. Continuing the overload timer here could
     * incorrectly downgrade MEDIUM -> LOW while performance is improving.
     */
    const overloadCandidate =
      overloaded
      && bounded > OVERLOAD_AVERAGE_MS;

    /**
     * Recovery duration begins with the first genuinely healthy frame.
     *
     * The controller still requires the rolling window to satisfy `recovered`
     * before an actual quality upgrade can happen.
     *
     * This makes "7.5 seconds sustained recovery" mean approximately 7.5
     * seconds of healthy frames, rather than:
     *
     * rolling-window warmup + another 7.5 seconds.
     */
    const recoveryCandidate =
      bounded < RECOVERY_AVERAGE_MS;

    if (overloadCandidate) {
      this.overBudgetMs = Math.min(
        this.overBudgetMs + bounded,
        DOWNGRADE_AFTER_MS,
      );
    } else {
      this.overBudgetMs = 0;
    }

    if (recoveryCandidate) {
      this.underBudgetMs = Math.min(
        this.underBudgetMs + bounded,
        UPGRADE_AFTER_MS,
      );
    } else {
      this.underBudgetMs = 0;
    }

    let changed = false;

    const index = ORDER.indexOf(
      this.tier,
    );

    /**
     * Downgrade:
     *
     * rolling statistics say overloaded
     * +
     * current frames have remained slow
     * +
     * overload lasted >= 1.5 seconds
     */
    if (
      overloaded
      && this.overBudgetMs >= DOWNGRADE_AFTER_MS
      && index < ORDER.length - 1
    ) {
      this.tier = ORDER[
        index + 1
      ];

      this.overBudgetMs = 0;
      this.underBudgetMs = 0;

      changed = true;
    }

    /**
     * Upgrade:
     *
     * rolling statistics confirm recovery
     * +
     * healthy-frame streak lasted >= 7.5 seconds
     *
     * Recovery intentionally remains much slower than degradation.
     */
    else if (
      recovered
      && this.underBudgetMs >= UPGRADE_AFTER_MS
      && index > 0
    ) {
      this.tier = ORDER[
        index - 1
      ];

      this.overBudgetMs = 0;
      this.underBudgetMs = 0;

      changed = true;
    }

    return {
      quality: this.tier,

      changed,

      statistics: {
        averageMs,
        p95Ms,
        overBudgetMs:
          this.overBudgetMs,
        underBudgetMs:
          this.underBudgetMs,
        sampleCount:
          this.samples.length,
      },
    };
  }
}

export const qualitySettings: Record<
  QualityTier,
  {
    dpr: number;
    shadows: boolean;
    depthIntervalMs: number;
  }
> = {
  HIGH: {
    dpr:
      AR_RUNTIME_CONFIG.performance.HIGH.dpr,

    shadows:
      AR_RUNTIME_CONFIG.performance.HIGH.shadows,

    depthIntervalMs:
      AR_RUNTIME_CONFIG.performance.HIGH.depthIntervalMs,
  },

  MEDIUM: {
    dpr:
      AR_RUNTIME_CONFIG.performance.MEDIUM.dpr,

    shadows:
      AR_RUNTIME_CONFIG.performance.MEDIUM.shadows,

    depthIntervalMs:
      AR_RUNTIME_CONFIG.performance.MEDIUM.depthIntervalMs,
  },

  LOW: {
    dpr:
      AR_RUNTIME_CONFIG.performance.LOW.dpr,

    shadows:
      AR_RUNTIME_CONFIG.performance.LOW.shadows,

    depthIntervalMs:
      AR_RUNTIME_CONFIG.performance.LOW.depthIntervalMs,
  },
};
