/**
 * DeviceProfiler.ts
 *
 * Utility to asynchronously test client capabilities and classify devices
 * for optimal AR experience delivery.
 */

export type DeviceClass = 'HIGH' | 'MEDIUM' | 'LOW' | 'UNSUPPORTED';
export type ARCapability = 'WEBXR' | 'QUICK_LOOK';

export interface DeviceProfile {
  deviceClass: DeviceClass;
  hasGetUserMedia: boolean;
  hasWebGL: boolean;
  hasWebGL2: boolean;
  hasWorkerSupport: boolean;
  hasQuickLook: boolean;
  arCapabilities: ARCapability[];
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

      if (!context) {
        return false;
      }

      // Lose the context to prevent memory leaks from repeated tests
      const ext = (context as WebGLRenderingContext)?.getExtension('WEBGL_lose_context');
      ext?.loseContext();

      return true;
    } catch {
      return false;
    }
  }

  private static checkWorkerSupport(): boolean {
    return typeof Worker !== 'undefined';
  }

  public static checkQuickLookSupport(): boolean {
    if (typeof document === 'undefined') {
      return false;
    }

    const anchor = document.createElement('a');
    return typeof anchor.relList?.supports === 'function' && anchor.relList.supports('ar');
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
    hasWebGL2: boolean,
    hasQuickLook: boolean
  ): DeviceClass {
    if (!hasWebGL2 && !hasQuickLook) {
      return 'UNSUPPORTED';
    }

    const effectiveCores = logicalCores ?? 0;
    const isAppleDevice = /iPad|iPhone|iPod|Mac/.test(navigator.userAgent);

    if (isAppleDevice && deviceMemory === null) {
      if (effectiveCores >= 6) return 'HIGH';
      if (effectiveCores >= 4) return 'MEDIUM';
      if (effectiveCores >= 2 || hasQuickLook) return 'LOW';
      return 'UNSUPPORTED';
    }

    const effectiveMemory = deviceMemory ?? 0;

    if (effectiveCores >= 6 && effectiveMemory >= 4) return 'HIGH';
    if (effectiveCores >= 4 || effectiveMemory >= 2) return 'MEDIUM';
    if (effectiveCores >= 2 || effectiveMemory >= 1 || hasQuickLook) return 'LOW';

    return 'UNSUPPORTED';
  }

  public static async profile(): Promise<DeviceProfile> {
    const details: string[] = [];

    const [hasGetUserMedia, hasWebGL, hasWebGL2, hasWorkerSupport, hasQuickLook] = await Promise.all([
      this.checkGetUserMedia(),
      Promise.resolve(this.checkWebGLContext(1)),
      Promise.resolve(this.checkWebGLContext(2)),
      Promise.resolve(this.checkWorkerSupport()),
      Promise.resolve(this.checkQuickLookSupport()),
    ]);

    const logicalCores = this.getLogicalCores();
    const deviceMemory = this.getDeviceMemory();
    const arCapabilities: ARCapability[] = [];

    if (hasWebGL2 && hasGetUserMedia) {
      arCapabilities.push('WEBXR');
    }
    if (hasQuickLook) {
      arCapabilities.push('QUICK_LOOK');
    }

    if (!hasGetUserMedia) details.push('Camera API (getUserMedia) not supported');
    if (!hasWebGL) details.push('WebGL not supported');
    if (!hasWebGL2) details.push('WebGL2 not supported');
    if (!hasWorkerSupport) details.push('Web Workers not supported');
    if (!hasQuickLook) details.push('Apple Quick Look (rel="ar") not supported');
    if ((logicalCores ?? 0) < 4) details.push(`Low CPU cores: ${logicalCores ?? 'unknown'}`);
    if ((deviceMemory ?? 0) < 2) details.push(`Low device memory: ${deviceMemory ?? 'unknown'}GB`);

    const deviceClass = this.classifyDevice(logicalCores, deviceMemory, hasWebGL2, hasQuickLook);

    if (deviceClass === 'UNSUPPORTED' && details.length === 0) {
      details.push('Device does not meet minimum performance requirements');
    }

    return {
      deviceClass,
      hasGetUserMedia,
      hasWebGL,
      hasWebGL2,
      hasWorkerSupport,
      hasQuickLook,
      arCapabilities,
      logicalCores,
      deviceMemory,
      details,
    };
  }

  public static isARSupported(profile?: DeviceProfile): boolean {
    if (!profile) return false;
    return profile.deviceClass !== 'UNSUPPORTED' || profile.arCapabilities.includes('QUICK_LOOK');
  }
}
