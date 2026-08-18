import { useEffect, useRef, useState } from 'react';

export interface AmbientLightState {
  lux: number;
  exposure: number;
  colorTemperature: number;
  keyColor: string;
}

type AmbientLightSensorConstructor = new () => EventTarget & {
  illuminance: number | null;
  start: () => void;
  stop: () => void;
};

type SensorWindow = Window & { AmbientLightSensor?: AmbientLightSensorConstructor };

const DEFAULT_LIGHT: AmbientLightState = {
  lux: 320,
  exposure: 1.05,
  colorTemperature: 5600,
  keyColor: '#fff7e8',
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

function kelvinToHex(kelvin: number): string {
  const temp = kelvin / 100;
  const red = temp <= 66 ? 255 : clamp(329.698727446 * (temp - 60) ** -0.1332047592, 0, 255);
  const green = temp <= 66
    ? clamp(99.4708025861 * Math.log(temp) - 161.1195681661, 0, 255)
    : clamp(288.1221695283 * (temp - 60) ** -0.0755148492, 0, 255);
  const blue = temp >= 66 ? 255 : temp <= 19 ? 0 : clamp(138.5177312231 * Math.log(temp - 10) - 305.0447927307, 0, 255);

  return `#${[red, green, blue].map((channel) => Math.round(channel).toString(16).padStart(2, '0')).join('')}`;
}

function lightFromLux(lux: number): AmbientLightState {
  const normalized = clamp(Math.log10(Math.max(lux, 1)) / 4, 0, 1);
  const colorTemperature = Math.round(3200 + normalized * 3300);
  return {
    lux,
    colorTemperature,
    exposure: clamp(0.78 + normalized * 0.72, 0.78, 1.5),
    keyColor: kelvinToHex(colorTemperature),
  };
}

function luminanceToLuxApproximation(r: number, g: number, b: number): number {
  const srgbLuma = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return clamp(20 + srgbLuma ** 1.35 * 980, 20, 1000);
}

export function useAmbientLightAdapter(videoRef: React.RefObject<HTMLVideoElement | null>): AmbientLightState {
  const [light, setLight] = useState<AmbientLightState>(DEFAULT_LIGHT);
  const sensorRef = useRef<InstanceType<AmbientLightSensorConstructor> | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;
    const Sensor = (window as SensorWindow).AmbientLightSensor;

    if (Sensor) {
      try {
        const sensor = new Sensor();
        sensorRef.current = sensor;
        sensor.addEventListener('reading', () => {
          if (!cancelled && sensor.illuminance !== null) setLight(lightFromLux(sensor.illuminance));
        });
        sensor.start();
        return () => {
          cancelled = true;
          sensor.stop();
          sensorRef.current = null;
        };
      } catch {
        sensorRef.current = null;
      }
    }

    const canvas = document.createElement('canvas');
    canvas.width = 24;
    canvas.height = 24;
    const context = canvas.getContext('2d', { willReadFrequently: true });

    const sample = () => {
      const video = videoRef.current;
      if (!cancelled && context && video && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0) {
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
        let r = 0, g = 0, b = 0;
        for (let i = 0; i < data.length; i += 4) {
          r += data[i]; g += data[i + 1]; b += data[i + 2];
        }
        const pixels = data.length / 4;
        setLight(lightFromLux(luminanceToLuxApproximation(r / pixels, g / pixels, b / pixels)));
      }
      timer = window.setTimeout(sample, 750);
    };

    sample();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [videoRef]);

  return light;
}
