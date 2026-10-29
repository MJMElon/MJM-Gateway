export type Role = "super_admin" | "admin" | "user";
export type CardSize = "large" | "small" | "list";

export type Profile = {
  id: string;
  email: string;
  full_name: string;
  department_id: string | null;
  role: Role;
  status: "active" | "disabled";
  must_change_password: boolean;
  locale: string;
  theme: "light" | "dark" | "system";
  layout_initialized: boolean;
};

export type HomeModule = {
  id: string;
  code: string;
  name: string;
  icon: string;
  url: string;
  description: string | null;
  category: string | null;
  access_level: 1 | 2 | 3;
  open_mode: "new_tab" | "same_tab";
  is_new: boolean;
};

export type Folder = {
  id: string;
  name: string;
  color: string;
  sort_order: number;
  collapsed: boolean;
};

export type LayoutItem = {
  module_id: string;
  folder_id: string | null;
  sort_order: number;
  card_size: CardSize;
};

export type HomeData = {
  profile: { id: string; email: string; full_name: string; role: Role; department: string | null; layout_initialized: boolean };
  modules: HomeModule[];
  folders: Folder[];
  layout: LayoutItem[];
  recent: string[];
  announcements: { id: string; message: string; level: "info" | "warning" }[];
};

export type Department = { id: string; code: string; name: string };
export type Group = { id: string; name: string; description: string | null; department_id: string | null; sort_order: number };
export type Module = {
  id: string;
  code: string;
  name: string;
  icon: string;
  url: string;
  description: string | null;
  category: string | null;
  access_level: 1 | 2 | 3;
  is_active: boolean;
  open_mode: "new_tab" | "same_tab";
  department_id: string | null;
  sort_order: number;
};
