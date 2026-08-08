import { useCallback, useEffect, useRef } from 'react';
import type { MutableRefObject } from 'react';
import type WaveSurfer from 'wavesurfer.js';

export interface D114514BoundaryOverlayData {
  audio: {
    first_stft_center_seconds: number;
    last_stft_center_seconds: number;
  };
  image: {
    width: number;
    height: number;
  };
  boundary_paths: Array<{
    boundary_id: string;
    y_start_inclusive: number;
    x_by_y: number[];
    label?: string;
  }>;
}

interface Props {
  wavesurferRef: MutableRefObject<WaveSurfer | null>;
  isLoaded: boolean;
  waveformHeight: number;
  spectrogramHeight: number;
  data: D114514BoundaryOverlayData | null;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgElement<K extends keyof SVGElementTagNameMap>(name: K) {
  return document.createElementNS(SVG_NS, name);
}

export function D114514BoundaryOverlay({
  wavesurferRef,
  isLoaded,
  waveformHeight,
  spectrogramHeight,
  data,
}: Props) {
  const svgRef = useRef<SVGSVGElement | null>(null);

  const ensureSvgMounted = useCallback(() => {
    const wrapper = wavesurferRef.current?.getWrapper();
    if (!wrapper) return null;

    let svg = svgRef.current;
    if (!svg || svg.parentNode !== wrapper) {
      const existing = wrapper.querySelector(
        'svg[data-d114514-boundary-overlay="1"]'
      ) as SVGSVGElement | null;
      svg = existing ?? svgElement('svg');
      svg.dataset.d114514BoundaryOverlay = '1';
      svg.setAttribute('xmlns', SVG_NS);
      svg.style.position = 'absolute';
      svg.style.left = '0';
      svg.style.display = 'block';
      svg.style.pointerEvents = 'none';
      svg.style.zIndex = '5';
      wrapper.appendChild(svg);
      svgRef.current = svg;
    }
    return svg;
  }, [wavesurferRef]);

  const redraw = useCallback(() => {
    const ws = wavesurferRef.current;
    const svg = ensureSvgMounted();
    if (!ws || !svg) return;

    const wrapper = ws.getWrapper();
    const width = wrapper.scrollWidth;
    const height = spectrogramHeight;
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(height));
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.style.width = `${width}px`;
    svg.style.height = `${height}px`;
    svg.style.top = `${waveformHeight}px`;
    svg.replaceChildren();

    const duration = ws.getDuration();
    if (!data || duration <= 0 || width <= 0 || height <= 0) return;

    const sourceSpan =
      data.audio.last_stft_center_seconds -
      data.audio.first_stft_center_seconds;
    if (
      data.image.width <= 1 ||
      data.image.height <= 0 ||
      sourceSpan <= 0
    ) {
      return;
    }

    const sourceXToDisplayX = (sourceX: number) => {
      const timeSeconds =
        data.audio.first_stft_center_seconds +
        (sourceX / (data.image.width - 1)) * sourceSpan;
      return (timeSeconds / duration) * width;
    };
    const sourceYToDisplayY = (sourceY: number) =>
      (sourceY / Math.max(1, data.image.height - 1)) * height;

    for (const path of data.boundary_paths) {
      const points = path.x_by_y.flatMap((sourceX, index) => {
        if (!Number.isFinite(sourceX)) return [];
        return [
          `${sourceXToDisplayX(sourceX)},${sourceYToDisplayY(
            path.y_start_inclusive + index
          )}`,
        ];
      });
      if (points.length === 0) continue;

      const polyline = svgElement('polyline');
      polyline.setAttribute('points', points.join(' '));
      polyline.setAttribute('fill', 'none');
      polyline.setAttribute('stroke', '#ff1744');
      polyline.setAttribute('stroke-width', '2');
      polyline.setAttribute('stroke-linejoin', 'round');
      polyline.setAttribute('stroke-linecap', 'round');
      svg.appendChild(polyline);

      if (path.label) {
        const [labelX, labelY] = points[Math.floor(points.length / 2)]
          .split(',')
          .map(Number);
        const label = svgElement('text');
        label.setAttribute('x', String(labelX + 4));
        label.setAttribute('y', String(Math.max(11, labelY - 3)));
        label.setAttribute('fill', '#ff1744');
        label.setAttribute('font-size', '10');
        label.setAttribute('font-family', 'ui-monospace, monospace');
        label.setAttribute('paint-order', 'stroke');
        label.setAttribute('stroke', 'rgba(0,0,0,0.95)');
        label.setAttribute('stroke-width', '2.5');
        label.textContent = path.label;
        svg.appendChild(label);
      }
    }
  }, [data, ensureSvgMounted, spectrogramHeight, waveformHeight, wavesurferRef]);

  useEffect(() => redraw(), [isLoaded, redraw]);

  useEffect(() => {
    const ws = wavesurferRef.current;
    if (!ws || !isLoaded) return;

    const sync = () => redraw();
    const unsubscribeRedraw = ws.on('redraw', sync);
    const unsubscribeReady = ws.on('ready', sync);
    const observer = new ResizeObserver(sync);
    observer.observe(ws.getWrapper());
    return () => {
      unsubscribeRedraw();
      unsubscribeReady();
      observer.disconnect();
    };
  }, [isLoaded, redraw, wavesurferRef]);

  useEffect(() => () => {
    svgRef.current?.remove();
    svgRef.current = null;
  }, []);

  return null;
}
