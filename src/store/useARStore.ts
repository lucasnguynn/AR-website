/**
 * useARStore.ts — UPGRADED
 *
 * New additions vs original:
 *  - sessionRef: stores the live ARSessionManager instance so components
 *    can call session.switchCamera() without prop-drilling.
 *  - currentFacingMode: 'environment' | 'user' — UI reads this to show
 *    the correct camera-flip icon.
 *  - setSessionRef / setFacingMode actions.
 *
 * All original state/actions preserved verbatim.
 */

import { create } from 'zustand';
import { DeviceClass } from '../utils/DeviceProfiler';
import { ARSessionState } from '../ARSessionManager';
import type { ARSessionManager, FacingMode } from '../ARSessionManager';

export type FallbackMode =
  | 'NONE'
  | 'PERMISSION_DENIED'
  | 'DEVICE_UNSUPPORTED'
  | 'CAMERA_ERROR';

interface ARUIState {
  modalOpen: boolean;
  hasCameraPermission: boolean;
  deviceClass: DeviceClass | null;
  arState: ARSessionState;
  activeFallbackMode: FallbackMode;
  isLoading: boolean;
  modelLoadingProgress: number;
  errorMessage: string | null;
  snapshotRef: { current: (() => string | null) | null };

  /** Live ARSessionManager — NOT serialised, used for imperative calls */
  sessionRef: ARSessionManager | null;

  /** Current camera facing mode reflected from ARSessionManager */
  currentFacingMode: FacingMode;

  ringScale: number;
}

interface ARUIActions {
  openModal: () => void;
  closeModal: () => void;
  setCameraPermission: (granted: boolean) => void;
  setDeviceClass: (deviceClass: DeviceClass) => void;
  setARState: (state: ARSessionState) => void;
  activateFallback: (mode: FallbackMode) => void;
  deactivateFallback: () => void;
  setLoading: (loading: boolean) => void;
  setModelLoadingProgress: (progress: number) => void;
  setError: (message: string | null) => void;
  reset: () => void;
  setSnapshotRef: (fn: (() => string | null) | null) => void;
  setRingScale: (scale: number) => void;

  /** Store the live ARSessionManager so any component can call switchCamera() */
  setSessionRef: (session: ARSessionManager | null) => void;

  /** Update the reflected facing mode (called after a successful switchCamera()) */
  setFacingMode: (facing: FacingMode) => void;
}

const initialState: ARUIState = {
  modalOpen: false,
  hasCameraPermission: false,
  deviceClass: null,
  arState: ARSessionState.IDLE,
  activeFallbackMode: 'NONE',
  isLoading: false,
  modelLoadingProgress: 0,
  errorMessage: null,
  snapshotRef: { current: null },
  sessionRef: null,
  currentFacingMode: 'environment',
  ringScale: 1.0,
};

export const useARStore = create<ARUIState & ARUIActions>()((set, get) => ({
  ...initialState,

  openModal: () =>
    set({ modalOpen: true, isLoading: true, errorMessage: null, activeFallbackMode: 'NONE' }),

  closeModal: () => set(initialState),

  setCameraPermission: (granted) => {
    set({ hasCameraPermission: granted });
    if (!granted) get().activateFallback('PERMISSION_DENIED');
  },

  setDeviceClass: (deviceClass) => {
    set({ deviceClass });
    if (deviceClass === 'UNSUPPORTED' || deviceClass === 'LOW') {
      get().activateFallback('DEVICE_UNSUPPORTED');
    }
  },

  setARState: (state) => {
    set({ arState: state });
    if (state === ARSessionState.ERROR) {
      set({ errorMessage: 'AR session encountered an error' });
      get().activateFallback('CAMERA_ERROR');
    }
  },

  activateFallback: (mode) =>
    set({ activeFallbackMode: mode, isLoading: false }),

  deactivateFallback: () => set({ activeFallbackMode: 'NONE' }),

  setLoading: (loading) => set({ isLoading: loading }),

  setModelLoadingProgress: (progress) => set({ modelLoadingProgress: progress }),

  setError: (message) => {
    set({
      errorMessage: message,
      arState: message ? ARSessionState.ERROR : get().arState,
    });
    if (message) get().activateFallback('CAMERA_ERROR');
  },

  reset: () => set(initialState),

  setSnapshotRef: (fn) => set({ snapshotRef: { current: fn } }),

  setRingScale: (scale) => set({ ringScale: scale }),

  setSessionRef: (session) => set({ sessionRef: session }),

  setFacingMode: (facing) => set({ currentFacingMode: facing }),
}));

// ─────────────────────────────────────────────────────────────────────────────
// Selectors
// ─────────────────────────────────────────────────────────────────────────────

export const selectModalOpen          = (s: ARUIState & ARUIActions) => s.modalOpen;
export const selectHasPermission      = (s: ARUIState & ARUIActions) => s.hasCameraPermission;
export const selectDeviceClass        = (s: ARUIState & ARUIActions) => s.deviceClass;
export const selectARState            = (s: ARUIState & ARUIActions) => s.arState;
export const selectFallbackMode       = (s: ARUIState & ARUIActions) => s.activeFallbackMode;
export const selectIsLoading          = (s: ARUIState & ARUIActions) => s.isLoading;
export const selectModelLoadingProgress=(s: ARUIState & ARUIActions) => s.modelLoadingProgress;
export const selectErrorMessage       = (s: ARUIState & ARUIActions) => s.errorMessage;
export const selectShouldShowFallback = (s: ARUIState & ARUIActions) =>
  s.activeFallbackMode !== 'NONE';
export const selectSnapshotRef        = (s: ARUIState & ARUIActions) => s.snapshotRef;
export const selectRingScale          = (s: ARUIState & ARUIActions) => s.ringScale;
export const selectSessionRef         = (s: ARUIState & ARUIActions) => s.sessionRef;
export const selectCurrentFacingMode  = (s: ARUIState & ARUIActions) => s.currentFacingMode;
