// FILE: src/utils/DeviceProfiler.ts

/** Performance class assigned from local browser hardware signals. */
export type DeviceClass = 'HIGH' | 'MEDIUM' | 'LOW' | 'UNSUPPORTED';
export type ARCapability = 'WEBXR' | 'QUICK_LOOK' | 'CAMERA_COMPOSITE' | 'INTERACTIVE_3D';
export type RecommendedQuality = 'HIGH' | 'MEDIUM' | 'LOW';

interface NavigatorWithDeviceMemory extends Navigator {
  readonly deviceMemory?: number;
}

export interface DeviceProfile {
  deviceClass: DeviceClass;
  hasGetUserMedia: boolean;
  hasWebGL: boolean;
  hasWebGL2: boolean;
  hasWebGPU: boolean;
  hasWorkerSupport: boolean;
  hasQuickLook: boolean;
  hasWebXRApi: boolean;
  immersiveARSupported: boolean | null;
  arCapabilities: ARCapability[];
  logicalCores: number | null;
  deviceMemory: number | null;
  details: string[];
}

function hasQuickLookAnchorSupport(): boolean {
  if (typeof document === 'undefined') return false;
  const anchor = document.createElement('a');
  return typeof anchor.relList?.supports === 'function' && anchor.relList.supports('ar');
}

/** Capability profiler for camera, graphics, workers and AR route selection. */
export class DeviceProfiler {
  private static checkGetUserMedia(): boolean {
    return Boolean(navigator.mediaDevices?.getUserMedia);
  }

  private static checkWebGLContext(version: 1 | 2): boolean {
    try {
      const canvas = document.createElement('canvas');
      const context = version === 1
        ? canvas.getContext('webgl') || canvas.getContext('experimental-webgl')
        : canvas.getContext('webgl2');
      if (!context) return false;
      (context as WebGLRenderingContext).getExtension('WEBGL_lose_context')?.loseContext();
      return true;
    } catch {
      return false;
    }
  }

  private static checkWorkerSupport(): boolean {
    return typeof Worker !== 'undefined';
  }

  public static checkQuickLookSupport(): boolean {
    return hasQuickLookAnchorSupport();
  }

  /** Safe to run before the user clicks; requestSession itself remains in the click chain. */
  public static async checkImmersiveARSupport(): Promise<boolean | null> {
    if (!navigator.xr) return false;
    if (typeof navigator.xr.isSessionSupported !== 'function') return null;
    try {
      return await navigator.xr.isSessionSupported('immersive-ar');
    } catch {
      return null;
    }
  }

  private static getLogicalCores(): number | null {
    return navigator.hardwareConcurrency ?? null;
  }

  private static getDeviceMemory(): number | null {
    return (navigator as NavigatorWithDeviceMemory).deviceMemory ?? null;
  }

  private static classifyDevice(
    logicalCores: number | null,
    deviceMemory: number | null,
    hasWebGL2: boolean,
    hasQuickLook: boolean,
  ): DeviceClass {
    if (!hasWebGL2 && !hasQuickLook) return 'UNSUPPORTED';

    const cores = logicalCores ?? 0;
    const isAppleDevice = /iPad|iPhone|iPod|Mac/.test(navigator.userAgent);

    // Safari often withholds deviceMemory; do not punish Apple hardware solely for that.
    if (isAppleDevice && deviceMemory === null) {
      if (cores >= 6) return 'HIGH';
      if (cores >= 4) return 'MEDIUM';
      if (cores >= 2 || hasQuickLook) return 'LOW';
      return 'UNSUPPORTED';
    }

    const memory = deviceMemory ?? 0;
    if (cores >= 8 && memory >= 6) return 'HIGH';
    if (cores >= 4 && memory >= 2) return 'MEDIUM';
    if (cores >= 2 || memory >= 1 || hasQuickLook) return 'LOW';
    return 'UNSUPPORTED';
  }

  public static recommendedQualityFromSignals(): RecommendedQuality {
    const cores = this.getLogicalCores() ?? 0;
    const memory = this.getDeviceMemory();
    const isAppleDevice = /iPad|iPhone|iPod|Mac/.test(navigator.userAgent);
    if (isAppleDevice && memory === null) return cores >= 6 ? 'HIGH' : cores >= 4 ? 'MEDIUM' : 'LOW';
    if (cores >= 8 && (memory ?? 0) >= 6) return 'HIGH';
    if (cores >= 4 && (memory ?? 0) >= 2) return 'MEDIUM';
    return 'LOW';
  }

  public static async profile(): Promise<DeviceProfile> {
    const details: string[] = [];
    const [immersiveARSupported] = await Promise.all([this.checkImmersiveARSupport()]);
    const hasGetUserMedia = this.checkGetUserMedia();
    const hasWebGL = this.checkWebGLContext(1);
    const hasWebGL2 = this.checkWebGLContext(2);
    const hasWebGPU = Boolean(navigator.gpu);
    const hasWorkerSupport = this.checkWorkerSupport();
    const hasQuickLook = this.checkQuickLookSupport();
    const hasWebXRApi = Boolean(navigator.xr);
    const logicalCores = this.getLogicalCores();
    const deviceMemory = this.getDeviceMemory();
    const arCapabilities: ARCapability[] = ['INTERACTIVE_3D'];

    if (hasGetUserMedia && hasWebGL2 && hasWorkerSupport) arCapabilities.unshift('CAMERA_COMPOSITE');
    if (hasQuickLook) arCapabilities.unshift('QUICK_LOOK');
    if (hasWebXRApi && immersiveARSupported !== false) arCapabilities.unshift('WEBXR');

    if (!hasGetUserMedia) details.push('Camera API (getUserMedia) not supported');
    if (!hasWebGL2) details.push('WebGL2 not supported');
    if (!hasWorkerSupport) details.push('Web Workers not supported');
    if (hasWebXRApi && immersiveARSupported === false) details.push('WebXR API exists but immersive-ar is not supported');
    if (!hasWebXRApi) details.push('WebXR API unavailable');
    if (!hasQuickLook) details.push('Apple Quick Look (rel="ar") unavailable');

    const deviceClass = this.classifyDevice(logicalCores, deviceMemory, hasWebGL2, hasQuickLook);
    return {
      deviceClass,
      hasGetUserMedia,
      hasWebGL,
      hasWebGL2,
      hasWebGPU,
      hasWorkerSupport,
      hasQuickLook,
      hasWebXRApi,
      immersiveARSupported,
      arCapabilities,
      logicalCores,
      deviceMemory,
      details,
    };
  }

  public static isARSupported(profile?: DeviceProfile): boolean {
    if (!profile) return false;
    return profile.arCapabilities.some((capability) => capability !== 'INTERACTIVE_3D');
  }
}
