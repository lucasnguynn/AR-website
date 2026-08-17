/**
 * DeviceProfiler.ts
 * 
 * Utility to asynchronously test client capabilities and classify devices
 * for optimal AR experience delivery.
 */

export type DeviceClass = 'HIGH' | 'MEDIUM' | 'LOW' | 'UNSUPPORTED';

export interface DeviceProfile {
  deviceClass: DeviceClass;
  hasGetUserMedia: boolean;
  hasWebGL: boolean;
  hasWebGL2: boolean;
  hasWorkerSupport: boolean;
  logicalCores: number | null;
  deviceMemory: number | null;
  details: string[];
}

export class DeviceProfiler {
  private static async checkGetUserMedia(): Promise<boolean> {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }

  private static checkWebGLContext(version: 1 | 2): boolean {
    try {
      const canvas = document.createElement('canvas');
      const context = version === 1 
        ? canvas.getContext('webgl') || canvas.getContext('experimental-webgl')
        : canvas.getContext('webgl2');
      return !!context;
    } catch {
      return false;
    }
  }

  private static checkWorkerSupport(): boolean {
    return typeof Worker !== 'undefined';
  }

  private static getLogicalCores(): number | null {
    return navigator.hardwareConcurrency ?? null;
  }

  private static getDeviceMemory(): number | null {
    // @ts-ignore - deviceMemory is not in standard TypeScript lib
    return navigator.deviceMemory ?? null;
  }

  private static classifyDevice(
    logicalCores: number | null,
    deviceMemory: number | null,
    hasWebGL2: boolean
  ): DeviceClass {
    // UNSUPPORTED: No WebGL2 or extremely limited resources
    if (!hasWebGL2) {
      return 'UNSUPPORTED';
    }

    // HIGH: 6+ cores AND 4GB+ memory
    // On Safari, deviceMemory is undefined, so rely on logicalCores alone for Apple devices
    const isAppleDevice = /iPad|iPhone|iPod|Mac/.test(navigator.userAgent);
    const effectiveMemory = deviceMemory ?? (isAppleDevice ? 4 : 0);
    const effectiveCores = logicalCores ?? 0;

    if (effectiveCores >= 6 && effectiveMemory >= 4) {
      return 'HIGH';
    }

    // MEDIUM: 4+ cores OR 2GB+ memory (but not HIGH tier)
    // For Safari devices without deviceMemory, use logicalCores as primary classifier
    if (isAppleDevice && deviceMemory === null) {
      // Safari doesn't support deviceMemory - classify based on cores alone
      if (effectiveCores >= 6) {
        return 'HIGH';
      }
      if (effectiveCores >= 4) {
        return 'MEDIUM';
      }
      if (effectiveCores >= 2) {
        return 'LOW';
      }
      return 'UNSUPPORTED';
    }

    if (effectiveCores >= 4 || effectiveMemory >= 2) {
      return 'MEDIUM';
    }

    // LOW: Meets WebGL2 but below medium performance — force fallback
    // @fix BUG-12: Keep LOW classification for diagnostics, but ARTryOnModal will treat it as unsupported
    if (effectiveCores >= 2 || effectiveMemory >= 1) {
      return 'LOW';
    }

    // UNSUPPORTED: Below minimum thresholds
    return 'UNSUPPORTED';
  }

  public static async profile(): Promise<DeviceProfile> {
    const details: string[] = [];
    
    // Check all capabilities in parallel
    const [hasGetUserMedia, hasWebGL, hasWebGL2, hasWorkerSupport] = await Promise.all([
      this.checkGetUserMedia(),
      Promise.resolve(this.checkWebGLContext(1)),
      Promise.resolve(this.checkWebGLContext(2)),
      Promise.resolve(this.checkWorkerSupport()),
    ]);

    const logicalCores = this.getLogicalCores();
    const deviceMemory = this.getDeviceMemory();

    // Build diagnostic details
    if (!hasGetUserMedia) {
      details.push('Camera API (getUserMedia) not supported');
    }
    if (!hasWebGL) {
      details.push('WebGL not supported');
    }
    if (!hasWebGL2) {
      details.push('WebGL2 not supported');
    }
    if (!hasWorkerSupport) {
      details.push('Web Workers not supported');
    }
    if ((logicalCores ?? 0) < 4) {
      details.push(`Low CPU cores: ${logicalCores ?? 'unknown'}`);
    }
    if ((deviceMemory ?? 0) < 2) {
      details.push(`Low device memory: ${deviceMemory ?? 'unknown'}GB`);
    }

    const deviceClass = this.classifyDevice(logicalCores, deviceMemory, hasWebGL2);

    if (deviceClass === 'UNSUPPORTED' && details.length === 0) {
      details.push('Device does not meet minimum performance requirements');
    }

    return {
      deviceClass,
      hasGetUserMedia,
      hasWebGL,
      hasWebGL2,
      hasWorkerSupport,
      logicalCores,
      deviceMemory,
      details,
    };
  }

  public static isARSupported(profile?: DeviceProfile): boolean {
    const effectiveProfile = profile?.deviceClass ?? 'UNSUPPORTED';
    return effectiveProfile !== 'UNSUPPORTED';
  }
}
