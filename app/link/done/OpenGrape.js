'use client';
// Back to the app: grape:// brings the Grape window to the front (the app registers it). The browser asks first.
import { useEffect } from 'react';

export default function OpenGrape() {
  useEffect(() => { const t = setTimeout(() => { window.location.href = 'grape://login'; }, 400); return () => clearTimeout(t); }, []);
  return <a className="btn quiet" href="grape://login">Open Grape</a>;
}
