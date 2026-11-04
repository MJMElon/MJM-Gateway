// AI 助手可以查询的资料集（白名单）。
// 每个资料集 = 一个 Gateway 自己的表 + 要带出来的栏位；查询一律用「调用者自己的身份」，
// 所以数据库的权限（RLS）照常生效：看不到的资料，AI 也看不到。
// 不开放原本就在用的其他系统表（workrecords_*、machinery_*）和用户名单。

export type Col = { name: string; type: "text" | "number" | "date"; desc: string };
export type Dataset = {
  name: string;
  description: string;
  table: string;
  select: string;
  order: string;
  columns: Col[];
  flatten: (row: any) => Record<string, unknown>;
};

const num = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));
const one = (v: any) => (Array.isArray(v) ? v[0] : v) ?? {};

export const DATASETS: Dataset[] = [
  {
    name: "diesel_claims",
    description: "Diesel receipt claims: who filled which vehicle, when, litres, amount (RM), status (pending / approved / rejected / paid).",
    table: "diesel_claims",
    select: "fill_date, odometer_km, litres, amount, station, status, review_note, vehicle:diesel_vehicles!vehicle_id(plate_no, name), claimant:gw_profiles!claimant_id(full_name)",
    order: "fill_date",
    columns: [
      { name: "date", type: "date", desc: "Fill date (YYYY-MM-DD)" },
      { name: "plate_no", type: "text", desc: "Vehicle plate number" },
      { name: "vehicle", type: "text", desc: "Vehicle name" },
      { name: "claimant", type: "text", desc: "Person who submitted the claim" },
      { name: "odometer_km", type: "number", desc: "Odometer reading" },
      { name: "litres", type: "number", desc: "Litres filled" },
      { name: "amount_rm", type: "number", desc: "Claim amount in RM" },
      { name: "price_per_litre_rm", type: "number", desc: "RM per litre" },
      { name: "station", type: "text", desc: "Fuel station" },
      { name: "status", type: "text", desc: "pending, approved, rejected or paid" },
      { name: "review_note", type: "text", desc: "Reviewer note" },
    ],
    flatten: (r) => {
      const litres = num(r.litres);
      const amount = num(r.amount);
      return {
        date: r.fill_date,
        plate_no: one(r.vehicle).plate_no ?? null,
        vehicle: one(r.vehicle).name ?? null,
        claimant: one(r.claimant).full_name ?? null,
        odometer_km: num(r.odometer_km),
        litres,
        amount_rm: amount,
        price_per_litre_rm: litres && amount !== null ? Math.round((amount / litres) * 100) / 100 : null,
        station: r.station ?? null,
        status: r.status,
        review_note: r.review_note ?? null,
      };
    },
  },
  {
    name: "diesel_vehicles",
    description: "Vehicles and machinery in the Diesel module: plate, type, tank size, driver, business and company.",
    table: "diesel_vehicles",
    select: "plate_no, name, vehicle_type, fuel_type, tank_capacity_l, status, notes, driver:gw_profiles!driver_id(full_name), business:gw_groups!group_id(name), company:gw_companies!company_id(name)",
    order: "plate_no",
    columns: [
      { name: "plate_no", type: "text", desc: "Plate number" },
      { name: "name", type: "text", desc: "Vehicle name" },
      { name: "vehicle_type", type: "text", desc: "pickup, lorry, machinery ..." },
      { name: "fuel_type", type: "text", desc: "Fuel type" },
      { name: "tank_capacity_l", type: "number", desc: "Tank capacity in litres" },
      { name: "driver", type: "text", desc: "Assigned driver" },
      { name: "business", type: "text", desc: "Business" },
      { name: "company", type: "text", desc: "Company" },
      { name: "status", type: "text", desc: "active or inactive" },
    ],
    flatten: (r) => ({
      plate_no: r.plate_no,
      name: r.name,
      vehicle_type: r.vehicle_type,
      fuel_type: r.fuel_type,
      tank_capacity_l: num(r.tank_capacity_l),
      driver: one(r.driver).full_name ?? null,
      business: one(r.business).name ?? null,
      company: one(r.company).name ?? null,
      status: r.status,
    }),
  },
  {
    name: "diesel_cards",
    description: "Fleet cards: card number, provider, monthly limit, status and the vehicle it belongs to.",
    table: "diesel_cards",
    select: "card_no, provider, monthly_limit, status, notes, vehicle:diesel_vehicles!vehicle_id(plate_no)",
    order: "card_no",
    columns: [
      { name: "card_no", type: "text", desc: "Card number" },
      { name: "provider", type: "text", desc: "Card provider" },
      { name: "plate_no", type: "text", desc: "Vehicle the card is for" },
      { name: "monthly_limit_rm", type: "number", desc: "Monthly limit in RM" },
      { name: "status", type: "text", desc: "active or inactive" },
    ],
    flatten: (r) => ({ card_no: r.card_no, provider: r.provider, plate_no: one(r.vehicle).plate_no ?? null, monthly_limit_rm: num(r.monthly_limit), status: r.status }),
  },
  {
    name: "diesel_card_reloads",
    description: "Fleet card reloads (top-ups): date, amount in RM, reference.",
    table: "diesel_card_reloads",
    select: "reload_date, amount, reference, notes, card:diesel_cards!card_id(card_no, provider)",
    order: "reload_date",
    columns: [
      { name: "date", type: "date", desc: "Reload date" },
      { name: "card_no", type: "text", desc: "Card number" },
      { name: "provider", type: "text", desc: "Card provider" },
      { name: "amount_rm", type: "number", desc: "Reload amount in RM" },
      { name: "reference", type: "text", desc: "Reference" },
    ],
    flatten: (r) => ({ date: r.reload_date, card_no: one(r.card).card_no ?? null, provider: one(r.card).provider ?? null, amount_rm: num(r.amount), reference: r.reference ?? null }),
  },
  {
    name: "diesel_card_usage",
    description: "Fleet card usage by driver and vehicle: date, litres, amount in RM, station.",
    table: "diesel_card_usage",
    select: "fill_date, odometer_km, litres, amount, station, card:diesel_cards!card_id(card_no), vehicle:diesel_vehicles!vehicle_id(plate_no), driver:gw_profiles!driver_id(full_name)",
    order: "fill_date",
    columns: [
      { name: "date", type: "date", desc: "Fill date" },
      { name: "card_no", type: "text", desc: "Card number" },
      { name: "plate_no", type: "text", desc: "Vehicle plate" },
      { name: "driver", type: "text", desc: "Driver" },
      { name: "odometer_km", type: "number", desc: "Odometer" },
      { name: "litres", type: "number", desc: "Litres" },
      { name: "amount_rm", type: "number", desc: "Amount in RM" },
      { name: "station", type: "text", desc: "Station" },
    ],
    flatten: (r) => ({
      date: r.fill_date,
      card_no: one(r.card).card_no ?? null,
      plate_no: one(r.vehicle).plate_no ?? null,
      driver: one(r.driver).full_name ?? null,
      odometer_km: num(r.odometer_km),
      litres: num(r.litres),
      amount_rm: num(r.amount),
      station: r.station ?? null,
    }),
  },
  {
    name: "businesses",
    description: "Business lines (groups) in the company.",
    table: "gw_groups",
    select: "name, code, description",
    order: "name",
    columns: [
      { name: "code", type: "text", desc: "Business code" },
      { name: "name", type: "text", desc: "Business name" },
      { name: "description", type: "text", desc: "Description" },
    ],
    flatten: (r) => ({ code: r.code ?? null, name: r.name, description: r.description ?? null }),
  },
  {
    name: "companies",
    description: "Companies (legal entities) with code and registration number.",
    table: "gw_companies",
    select: "code, name, short_name, registration_no, description",
    order: "name",
    columns: [
      { name: "code", type: "text", desc: "Company code" },
      { name: "name", type: "text", desc: "Company name" },
      { name: "short_name", type: "text", desc: "Short name" },
      { name: "registration_no", type: "text", desc: "Registration number" },
    ],
    flatten: (r) => ({ code: r.code ?? null, name: r.name, short_name: r.short_name ?? null, registration_no: r.registration_no ?? null }),
  },
  {
    name: "modules",
    description: "Systems (modules) available in MJM Intranet.",
    table: "gw_modules",
    select: "code, name, kind, description, is_active",
    order: "name",
    columns: [
      { name: "code", type: "text", desc: "Module code" },
      { name: "name", type: "text", desc: "Module name" },
      { name: "kind", type: "text", desc: "system or link" },
      { name: "description", type: "text", desc: "Description" },
      { name: "active", type: "text", desc: "true or false" },
    ],
    flatten: (r) => ({ code: r.code, name: r.name, kind: r.kind, description: r.description ?? null, active: String(!!r.is_active) }),
  },
];

export const byName = (name: string) => DATASETS.find((d) => d.name === name);
