'use client';
// A Grape window on the page: the app's own markup and stylesheets as they were drawn (public/site/live, captured from
// the running app), shown at the app's size and scaled to fit - so it is sharp at any width. It is a still: nothing in
// it runs, and it takes no clicks.
import { useEffect, useRef, useState } from 'react';

const W = 1500, H = 900;

export default function LiveWindow({ view, title }) {
  const box = useRef(null);
  const [scale, setScale] = useState(0);
  useEffect(() => {
    const ro = new ResizeObserver(([entry]) => setScale(entry.contentRect.width / W));
    ro.observe(box.current);
    return () => ro.disconnect();
  }, []);
  return (
    <div className="live" ref={box} style={{ aspectRatio: `${W} / ${H}` }}>
      {scale > 0 && <iframe src={`/site/live/${view}.html`} title={title} tabIndex={-1} loading="lazy" style={{ width: W, height: H, transform: `scale(${scale})` }} />}
    </div>
  );
}
