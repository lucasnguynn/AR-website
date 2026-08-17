import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
<App />
)

// HỦY BẪY DOM MÀN HÌNH TRẮNG
// Sau khi React mount thành công, DOM element này sẽ bị xóa bỏ
const loadingElement = document.getElementById('loading');
if (loadingElement) {
  // Tạo độ trễ 500ms để hiệu ứng UI chuyển cảnh mượt mà
  setTimeout(() => {
    loadingElement.style.opacity = '0';
    setTimeout(() => loadingElement.remove(), 500);
  }, 500);
}
