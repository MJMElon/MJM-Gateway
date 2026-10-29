"use client";

import { useTheme } from "next-themes";
import { useEffect, useRef } from "react";

// 登录后套用资料库里的主题设定（换装置时也一致）；只在设定值改变时套用
export function ThemeSync({ theme }: { theme: string }) {
  const { setTheme } = useTheme();
  const setThemeRef = useRef(setTheme);

  useEffect(() => {
    setThemeRef.current = setTheme;
  });

  useEffect(() => {
    setThemeRef.current(theme);
  }, [theme]);

  return null;
}
