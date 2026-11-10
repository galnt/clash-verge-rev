import { useLayoutEffect, useState } from 'react'

export const useWindowWidth = () => {
  const [width, setWidth] = useState(() => window.innerWidth)

  useLayoutEffect(() => {
    const measure = () => {
      const next = document.body.clientWidth || window.innerWidth
      setWidth((prev) => (prev === next ? prev : next))
    }

    // ResizeObserver 的首次回调会在本帧绘制前送达，覆盖首帧估算值
    const observer = new ResizeObserver(measure)
    observer.observe(document.body)
    observer.observe(document.documentElement)
    window.addEventListener('resize', measure)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [])

  return { width }
}
