/**
 * useARStore.ts
 * 
 * Zustand store for managing AR UI state.
 * High-frequency tracking data (ring pose) is NOT stored here to prevent React tree re-renders.
 * That data is handled directly by ARSessionManager.
 */

import { create } from 'zustand';
import { DeviceClass } from '../utils/DeviceProfiler';
// @fix BUG-03: Fixed import path for ARSessionState (was './ARSessionManager', should be '../ARSessionManager')
import { ARSessionState } from '../ARSessionManager';

export type FallbackMode = 'NONE' | 'PERMISSION_DENIED' | 'DEVICE_UNSUPPORTED' | 'CAMERA_ERROR';

interface ARUIState {
  /** Whether the AR modal is open */
  modalOpen: boolean;
  
  /** User has granted camera permission */
  hasCameraPermission: boolean;
  
  /** Device classification from DeviceProfiler */
  deviceClass: DeviceClass | null;
  
  /** Current AR session state */
  arState: ARSessionState;
  
  /** Active fallback mode (true = using 3D viewer instead of AR) */
  activeFallbackMode: FallbackMode;
  
  /** Loading state for initialization */
  isLoading: boolean;
  
  /** Model loading progress (0 to 100) */
  modelLoadingProgress: number;
  
  /** Error message if any */
  errorMessage: string | null;
  
  /** Function to take a snapshot from the AR session */
  takeSnapshotFn: (() => string | null) | null;
  
  /** Ring scale for size adjustment (range: 0.5 - 2.0) */
  ringScale: number;
}

interface ARUIActions {
  /** Open the AR modal */
  openModal: () => void;
  
  /** Close the AR modal and reset state */
  closeModal: () => void;
  
  /** Set camera permission status */
  setCameraPermission: (granted: boolean) => void;
  
  /** Set device class from profiling */
  setDeviceClass: (deviceClass: DeviceClass) => void;
  
  /** Update AR session state */
  setARState: (state: ARSessionState) => void;
  
  /** Activate fallback mode */
  activateFallback: (mode: FallbackMode) => void;
  
  /** Deactivate fallback mode (return to AR) */
  deactivateFallback: () => void;
  
  /** Set loading state */
  setLoading: (loading: boolean) => void;
  
  /** Set model loading progress */
  setModelLoadingProgress: (progress: number) => void;
  
  /** Set error message */
  setError: (message: string | null) => void;
  
  /** Reset store to initial state */
  reset: () => void;
  
  /** Set the takeSnapshot function from ARSessionManager */
  setTakeSnapshotFn: (fn: (() => string | null) | null) => void;
  
  /** Set ring scale for size adjustment */
  setRingScale: (scale: number) => void;
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
  takeSnapshotFn: null,
  ringScale: 1.0,
};

export const useARStore = create<ARUIState & ARUIActions>()((set, get) => ({
  ...initialState,
  
  openModal: () => {
    set({ 
      modalOpen: true, 
      isLoading: true, 
      errorMessage: null,
      activeFallbackMode: 'NONE' 
    });
  },
  
  closeModal: () => {
    // Reset to initial state when closing
    set(initialState);
  },
  
  setCameraPermission: (granted: boolean) => {
    set({ hasCameraPermission: granted });
    
    if (!granted) {
      // Auto-activate fallback if permission denied
      get().activateFallback('PERMISSION_DENIED');
    }
  },
  
  setDeviceClass: (deviceClass: DeviceClass) => {
    set({ deviceClass });
    
    if (deviceClass === 'UNSUPPORTED') {
      // Auto-activate fallback if device unsupported
      get().activateFallback('DEVICE_UNSUPPORTED');
    }
  },
  
  setARState: (state: ARSessionState) => {
    set({ arState: state });
    
    // Handle state-specific logic
    if (state === ARSessionState.ERROR) {
      set({ errorMessage: 'AR session encountered an error' });
      get().activateFallback('CAMERA_ERROR');
    }
  },
  
  activateFallback: (mode: FallbackMode) => {
    set({ 
      activeFallbackMode: mode,
      isLoading: false, // Stop loading when fallback activates
    });
  },
  
  deactivateFallback: () => {
    set({ activeFallbackMode: 'NONE' });
  },
  
  setLoading: (loading: boolean) => {
    set({ isLoading: loading });
  },
  
  setModelLoadingProgress: (progress: number) => {
    set({ modelLoadingProgress: progress });
  },
  
  setError: (message: string | null) => {
    set({ 
      errorMessage: message,
      arState: message ? ARSessionState.ERROR : get().arState,
    });
    
    if (message) {
      get().activateFallback('CAMERA_ERROR');
    }
  },
  
  reset: () => {
    set(initialState);
  },
  
  setTakeSnapshotFn: (fn: (() => string | null) | null) => {
    set({ takeSnapshotFn: fn });
  },
  
  setRingScale: (scale: number) => {
    set({ ringScale: scale });
  },
}));

/**
 * Selectors for optimized rendering
 * Use these in components to avoid unnecessary re-renders
 */

export const selectModalOpen = (state: ARUIState & ARUIActions) => state.modalOpen;
export const selectHasPermission = (state: ARUIState & ARUIActions) => state.hasCameraPermission;
export const selectDeviceClass = (state: ARUIState & ARUIActions) => state.deviceClass;
export const selectARState = (state: ARUIState & ARUIActions) => state.arState;
export const selectFallbackMode = (state: ARUIState & ARUIActions) => state.activeFallbackMode;
export const selectIsLoading = (state: ARUIState & ARUIActions) => state.isLoading;
export const selectModelLoadingProgress = (state: ARUIState & ARUIActions) => state.modelLoadingProgress;
export const selectErrorMessage = (state: ARUIState & ARUIActions) => state.errorMessage;
export const selectShouldShowFallback = (state: ARUIState & ARUIActions) => 
  state.activeFallbackMode !== 'NONE';
export const selectTakeSnapshotFn = (state: ARUIState & ARUIActions) => state.takeSnapshotFn;
export const selectRingScale = (state: ARUIState & ARUIActions) => state.ringScale;
