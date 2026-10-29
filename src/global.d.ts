import type messages from "../messages/zh-CN.json";

// 让 next-intl 检查翻译 key 是否存在（以简体中文为基准）
declare module "next-intl" {
  interface AppConfig {
    Messages: typeof messages;
  }
}
