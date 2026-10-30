/* ================================================================
   MJM Connect — Diesel 模块（车辆、加油报销、收据）
   分页：我的报销（所有有 Access 的人）、车辆、全部报销（审核）、统计（管理者）
   权限都在数据库：diesel_can_use() = 有 DIESEL 的 Access；diesel_is_admin() = DIESEL 的 Admin / 负责的角色 / super_admin
   收据照片先在手机上压缩，再上传到私有 bucket diesel-receipts/<自己的 id>/
   ================================================================ */
(async function () {
  const { sb, t, esc, $, $$, icon, cls, btn, badge, alertBox, modal, confirmDialog, toast, refreshIcons } = GW;
  const td = (k, v) => t("diesel." + k, v);
  const me = await GW.requireProfile("user");
  if (!me) return;
  const main = GW.shell(me, "diesel");
  main.innerHTML = GW.spinner();

  const [{ data: canUse }, { data: isAdmin }] = await Promise.all([sb.rpc("diesel_can_use"), sb.rpc("diesel_is_admin")]);
  if (!canUse) {
    main.innerHTML = `<div class="mx-auto mt-[12vh] max-w-md rounded-3xl border border-slate-200 bg-white p-8 text-center dark:border-slate-800 dark:bg-slate-900">
      <span class="mx-auto mb-4 flex size-14 items-center justify-center rounded-full bg-amber-100 text-amber-600 dark:bg-amber-900/40 dark:text-amber-300">${icon("lock", "size-7")}</span>
      <h2 class="text-lg font-semibold">${esc(td("noAccessTitle"))}</h2>
      <p class="mt-2 text-sm text-slate-500">${esc(td("noAccessBody"))}</p>
      <a href="${GW.BASE}index.html" class="${btn("secondary")} mt-5">${icon("arrow-left")} ${esc(t("admin.backToPortal"))}</a>
    </div>`;
    return refreshIcons();
  }

  const TABS = ["mine", "vehicles", ...(isAdmin ? ["claims", "summary"] : [])];
  const STATUS_TONE = { pending: "amber", approved: "green", rejected: "red", paid: "blue" };
  const money = (n) => "RM " + Number(n || 0).toLocaleString(GW.LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const num = (n, d = 1) => Number(n || 0).toLocaleString(GW.LOCALE, { maximumFractionDigits: d });
  const day = (d) => new Intl.DateTimeFormat(GW.LOCALE, { day: "numeric", month: "short", year: "numeric" }).format(new Date(d + "T00:00:00"));
  const today = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  const statusBadge = (s) => badge(td("status." + s), STATUS_TONE[s]);
  const field = (label, input, hint) =>
    `<label class="block space-y-1.5"><span class="${cls.label}">${esc(label)}</span>${input}${hint ? `<span class="block text-xs text-slate-500">${esc(hint)}</span>` : ""}</label>`;
  const empty = (text) => `<div class="${cls.empty}">${esc(text)}</div>`;

  main.innerHTML = `<div class="space-y-5">
    <div class="relative flex min-h-10 flex-col items-center gap-2 sm:flex-row sm:justify-center">
      <a href="${GW.BASE}index.html" class="inline-flex items-center gap-1 self-start text-sm text-slate-500 hover:text-slate-800 sm:absolute sm:left-0 sm:self-auto dark:hover:text-slate-200">${icon("arrow-left")} ${esc(t("admin.backToPortal"))}</a>
      <h1 class="flex items-center gap-2 text-xl font-semibold sm:text-2xl">${icon("fuel", "size-6 text-brand-600")}${esc(td("title"))}</h1>
    </div>
    <div class="-mx-4 overflow-x-auto px-4 sm:text-center">
      <nav id="tabs" class="inline-flex min-w-max gap-1 rounded-xl bg-slate-200/70 p-1 dark:bg-slate-800"></nav>
    </div>
    <div id="view"></div>
  </div>`;
  const view = $("#view");
  let routeSeq = 0;
  const stale = (seq) => seq !== routeSeq;

  // ---------------------------------------------------------------- 共用资料
  async function loadVehicles() {
    const { data } = await sb.from("diesel_vehicles").select("*").order("plate_no");
    return data || [];
  }
  async function loadClaims(filter) {
    let q = sb.from("diesel_claims").select("*").order("fill_date", { ascending: false }).order("created_at", { ascending: false });
    if (filter && filter.mine) q = q.eq("claimant_id", me.id);
    if (filter && filter.from) q = q.gte("fill_date", filter.from);
    if (filter && filter.to) q = q.lte("fill_date", filter.to);
    const { data } = await q.limit(2000);
    return data || [];
  }
  async function loadPeople() {
    // 管理者看得到用户名单（Gateway 规则：有管理权就看得到）；一般用户只看得到自己
    const { data } = await sb.from("gw_profiles").select("id, full_name, email").order("full_name");
    return data || [];
  }
  const vehicleLabel = (v) => (v ? v.plate_no + (v.name ? " · " + v.name : "") : "—");

  // 收据：私有档案用 60 秒的签名网址打开
  async function openReceipt(path) {
    const { data, error } = await sb.storage.from("diesel-receipts").createSignedUrl(path, 60);
    if (error || !data) return toast(td("receiptFailed"));
    window.open(data.signedUrl, "_blank", "noopener");
  }

  // 手机照片压缩成最长 1600px 的 JPEG（PDF 原样上传）
  async function compress(file) {
    if (!file.type.startsWith("image/")) return file;
    try {
      const bmp = await createImageBitmap(file);
      const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(bmp.width * scale);
      canvas.height = Math.round(bmp.height * scale);
      canvas.getContext("2d").drawImage(bmp, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.82));
      return blob ? new File([blob], "receipt.jpg", { type: "image/jpeg" }) : file;
    } catch (e) {
      return file;
    }
  }

  // ---------------------------------------------------------------- 新增 / 修改报销
  async function claimDialog(claim, onSaved) {
    const vehicles = (await loadVehicles()).filter((v) => v.status === "active" || (claim && v.id === claim.vehicle_id));
    if (!vehicles.length) return toast(td("noVehicles"));
    const mineFirst = vehicles.find((v) => v.driver_id === me.id);
    const c = claim || { vehicle_id: (mineFirst || vehicles[0]).id, fill_date: today(), odometer_km: "", litres: "", amount: "", station: "", notes: "" };
    const m = modal(
      claim ? td("editClaim") : td("newClaim"),
      `<form class="space-y-4">
        <div data-err></div>
        ${field(td("vehicle"), `<select name="vehicle_id" required class="${cls.input}">${vehicles.map((v) => `<option value="${v.id}" ${v.id === c.vehicle_id ? "selected" : ""}>${esc(vehicleLabel(v))}</option>`).join("")}</select>`)}
        <div class="grid grid-cols-2 gap-3">
          ${field(td("fillDate"), `<input name="fill_date" type="date" required max="${today()}" value="${esc(c.fill_date)}" class="${cls.input}">`)}
          ${field(td("odometer"), `<input name="odometer_km" type="number" inputmode="numeric" min="0" step="1" value="${esc(c.odometer_km ?? "")}" placeholder="km" class="${cls.input}">`)}
          ${field(td("litres"), `<input name="litres" type="number" inputmode="decimal" min="0.01" step="0.01" required value="${esc(c.litres)}" class="${cls.input}">`)}
          ${field(td("amount"), `<input name="amount" type="number" inputmode="decimal" min="0" step="0.01" required value="${esc(c.amount)}" placeholder="RM" class="${cls.input}">`)}
        </div>
        <p data-ppl class="-mt-2 text-xs text-slate-500"></p>
        ${field(td("station"), `<input name="station" maxlength="120" value="${esc(c.station || "")}" placeholder="${esc(td("stationPlaceholder"))}" class="${cls.input}">`)}
        ${field(
          td("receipt"),
          `<input name="receipt" type="file" accept="image/*,application/pdf" capture="environment" ${claim ? "" : "required"} class="${cls.input} h-auto py-2">`,
          claim && claim.receipt_path ? td("receiptKeep") : td("receiptHint"),
        )}
        ${field(td("notes"), `<textarea name="notes" maxlength="500" rows="2" class="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-brand-500 dark:border-slate-700 dark:bg-slate-900">${esc(c.notes || "")}</textarea>`)}
        <div class="flex justify-end gap-2">
          <button type="button" data-cancel class="${btn("secondary")}">${esc(td("cancel"))}</button>
          <button type="submit" class="${btn("primary")}">${esc(claim ? td("save") : td("submit"))}</button>
        </div>
      </form>`,
    );
    const f = $("form", m.el);
    const ppl = () => {
      const l = Number(f.litres.value), a = Number(f.amount.value);
      $("[data-ppl]", m.el).textContent = l > 0 && a > 0 ? td("pricePerLitre", { price: money(a / l) }) : "";
    };
    f.litres.addEventListener("input", ppl);
    f.amount.addEventListener("input", ppl);
    ppl();
    $("[data-cancel]", m.el).onclick = m.close;
    f.addEventListener("submit", async (e) => {
      e.preventDefault();
      const fail = (k) => (($("[data-err]", m.el).innerHTML = alertBox(td(k))), (submit.disabled = false));
      const submit = $("button[type=submit]", f);
      submit.disabled = true;
      const row = {
        vehicle_id: f.vehicle_id.value,
        fill_date: f.fill_date.value,
        odometer_km: f.odometer_km.value === "" ? null : Number(f.odometer_km.value),
        litres: Number(f.litres.value),
        amount: Number(f.amount.value),
        station: f.station.value.trim() || null,
        notes: f.notes.value.trim() || null,
      };
      // 里程比这台车上一次的读数小：提醒一下（可能输入错）
      if (row.odometer_km != null) {
        const { data: prev } = await sb
          .from("diesel_claims")
          .select("odometer_km")
          .eq("vehicle_id", row.vehicle_id)
          .lt("fill_date", row.fill_date)
          .not("odometer_km", "is", null)
          .order("fill_date", { ascending: false })
          .limit(1);
        if (prev && prev[0] && prev[0].odometer_km > row.odometer_km && !(await confirmDialog(td("odometerCheckTitle"), td("odometerCheckBody", { last: num(prev[0].odometer_km, 0) }), td("submitAnyway"), td("cancel")))) {
          return (submit.disabled = false);
        }
      }
      const file = f.receipt.files[0];
      if (file) {
        const upload = await compress(file);
        if (upload.size > 10 * 1024 * 1024) return fail("receiptTooBig");
        const ext = upload.type === "application/pdf" ? "pdf" : upload.type === "image/png" ? "png" : upload.type === "image/webp" ? "webp" : "jpg";
        const path = `${me.id}/${crypto.randomUUID()}.${ext}`;
        const { error } = await sb.storage.from("diesel-receipts").upload(path, upload, { contentType: upload.type });
        if (error) return fail("uploadFailed");
        row.receipt_path = path;
      }
      const { error } = claim
        ? await sb.from("diesel_claims").update(row).eq("id", claim.id)
        : await sb.from("diesel_claims").insert({ ...row, claimant_id: me.id });
      if (error) {
        if (row.receipt_path) sb.storage.from("diesel-receipts").remove([row.receipt_path]);
        return fail("saveFailed");
      }
      if (claim && row.receipt_path && claim.receipt_path && claim.receipt_path.startsWith(me.id + "/")) sb.storage.from("diesel-receipts").remove([claim.receipt_path]);
      m.close();
      toast(claim ? td("saved") : td("submitted"));
      onSaved();
    });
  }

  const claimRow = (c, v, extra) => `<div class="flex flex-col gap-2 p-4 sm:flex-row sm:items-center">
      <div class="min-w-0 flex-1">
        <div class="flex flex-wrap items-center gap-2">
          <span class="font-medium">${esc(vehicleLabel(v))}</span>${statusBadge(c.status)}
        </div>
        <div class="mt-0.5 text-sm text-slate-500">${esc(day(c.fill_date))} · ${num(c.litres, 2)} L · <span class="font-medium text-slate-700 dark:text-slate-200">${money(c.amount)}</span>${c.odometer_km != null ? " · " + num(c.odometer_km, 0) + " km" : ""}${c.station ? " · " + esc(c.station) : ""}</div>
        ${extra || ""}
        ${c.review_note ? `<div class="mt-1 text-xs text-slate-500">${icon("message-square", "inline size-3")} ${esc(c.review_note)}</div>` : ""}
      </div>
      <div data-actions="${c.id}" class="flex flex-wrap gap-1.5"></div>
    </div>`;

  // ================================================================ 我的报销
  async function mineTab() {
    const seq = routeSeq;
    const [claims, vehicles] = await Promise.all([loadClaims({ mine: true }), loadVehicles()]);
    if (stale(seq)) return;
    const vById = new Map(vehicles.map((v) => [v.id, v]));
    const month = today().slice(0, 7);
    const thisMonth = claims.filter((c) => c.fill_date.startsWith(month) && c.status !== "rejected");
    view.innerHTML = `<div class="space-y-4">
      <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
        ${[
          [td("statPending"), claims.filter((c) => c.status === "pending").length],
          [td("statThisMonthLitres"), num(thisMonth.reduce((s, c) => s + Number(c.litres), 0)) + " L"],
          [td("statThisMonthAmount"), money(thisMonth.reduce((s, c) => s + Number(c.amount), 0))],
          [td("statApprovedUnpaid"), money(claims.filter((c) => c.status === "approved").reduce((s, c) => s + Number(c.amount), 0))],
        ]
          .map(([k, v]) => `<div class="${cls.card} p-3"><div class="text-xs text-slate-500">${esc(k)}</div><div class="mt-1 text-lg font-semibold">${esc(String(v))}</div></div>`)
          .join("")}
      </div>
      <div class="flex items-center justify-between gap-2">
        <h2 class="font-semibold">${esc(td("myClaims"))}</h2>
        <button id="new-claim" class="${btn("primary")}">${icon("plus")} ${esc(td("newClaim"))}</button>
      </div>
      ${
        claims.length
          ? `<div class="${cls.card} divide-y divide-slate-200 dark:divide-slate-800">${claims.map((c) => claimRow(c, vById.get(c.vehicle_id))).join("")}</div>`
          : empty(td("noClaims"))
      }
    </div>`;
    claims.forEach((c) => {
      const box = $(`[data-actions="${c.id}"]`, view);
      box.innerHTML = `${c.receipt_path ? `<button data-receipt="${esc(c.receipt_path)}" class="${btn("ghost", "sm")}">${icon("receipt")} ${esc(td("receipt"))}</button>` : ""}
        ${
          c.status === "pending"
            ? `<button data-edit="${c.id}" class="${btn("ghost", "sm")}">${icon("pencil")} ${esc(td("edit"))}</button>
               <button data-del="${c.id}" class="${btn("ghost", "sm")} text-red-600 dark:text-red-400">${icon("trash-2")}</button>`
            : ""
        }`;
    });
    refreshIcons();
    view.onclick = async (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      if (b.id === "new-claim") return claimDialog(null, mineTab);
      if (b.dataset.receipt) return openReceipt(b.dataset.receipt);
      const c = claims.find((x) => x.id === (b.dataset.edit || b.dataset.del));
      if (!c) return;
      if (b.dataset.edit) return claimDialog(c, mineTab);
      if (!(await confirmDialog(td("deleteTitle"), td("deleteBody"), td("delete"), td("cancel")))) return;
      const { error } = await sb.from("diesel_claims").delete().eq("id", c.id);
      if (error) return toast(td("saveFailed"));
      if (c.receipt_path) sb.storage.from("diesel-receipts").remove([c.receipt_path]);
      mineTab();
    };
  }

  // ================================================================ 车辆
  async function vehiclesTab() {
    const seq = routeSeq;
    const month = today().slice(0, 7);
    const [vehicles, claims, people, groups, companies] = await Promise.all([
      loadVehicles(),
      isAdmin ? loadClaims({ from: month + "-01" }) : Promise.resolve([]),
      isAdmin ? loadPeople() : Promise.resolve([]),
      isAdmin ? sb.from("gw_groups").select("id, name").order("name").then((r) => r.data || []) : Promise.resolve([]),
      isAdmin ? sb.from("gw_companies").select("id, group_id, name").order("name").then((r) => r.data || []) : Promise.resolve([]),
    ]);
    if (stale(seq)) return;
    const person = new Map(people.map((p) => [p.id, p]));
    const groupName = new Map(groups.map((g) => [g.id, g.name]));
    const companyName = new Map(companies.map((c) => [c.id, c.name]));
    let query = "";

    function draw() {
      const q = query.trim().toLowerCase();
      const list = vehicles.filter((v) => !q || (v.plate_no + " " + (v.name || "")).toLowerCase().includes(q));
      view.innerHTML = `<div class="space-y-4">
        <div class="flex flex-col gap-2 sm:flex-row">
          <input id="veh-q" type="search" value="${esc(query)}" placeholder="${esc(td("searchVehicle"))}" class="${cls.input} sm:max-w-xs">
          <div class="flex-1"></div>
          ${isAdmin ? `<button id="veh-add" class="${btn("primary")}">${icon("plus")} ${esc(td("addVehicle"))}</button>` : ""}
        </div>
        ${
          list.length
            ? `<div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">${list
                .map((v) => {
                  const mc = claims.filter((c) => c.vehicle_id === v.id && c.status !== "rejected");
                  const drv = person.get(v.driver_id);
                  return `<div class="${cls.card} p-4 ${v.status === "inactive" ? "opacity-60" : ""}">
                    <div class="flex items-start gap-3">
                      <span class="flex size-10 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-600 dark:bg-brand-700/20 dark:text-brand-100">${icon(v.vehicle_type === "lorry" ? "truck" : v.vehicle_type === "machinery" ? "tractor" : v.vehicle_type === "motorcycle" ? "bike" : "car", "size-5")}</span>
                      <div class="min-w-0 flex-1">
                        <div class="flex flex-wrap items-center gap-2"><span class="font-semibold tracking-wide">${esc(v.plate_no)}</span>${v.status === "inactive" ? badge(td("inactive")) : ""}</div>
                        <div class="text-sm text-slate-500">${esc([v.name, td("types." + v.vehicle_type), td("fuels." + v.fuel_type)].filter(Boolean).join(" · "))}</div>
                        ${isAdmin ? `<div class="mt-1 text-xs text-slate-500">${esc([groupName.get(v.group_id), companyName.get(v.company_id), drv ? td("driverIs", { name: drv.full_name }) : null].filter(Boolean).join(" · ") || td("unassigned"))}</div>` : ""}
                      </div>
                      ${isAdmin ? `<button data-edit="${v.id}" aria-label="${esc(td("edit"))}" class="${btn("ghost", "sm")}">${icon("pencil")}</button>` : ""}
                    </div>
                    ${
                      isAdmin
                        ? `<div class="mt-3 grid grid-cols-3 gap-2 rounded-xl bg-slate-50 p-2 text-center dark:bg-white/5">
                            <div><div class="text-[11px] text-slate-500">${esc(td("thisMonth"))}</div><div class="text-sm font-semibold">${num(mc.reduce((s, c) => s + Number(c.litres), 0))} L</div></div>
                            <div><div class="text-[11px] text-slate-500">${esc(td("amount"))}</div><div class="text-sm font-semibold">${money(mc.reduce((s, c) => s + Number(c.amount), 0))}</div></div>
                            <div><div class="text-[11px] text-slate-500">${esc(td("claimsCount"))}</div><div class="text-sm font-semibold">${mc.length}</div></div>
                          </div>`
                        : ""
                    }
                  </div>`;
                })
                .join("")}</div>`
            : empty(td(vehicles.length ? "noMatch" : "noVehicles"))
        }
      </div>`;
      refreshIcons();
      $("#veh-q").addEventListener("input", (e) => {
        query = e.target.value;
        const pos = e.target.selectionStart;
        draw();
        const input = $("#veh-q");
        input.focus();
        input.setSelectionRange(pos, pos);
      });
    }

    function vehicleDialog(v) {
      const x = v || { plate_no: "", name: "", vehicle_type: "pickup", fuel_type: "diesel", tank_capacity_l: "", group_id: null, company_id: null, driver_id: null, status: "active", notes: "" };
      const opt = (list, value, blank) => `${blank ? `<option value="">${esc(blank)}</option>` : ""}${list.map(([k, l]) => `<option value="${esc(k)}" ${k === value ? "selected" : ""}>${esc(l)}</option>`).join("")}`;
      const m = modal(
        v ? td("editVehicle") : td("addVehicle"),
        `<form class="space-y-4">
          <div data-err></div>
          <div class="grid grid-cols-2 gap-3">
            ${field(td("plateNo"), `<input name="plate_no" required maxlength="20" value="${esc(x.plate_no)}" placeholder="WXY 1234" class="${cls.input} uppercase">`)}
            ${field(td("vehicleName"), `<input name="name" maxlength="80" value="${esc(x.name || "")}" placeholder="Toyota Hilux" class="${cls.input}">`)}
            ${field(td("type"), `<select name="vehicle_type" class="${cls.input}">${opt(["car", "pickup", "van", "lorry", "motorcycle", "machinery", "other"].map((k) => [k, td("types." + k)]), x.vehicle_type)}</select>`)}
            ${field(td("fuel"), `<select name="fuel_type" class="${cls.input}">${opt(["diesel", "petrol"].map((k) => [k, td("fuels." + k)]), x.fuel_type)}</select>`)}
            ${field(td("tank"), `<input name="tank_capacity_l" type="number" min="1" step="0.1" value="${esc(x.tank_capacity_l ?? "")}" placeholder="L" class="${cls.input}">`)}
            ${field(td("statusLabel"), `<select name="status" class="${cls.input}">${opt([["active", td("active")], ["inactive", td("inactive")]], x.status)}</select>`)}
            ${field(t("admin.tabs.business"), `<select name="group_id" class="${cls.input}">${opt(groups.map((g) => [g.id, g.name]), x.group_id, "—")}</select>`)}
            ${field(t("admin.tabs.company"), `<select name="company_id" class="${cls.input}">${opt(companies.map((c) => [c.id, c.name]), x.company_id, "—")}</select>`)}
          </div>
          ${field(td("driver"), `<select name="driver_id" class="${cls.input}">${opt(people.map((p) => [p.id, p.full_name + " · " + p.email]), x.driver_id, td("noDriver"))}</select>`, td("driverHint"))}
          ${field(td("notes"), `<input name="notes" value="${esc(x.notes || "")}" class="${cls.input}">`)}
          <div class="flex justify-between gap-2">
            ${v ? `<button type="button" data-del class="${btn("ghost")} text-red-600 dark:text-red-400">${icon("trash-2")} ${esc(td("delete"))}</button>` : "<span></span>"}
            <div class="flex gap-2">
              <button type="button" data-cancel class="${btn("secondary")}">${esc(td("cancel"))}</button>
              <button type="submit" class="${btn("primary")}">${esc(td("save"))}</button>
            </div>
          </div>
        </form>`,
      );
      refreshIcons();
      const f = $("form", m.el);
      $("[data-cancel]", m.el).onclick = m.close;
      if (v)
        $("[data-del]", m.el).onclick = async () => {
          if (!(await confirmDialog(td("deleteVehicleTitle"), td("deleteVehicleBody", { plate: v.plate_no }), td("delete"), td("cancel")))) return;
          const { error } = await sb.from("diesel_vehicles").delete().eq("id", v.id);
          if (error) return ($("[data-err]", m.el).innerHTML = alertBox(td("vehicleInUse")));
          m.close();
          vehiclesTab();
        };
      f.addEventListener("submit", async (e) => {
        e.preventDefault();
        const row = {
          plate_no: f.plate_no.value.trim().toUpperCase().replace(/\s+/g, " "),
          name: f.name.value.trim() || null,
          vehicle_type: f.vehicle_type.value,
          fuel_type: f.fuel_type.value,
          tank_capacity_l: f.tank_capacity_l.value === "" ? null : Number(f.tank_capacity_l.value),
          status: f.status.value,
          group_id: f.group_id.value || null,
          company_id: f.company_id.value || null,
          driver_id: f.driver_id.value || null,
          notes: f.notes.value.trim() || null,
        };
        const { error } = v ? await sb.from("diesel_vehicles").update(row).eq("id", v.id) : await sb.from("diesel_vehicles").insert(row);
        if (error) return ($("[data-err]", m.el).innerHTML = alertBox(td(error.code === "23505" ? "duplicatePlate" : "saveFailed")));
        m.close();
        vehiclesTab();
      });
    }

    view.onclick = (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      if (b.id === "veh-add") return vehicleDialog(null);
      if (b.dataset.edit) return vehicleDialog(vehicles.find((v) => v.id === b.dataset.edit));
    };
    draw();
  }

  // ================================================================ 全部报销（管理者审核）
  async function claimsTab() {
    const seq = routeSeq;
    const [claims, vehicles, people] = await Promise.all([loadClaims(), loadVehicles(), loadPeople()]);
    if (stale(seq)) return;
    const vById = new Map(vehicles.map((v) => [v.id, v]));
    const person = new Map(people.map((p) => [p.id, p]));
    const filter = { status: "pending", vehicle: "", month: "" };
    const months = [...new Set(claims.map((c) => c.fill_date.slice(0, 7)))].sort().reverse();

    function list() {
      return claims.filter(
        (c) => (!filter.status || c.status === filter.status) && (!filter.vehicle || c.vehicle_id === filter.vehicle) && (!filter.month || c.fill_date.startsWith(filter.month)),
      );
    }

    function draw() {
      const rows = list();
      const sel = (id, opts, value) => `<select id="${id}" class="${cls.input} sm:w-44">${opts.map(([v, l]) => `<option value="${esc(v)}" ${v === value ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
      view.innerHTML = `<div class="space-y-4">
        <div class="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
          ${sel("f-status", [["", td("allStatus")], ...["pending", "approved", "paid", "rejected"].map((s) => [s, td("status." + s)])], filter.status)}
          ${sel("f-vehicle", [["", td("allVehicles")], ...vehicles.map((v) => [v.id, vehicleLabel(v)])], filter.vehicle)}
          ${sel("f-month", [["", td("allMonths")], ...months.map((m) => [m, m])], filter.month)}
          <div class="flex-1"></div>
          <span class="text-sm text-slate-500">${esc(td("totalLine", { count: rows.length, litres: num(rows.reduce((s, c) => s + Number(c.litres), 0)), amount: money(rows.reduce((s, c) => s + Number(c.amount), 0)) }))}</span>
          <button id="export" class="${btn("secondary")}">${icon("download")} ${esc(td("export"))}</button>
        </div>
        ${
          rows.length
            ? `<div class="${cls.card} divide-y divide-slate-200 dark:divide-slate-800">${rows
                .map((c) => {
                  const p = person.get(c.claimant_id);
                  return claimRow(c, vById.get(c.vehicle_id), `<div class="mt-0.5 text-xs text-slate-500">${icon("user", "inline size-3")} ${esc(p ? p.full_name + " · " + p.email : "—")}${c.reviewed_by && person.get(c.reviewed_by) ? " · " + esc(td("reviewedBy", { name: person.get(c.reviewed_by).full_name })) : ""}</div>`);
                })
                .join("")}</div>`
            : empty(td("noClaimsFilter"))
        }
      </div>`;
      rows.forEach((c) => {
        const own = c.claimant_id === me.id && !me.isSuper;
        $(`[data-actions="${c.id}"]`, view).innerHTML = `${c.receipt_path ? `<button data-receipt="${esc(c.receipt_path)}" class="${btn("ghost", "sm")}">${icon("receipt")} ${esc(td("receipt"))}</button>` : `<span class="self-center text-xs text-red-500">${esc(td("noReceipt"))}</span>`}
          ${
            own
              ? `<span class="self-center text-xs text-slate-400">${esc(td("ownClaim"))}</span>`
              : c.status === "pending"
                ? `<button data-review="${c.id}:approved" class="${btn("primary", "sm")}">${icon("check")} ${esc(td("approve"))}</button>
                   <button data-review="${c.id}:rejected" class="${btn("ghost", "sm")} text-red-600 dark:text-red-400">${icon("x")} ${esc(td("reject"))}</button>`
                : c.status === "approved"
                  ? `<button data-review="${c.id}:paid" class="${btn("secondary", "sm")}">${icon("banknote")} ${esc(td("markPaid"))}</button>
                     <button data-review="${c.id}:pending" class="${btn("ghost", "sm")}">${esc(td("undo"))}</button>`
                  : c.status === "rejected"
                    ? `<button data-review="${c.id}:pending" class="${btn("ghost", "sm")}">${esc(td("undo"))}</button>`
                    : ""
          }`;
      });
      refreshIcons();
      $("#f-status").onchange = (e) => ((filter.status = e.target.value), draw());
      $("#f-vehicle").onchange = (e) => ((filter.vehicle = e.target.value), draw());
      $("#f-month").onchange = (e) => ((filter.month = e.target.value), draw());
    }

    async function review(id, status) {
      const c = claims.find((x) => x.id === id);
      let note = c.review_note;
      if (status === "rejected") {
        const m = modal(
          td("rejectTitle"),
          `<form class="space-y-4">${field(td("rejectReason"), `<input name="note" required maxlength="500" class="${cls.input}">`)}
            <div class="flex justify-end gap-2"><button type="button" data-cancel class="${btn("secondary")}">${esc(td("cancel"))}</button><button type="submit" class="${btn("danger")}">${esc(td("reject"))}</button></div></form>`,
        );
        $("[data-cancel]", m.el).onclick = m.close;
        note = await new Promise((resolve) => {
          $("form", m.el).addEventListener("submit", (e) => (e.preventDefault(), resolve(e.target.note.value.trim()), m.close()));
          $("[data-cancel]", m.el).addEventListener("click", () => resolve(null));
        });
        if (!note) return;
      }
      const { data, error } = await sb.from("diesel_claims").update({ status, review_note: note || null }).eq("id", id).select().single();
      if (error) return toast(td("saveFailed"));
      Object.assign(c, data);
      toast(td("status." + status));
      draw();
    }

    view.onclick = (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      if (b.dataset.receipt) return openReceipt(b.dataset.receipt);
      if (b.dataset.review) {
        const [id, status] = b.dataset.review.split(":");
        return review(id, status);
      }
      if (b.id === "export")
        return GW.downloadXlsx(`diesel-claims-${today()}.xlsx`, (wb) => {
          const ws = wb.addWorksheet("claims");
          ws.columns = [
            { header: td("fillDate"), width: 12 },
            { header: td("plateNo"), width: 12 },
            { header: td("vehicleName"), width: 18 },
            { header: td("claimant"), width: 22 },
            { header: td("odometer"), width: 11 },
            { header: td("litres"), width: 9 },
            { header: td("amount"), width: 11 },
            { header: td("station"), width: 20 },
            { header: td("statusLabel"), width: 10 },
            { header: td("reviewNote"), width: 24 },
          ];
          list().forEach((c) => {
            const v = vById.get(c.vehicle_id) || {};
            const p = person.get(c.claimant_id);
            ws.addRow([c.fill_date, v.plate_no, v.name, p ? p.full_name : "", c.odometer_km, Number(c.litres), Number(c.amount), c.station, td("status." + c.status), c.review_note]);
          });
          ws.getRow(1).font = { bold: true };
        });
    };
    draw();
  }

  // ================================================================ 统计（每台车每月用油、花费、油耗）
  async function summaryTab() {
    const seq = routeSeq;
    let month = today().slice(0, 7);
    const [vehicles, allClaims] = await Promise.all([loadVehicles(), loadClaims()]);
    if (stale(seq)) return;
    const claims = allClaims.filter((c) => c.status !== "rejected");

    // 油耗：同一台车按里程排序，两次加油之间的公里数 ÷ 后一次加的油
    function efficiency(vid, monthPrefix) {
      const rows = claims.filter((c) => c.vehicle_id === vid && c.odometer_km != null).sort((a, b) => a.odometer_km - b.odometer_km);
      let km = 0, litres = 0;
      for (let i = 1; i < rows.length; i++) {
        if (!rows[i].fill_date.startsWith(monthPrefix)) continue;
        const d = rows[i].odometer_km - rows[i - 1].odometer_km;
        if (d > 0) ((km += d), (litres += Number(rows[i].litres)));
      }
      return { km, kmPerL: litres > 0 ? km / litres : null };
    }

    function draw() {
      const inMonth = claims.filter((c) => c.fill_date.startsWith(month));
      const per = vehicles
        .map((v) => {
          const rows = inMonth.filter((c) => c.vehicle_id === v.id);
          const litres = rows.reduce((s, c) => s + Number(c.litres), 0);
          const amount = rows.reduce((s, c) => s + Number(c.amount), 0);
          const eff = efficiency(v.id, month);
          const overTank = v.tank_capacity_l ? rows.filter((c) => Number(c.litres) > Number(v.tank_capacity_l)).length : 0;
          return { v, count: rows.length, litres, amount, ...eff, overTank };
        })
        .filter((r) => r.count > 0)
        .sort((a, b) => b.amount - a.amount);
      const total = (k) => per.reduce((s, r) => s + r[k], 0);
      const months = [...new Set([today().slice(0, 7), ...claims.map((c) => c.fill_date.slice(0, 7))])].sort().reverse();
      view.innerHTML = `<div class="space-y-4">
        <div class="flex items-center gap-2">
          <div class="w-40 shrink-0"><select id="s-month" class="${cls.input}">${months.map((m) => `<option ${m === month ? "selected" : ""}>${m}</option>`).join("")}</select></div>
          <span class="text-sm text-slate-500">${esc(td("summaryHint"))}</span>
        </div>
        <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
          ${[
            [td("claimsCount"), total("count")],
            [td("litres"), num(total("litres")) + " L"],
            [td("amount"), money(total("amount"))],
            [td("avgPrice"), total("litres") ? money(total("amount") / total("litres")) + " / L" : "—"],
          ]
            .map(([k, v]) => `<div class="${cls.card} p-3"><div class="text-xs text-slate-500">${esc(k)}</div><div class="mt-1 text-lg font-semibold">${esc(String(v))}</div></div>`)
            .join("")}
        </div>
        ${
          per.length
            ? `<div class="${cls.card} overflow-x-auto">
                <table class="w-full min-w-[640px] text-sm">
                  <thead><tr class="border-b border-slate-200 text-left text-xs text-slate-500 dark:border-slate-800">
                    <th class="p-3 font-medium">${esc(td("vehicle"))}</th><th class="p-3 text-right font-medium">${esc(td("claimsCount"))}</th>
                    <th class="p-3 text-right font-medium">${esc(td("litres"))}</th><th class="p-3 text-right font-medium">${esc(td("amount"))}</th>
                    <th class="p-3 text-right font-medium">${esc(td("distance"))}</th><th class="p-3 text-right font-medium">${esc(td("kmPerL"))}</th><th class="p-3 font-medium">${esc(td("flags"))}</th>
                  </tr></thead>
                  <tbody class="divide-y divide-slate-100 dark:divide-slate-800">${per
                    .map(
                      (r) => `<tr>
                        <td class="p-3"><span class="font-medium">${esc(r.v.plate_no)}</span><span class="text-slate-500">${r.v.name ? " · " + esc(r.v.name) : ""}</span></td>
                        <td class="p-3 text-right">${r.count}</td>
                        <td class="p-3 text-right">${num(r.litres)}</td>
                        <td class="p-3 text-right">${money(r.amount)}</td>
                        <td class="p-3 text-right">${r.km ? num(r.km, 0) + " km" : "—"}</td>
                        <td class="p-3 text-right">${r.kmPerL ? num(r.kmPerL, 2) : "—"}</td>
                        <td class="p-3">${r.overTank ? badge(td("flagOverTank", { count: r.overTank }), "red") : ""}</td>
                      </tr>`,
                    )
                    .join("")}</tbody>
                </table>
              </div>`
            : empty(td("noClaimsMonth"))
        }
      </div>`;
      $("#s-month").onchange = (e) => ((month = e.target.value), draw());
      refreshIcons();
    }
    draw();
  }

  // ---------------------------------------------------------------- 分页
  const HANDLERS = { mine: mineTab, vehicles: vehiclesTab, claims: claimsTab, summary: summaryTab };
  async function route() {
    const name = location.hash.slice(1);
    const active = TABS.includes(name) ? name : TABS[0];
    $("#tabs").innerHTML = TABS.map(
      (k) => `<a href="#${k}" class="rounded-lg px-3.5 py-1.5 text-sm font-medium whitespace-nowrap ${
        k === active ? "bg-white text-slate-900 shadow-sm dark:bg-slate-950 dark:text-white" : "text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200"
      }">${esc(td("tabs." + k))}</a>`,
    ).join("");
    routeSeq++;
    view.onclick = null;
    view.innerHTML = GW.spinner();
    await HANDLERS[active]();
  }
  window.addEventListener("hashchange", route);
  route();
})();
