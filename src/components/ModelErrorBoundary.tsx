// src/components/ModelErrorBoundary.tsx
import React, { Component, ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

/**
 * Catches errors thrown by useGLTF (404, parse failure, WebGL loss) and
 * renders a safe in-scene fallback so the camera feed keeps working.
 * Without this, a failed Suspense resource rejects the whole React tree.
 */
export class ModelErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch() {
    this.setState({ hasError: true });
  }

  render() {
    if (this.state.hasError) {
      return <FallbackRing />;
    }
    return this.props.children;
  }
}

/**
 * Renders a simple red box at the ring position so the user sees *something*
 * and the rest of the AR experience (camera + hand tracking) keeps running.
 */
function FallbackRing() {
  return (
    <mesh>
      <torusGeometry args={[0.01, 0.003, 16, 64]} />
      <meshStandardMaterial color="red" />
    </mesh>
  );
}
