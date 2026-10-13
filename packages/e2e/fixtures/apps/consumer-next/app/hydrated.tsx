'use client';
import {useEffect} from 'react';

// Effects run only once React has hydrated the page: the spec clicks after this mark.
export default function Hydrated() {
  useEffect(() => {
    document.body.dataset.hydrated = '';
  }, []);
  return null;
}
