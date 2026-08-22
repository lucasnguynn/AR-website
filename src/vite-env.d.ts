/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_PRODUCT_SKU?: string;
  readonly VITE_PRODUCT_NAME?: string;
  readonly VITE_ASSET_VERSION?: string;
  readonly VITE_RING_OUTER_DIAMETER_MM?: string;
  readonly VITE_RING_MODEL_HIGH?: string;
  readonly VITE_RING_MODEL_MEDIUM?: string;
  readonly VITE_RING_MODEL_LOW?: string;
  readonly VITE_RING_USDZ?: string;
  readonly VITE_RING_PREVIEW?: string;
  readonly VITE_ENABLE_MONOCULAR_DEPTH?: string;
  readonly VITE_DEPTH_MODEL?: string;
  readonly VITE_ENABLE_METRIC_SIZING?: string;
  readonly VITE_METRIC_CALIBRATION_VALIDATED?: string;
  readonly VITE_ENABLE_PRIVACY_TELEMETRY?: string;
  readonly VITE_TELEMETRY_ENDPOINT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
