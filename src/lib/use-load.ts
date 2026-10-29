"use client";

import { useEffect, useRef, useState } from "react";

// 载入资料并提供 reload（取代服务端的 router.refresh）。deps 变动时重新载入
export function useLoad<T>(load: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [version, setVersion] = useState(0);
  const loadRef = useRef(load);
  const key = JSON.stringify(deps);

  useEffect(() => {
    loadRef.current = load;
  });

  useEffect(() => {
    let active = true;
    loadRef
      .current()
      .then((d) => {
        if (!active) return;
        setData(d);
        setError(null);
      })
      .catch((e) => active && setError(e));
    return () => {
      active = false;
    };
  }, [key, version]);

  return { data, error, reload: () => setVersion((v) => v + 1) };
}
