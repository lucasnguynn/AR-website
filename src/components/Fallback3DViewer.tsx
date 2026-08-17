/**
 * Fallback3DViewer.tsx
 * 
 * Interactive 3D viewer using @react-three/fiber and @react-three/drei.
 * Displays the ring model when AR is unavailable or permission denied.
 * Provides a premium fallback experience with OrbitControls, Environment, and Stage.
 */

import React, { Suspense, useState, useCallback, useRef, useEffect } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls, Environment, Stage, ContactShadows, useGLTF } from '@react-three/drei';
import { FallbackMode } from '../store/useARStore';

interface Fallback3DViewerProps {
  ringModelUrl: string;
  fallbackReason: FallbackMode;
  onRetry?: () => void;
}

interface RingModelProps {
  url: string;
}

const RingModel: React.FC<RingModelProps> = ({ url }) => {
  const { scene } = useGLTF(url);
  return <primitive object={scene} />;
};

RingModel.displayName = 'RingModel';

// Dynamic preload — called when component first renders with the URL
// (Cannot be called at module level with a dynamic URL)
// @fix NEW-03: Deleted useGLTF.preload('') which fired a network request for URL '' on every page load.
// The useGLTF(url) hook inside RingModel already handles loading with built-in Suspense support.

interface ViewerSceneProps {
  ringModelUrl: string;
  orbitRef: React.MutableRefObject<any>;
}

const ViewerScene: React.FC<ViewerSceneProps> = ({ ringModelUrl, orbitRef }) => {
  return (
    <>
      {/* Lighting & Environment */}
      <Environment preset="studio" background={false} blur={0.8} />
      
      {/* Stage provides professional lighting and shadows */}
      <Stage
        environment="studio"
        intensity={0.5}
        shadows={{
          type: 'contact',
          opacity: 0.4,
          width: 2,
          height: 2,
          blur: 0.5,
          far: 0.5,
        }}
      >
        <RingModel url={ringModelUrl} />
      </Stage>
      
      {/* Additional Contact Shadows for grounding */}
      <ContactShadows
        position={[0, -0.5, 0]}
        opacity={0.3}
        scale={3}
        blur={1}
        far={2}
        resolution={256}
        color="#000000"
      />
      
      {/* Orbit Controls for interactive rotation */}
      <OrbitControls
        ref={orbitRef}
        enablePan={false}
        enableZoom={true}
        minDistance={2}
        maxDistance={6}
        minPolarAngle={Math.PI / 6}
        maxPolarAngle={Math.PI / 2}
        autoRotate={true}
        autoRotateSpeed={0.5}
        makeDefault
      />
    </>
  );
};

export const Fallback3DViewer: React.FC<Fallback3DViewerProps> = ({
  ringModelUrl,
  fallbackReason,
  onRetry,
}) => {
  const [isAutoRotating, setIsAutoRotating] = useState(true);
  const orbitRef = useRef<any>(null);

  // Preload the GLB model into useGLTF's cache as soon as this component mounts.
  // This avoids the grey-cube Suspense fallback showing after the <Canvas> initializes.
  useEffect(() => {
    useGLTF.preload(ringModelUrl);
  }, [ringModelUrl]);

  const toggleRotation = useCallback(() => {
    setIsAutoRotating((prev) => !prev);
  }, []);

  const handleResetView = useCallback(() => {
    orbitRef.current?.reset();
  }, []);

  const getFallbackMessage = () => {
    switch (fallbackReason) {
      case 'PERMISSION_DENIED':
        return {
          title: 'Camera Access Required',
          message: 'To use AR Try-On, please allow camera access in your browser settings.',
          showRetry: true,
        };
      case 'DEVICE_UNSUPPORTED':
        return {
          title: 'Device Not Supported',
          message: 'Your device doesn\'t meet the requirements for AR. Explore our 3D viewer instead.',
          showRetry: false,
        };
      case 'CAMERA_ERROR':
        return {
          title: 'Camera Unavailable',
          message: 'We couldn\'t access your camera. You can still explore the ring in 3D.',
          showRetry: true,
        };
      default:
        return {
          title: '3D Viewer',
          message: 'Interactively explore this stunning piece.',
          showRetry: false,
        };
    }
  };

  const fallbackInfo = getFallbackMessage();

  return (
    <div className="relative w-full h-full bg-gradient-to-br from-gray-900 via-gray-800 to-gray-900">
      {/* Info Banner */}
      <div className="absolute top-20 left-0 right-0 z-10 px-4">
        <div className="max-w-md mx-auto bg-black/60 backdrop-blur-md rounded-xl p-4 border border-white/10">
          <h3 className="text-white font-semibold text-center mb-1">
            {fallbackInfo.title}
          </h3>
          <p className="text-gray-300 text-sm text-center">
            {fallbackInfo.message}
          </p>
          
          {fallbackInfo.showRetry && onRetry && (
            <button
              onClick={onRetry}
              className="mt-3 w-full py-2 px-4 bg-amber-500 hover:bg-amber-600 text-white font-medium rounded-lg transition-colors"
            >
              Try AR Again
            </button>
          )}
        </div>
      </div>

      {/* 3D Canvas */}
      <div className="w-full h-full">
        <Canvas
          camera={{ position: [3, 2, 3], fov: 45 }}
          shadows
          dpr={[1, 2]}
          gl={{ antialias: true, alpha: true }}
        >
          <color attach="background" args={['#1a1a2e']} />
          <Suspense
            fallback={
              <group>
                <mesh>
                  <boxGeometry args={[0.5, 0.5, 0.5]} />
                  <meshStandardMaterial color="#4a4a6a" />
                </mesh>
              </group>
            }
          >
            <ViewerScene ringModelUrl={ringModelUrl} orbitRef={orbitRef} />
          </Suspense>
        </Canvas>
      </div>

      {/* Bottom Controls */}
      <div className="absolute bottom-6 left-0 right-0 z-10 flex justify-center gap-4 px-4">
        <button
          onClick={toggleRotation}
          className="flex items-center gap-2 px-4 py-2 bg-white/10 hover:bg-white/20 backdrop-blur-md text-white rounded-full transition-colors border border-white/20"
        >
          <svg
            className={`w-5 h-5 ${isAutoRotating ? 'animate-spin' : ''}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            style={{ animationDuration: '3s' }}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
            />
          </svg>
          <span className="text-sm font-medium">
            {isAutoRotating ? 'Stop Rotation' : 'Auto Rotate'}
          </span>
        </button>

        <button
          onClick={handleResetView}
          className="flex items-center gap-2 px-4 py-2 bg-white/10 hover:bg-white/20 backdrop-blur-md text-white rounded-full transition-colors border border-white/20"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4"
            />
          </svg>
          <span className="text-sm font-medium">Reset View</span>
        </button>
      </div>

      {/* Instructions Overlay (fades out after interaction) */}
      <div className="absolute inset-0 pointer-events-none z-0 flex items-center justify-center">
        <div className="text-white/10 text-6xl font-bold select-none">
          DRAG TO ROTATE
        </div>
      </div>
    </div>
  );
};

export default Fallback3DViewer;
