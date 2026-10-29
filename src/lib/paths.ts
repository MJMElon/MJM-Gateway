// GitHub Pages 部署在子路径（例如 /MJM-Gateway）；next/link 与 router 会自动加上，
// 只有自己组网址（例如邮件回跳网址）时才需要用这个
export const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH || "";

export function absoluteUrl(path: string) {
  return `${window.location.origin}${BASE_PATH}${path}`;
}
