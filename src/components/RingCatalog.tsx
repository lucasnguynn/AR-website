/**
 * RingCatalog.tsx
 *
 * Horizontal scrollable ring selector strip for the AR try-on experience.
 * Displays thumbnails and allows users to swap between different ring models.
 */

import React, { useState } from 'react';

export interface RingItem {
  id: string;
  name: string;
  modelUrl: string;
  thumbnailUrl?: string;
  material?: string;
  price?: string;
}

// TODO [PRODUCTION]: Replace all modelUrl values below with your brand's actual ring .glb files.
// Naming convention: /models/{ring-id}.glb (place files in the /public/models/ directory).
// Each model must be exported with:
//   - Origin at the ring's bore center (geometric center of the inner circle)
//   - Y-axis pointing "up" through the bore (perpendicular to the ring plane)
//   - Scale: 1 unit = 1 mm (standard jewellery CAD convention)
// TODO [PRODUCTION]: Add real thumbnail images (400×400 WebP, transparent bg) for each ring.

// FIX: Use import.meta.env.BASE_URL for GitHub Pages subpath resolution
const BASE_PATH = import.meta.env.BASE_URL;

export const DEFAULT_CATALOG: RingItem[] = [
  {
    id: 'custom-ring-1',
    name: 'Custom Ring 1',
    // Sử dụng BASE_PATH kết hợp với thư mục models (viết thường)
    modelUrl: `${BASE_PATH}models/nhan.glb`,
    // Xóa BASE_PATH ở thumbnail nếu bạn chưa có ảnh, tránh lỗi 404 hình ảnh
    thumbnailUrl: '', 
    material: 'Silver 930 from Progold (Italy)',
    price: '5.000.000 ₫',
  }
];

interface RingCatalogProps {
  onSelectRing: (modelUrl: string) => void;
}

const RingCatalog: React.FC<RingCatalogProps> = ({ onSelectRing }) => {
  const [selectedId, setSelectedId] = useState<string>(DEFAULT_CATALOG[0].id);

  const handleSelect = (item: RingItem) => {
    setSelectedId(item.id);
    onSelectRing(item.modelUrl);
  };

  return (
    <div
      className="absolute bottom-0 left-0 right-0 z-20 h-[80px] bg-black/40 backdrop-blur-md overflow-x-auto overflow-y-hidden"
      style={{ pointerEvents: 'auto' }}
    >
      <div className="flex items-center gap-3 px-4 py-2 h-full">
        {DEFAULT_CATALOG.map((item) => {
          const isSelected = selectedId === item.id;
          return (
            <button
              key={item.id}
              onClick={() => handleSelect(item)}
              className={`
                flex-shrink-0 flex flex-col items-center gap-1
                p-2 rounded-lg transition-all duration-150
                ${isSelected ? 'ring-2 ring-brand-neon bg-white/10' : 'hover:bg-white/5'}
              `}
              style={{ minWidth: '70px' }}
            >
              {/* Thumbnail or placeholder circle */}
              {item.thumbnailUrl ? (
                <img
                  src={item.thumbnailUrl}
                  alt={item.name}
                  className="w-10 h-10 rounded-full object-cover"
                />
              ) : (
                <div
                  className="w-10 h-10 rounded-full bg-gradient-to-br from-brand-neon/30 to-brand-neon/10 border border-brand-neon/40"
                />
              )}
              <span className="text-white/90 text-xs font-medium truncate max-w-[80px]">
                {item.name.split(' ')[0]}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
};

export default RingCatalog;
