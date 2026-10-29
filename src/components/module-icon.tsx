import {
  AppWindow, BookOpen, Building2, Calendar, Camera, ChartColumn, ClipboardList, Database, DollarSign, Factory,
  FileText, Fuel, Gauge, HardHat, Mail, Map, MessageSquare, Package, Settings, Shield, Tractor, Truck, Users, Wrench,
  type LucideIcon,
} from "lucide-react";

// 模块可选的图标（模块管理里选择；资料库存 key）
export const MODULE_ICONS: Record<string, LucideIcon> = {
  "app-window": AppWindow,
  fuel: Fuel,
  truck: Truck,
  tractor: Tractor,
  gauge: Gauge,
  wrench: Wrench,
  factory: Factory,
  "hard-hat": HardHat,
  users: Users,
  "file-text": FileText,
  chart: ChartColumn,
  calendar: Calendar,
  "clipboard-list": ClipboardList,
  database: Database,
  shield: Shield,
  settings: Settings,
  mail: Mail,
  map: Map,
  package: Package,
  "dollar-sign": DollarSign,
  building: Building2,
  "book-open": BookOpen,
  "message-square": MessageSquare,
  camera: Camera,
};

export function ModuleIcon({ name, className }: { name: string; className?: string }) {
  const Icon = MODULE_ICONS[name] ?? AppWindow;
  return <Icon className={className} aria-hidden />;
}
