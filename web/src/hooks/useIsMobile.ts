import { useEffect, useState } from 'react';

// 移动端断点：与 Tailwind 的 md (768px) 对齐。
// 桌面端（>=768px）行为与改造前完全一致，移动端才走抽屉式侧边栏等适配。
export const MOBILE_BREAKPOINT = 768;

function readIsMobile() {
  if (typeof window === 'undefined') return false;
  return window.innerWidth < MOBILE_BREAKPOINT;
}

/** 视口宽度小于 768px 时返回 true，随窗口尺寸/旋转变化实时更新。 */
export function useIsMobile() {
  const [isMobile, setIsMobile] = useState(readIsMobile);

  useEffect(() => {
    const query = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
    const sync = () => setIsMobile(query.matches);
    sync();
    // Safari < 14 只有 addListener
    if (query.addEventListener) query.addEventListener('change', sync);
    else query.addListener(sync);
    return () => {
      if (query.removeEventListener) query.removeEventListener('change', sync);
      else query.removeListener(sync);
    };
  }, []);

  return isMobile;
}

export default useIsMobile;
