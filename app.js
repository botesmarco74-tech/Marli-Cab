// Marli Cab: rider, driver and admin app (vanilla JS + Supabase + Leaflet)
(() => {
  const C = window.MARLI_CONFIG;
  const $app = document.getElementById("app");
  const $toast = document.getElementById("toast");

  if (!C || C.SUPABASE_URL.includes("YOUR-PROJECT")) {
    $app.innerHTML = `<div class="auth"><h1>Marli Cab</h1><p>Setup needed: open <b>www/config.js</b> and paste your Supabase URL and anon key. See README.md.</p></div>`;
    return;
  }

  const sb = supabase.createClient(C.SUPABASE_URL, C.SUPABASE_ANON_KEY);

  // ---------- state ----------
  let me = null;            // profile row
  let map = null;           // leaflet map
  let markers = {};         // named circle markers
  let channel = null;       // realtime channel
  let installEvent = null;  // PWA install prompt
  const rider = { pickup: null, drop: null, target: "drop", mode: "", searchTimer: null };
  const driver = { pos: null };
  const admin = { tab: "overview" };

  const ACTIVE = ["requested", "accepted", "arrived", "in_progress"];
  const LABEL = {
    requested: "Finding a driver",
    accepted: "Driver on the way",
    arrived: "Driver has arrived",
    in_progress: "On trip",
    completed: "Completed",
    cancelled: "Cancelled",
  };

  // ---------- helpers ----------
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const money = (n) => `${C.CURRENCY}${Number(n || 0).toFixed(2)}`;
  const $ = (id) => document.getElementById(id);

  function toast(msg) {
    $toast.textContent = msg;
    $toast.classList.add("show");
    clearTimeout(toast.t);
    toast.t = setTimeout(() => $toast.classList.remove("show"), 3200);
  }

  function distanceKm(a, b) {
    const R = 6371, rad = (d) => (d * Math.PI) / 180;
    const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h)) * 1.3; // 1.3 = rough road-vs-straight-line factor
  }
  const fareFor = (km) => Math.max(C.MIN_FARE, C.BASE_FARE + C.PER_KM * km);

  function timeAgo(ts) {
    const s = Math.max(1, Math.round((Date.now() - new Date(ts)) / 1000));
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    if (s < 86400) return `${Math.round(s / 3600)}h ago`;
    return new Date(ts).toLocaleDateString();
  }

  async function reverse(lat, lng) {
    try {
      const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}`);
      const j = await r.json();
      return (j.display_name || "").split(",").slice(0, 3).join(",").trim() || `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
    } catch { return `${lat.toFixed(4)}, ${lng.toFixed(4)}`; }
  }

  async function search(q) {
    const cc = C.COUNTRY_CODES ? `&countrycodes=${encodeURIComponent(C.COUNTRY_CODES)}` : "";
    const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=5&q=${encodeURIComponent(q)}${cc}`);
    return r.json();
  }

  function getPosition() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) return reject(new Error("No GPS"));
      navigator.geolocation.getCurrentPosition(
        (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
        reject,
        { enableHighAccuracy: true, timeout: 10000 }
      );
    });
  }

  // ---------- map ----------
  function initMap(id, cls) {
    if (map) { map.remove(); map = null; }
    markers = {};
    if (cls) $(id).classList.add(cls);
    map = L.map(id, { zoomControl: false }).setView(C.DEFAULT_CENTER, 13);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap",
    }).addTo(map);
    return map;
  }

  function setMarker(name, pt, color) {
    if (!map) return;
    if (markers[name]) { map.removeLayer(markers[name]); delete markers[name]; }
    if (!pt) return;
    markers[name] = L.circleMarker([pt.lat, pt.lng], { radius: 9, color: "#fff", weight: 3, fillColor: color, fillOpacity: 1 }).addTo(map);
  }

  function fitMarkers() {
    const pts = Object.values(markers).map((m) => m.getLatLng());
    if (pts.length > 1) map.fitBounds(L.latLngBounds(pts), { padding: [50, 50], maxZoom: 16 });
    else if (pts.length === 1) map.setView(pts[0], 15);
  }

  // ---------- realtime ----------
  function subscribe(name, filter, handler) {
    unsubscribe();
    channel = sb.channel(name)
      .on("postgres_changes", { event: "*", schema: "public", table: "rides", ...(filter ? { filter } : {}) }, handler)
      .subscribe();
  }
  function unsubscribe() {
    if (channel) { sb.removeChannel(channel); channel = null; }
  }

  // ---------- shared UI ----------
  const topbar = () => `
    <div class="topbar">
      <div><b>Marli Cab</b><span class="tag">${esc(me.role)}</span></div>
      <button class="small secondary" id="logout">Sign out</button>
    </div>`;

  function bindTop() {
    $("logout").onclick = async () => {
      unsubscribe();
      await sb.auth.signOut();
      me = null;
      showAuth();
    };
  }

  // ---------- auth ----------
  function showAuth(mode = "login", role = "rider") {
    unsubscribe();
    if (map) { map.remove(); map = null; }
    const signup = mode === "signup";
    $app.innerHTML = `
      <div class="auth">
        <h1>Marli Cab</h1>
        <p>${signup ? "Create your account" : "Sign in to book or drive"}</p>
        ${signup ? `
          <div class="seg">
            <button class="${role === "rider" ? "on" : ""}" data-role="rider">I need rides</button>
            <button class="${role === "driver" ? "on" : ""}" data-role="driver">I'm a driver</button>
          </div>
          <input id="name" placeholder="Full name" autocomplete="name">
          <input id="phone" placeholder="Phone number" type="tel" autocomplete="tel">` : ""}
        <input id="email" placeholder="Email" type="email" autocomplete="email">
        <input id="pass" placeholder="Password (6+ characters)" type="password" autocomplete="${signup ? "new-password" : "current-password"}">
        <button id="go">${signup ? "Create account" : "Sign in"}</button>
        <button class="link" id="switch">${signup ? "I already have an account" : "New here? Create an account"}</button>
        ${installEvent ? `<button class="secondary" id="install" style="margin-top:16px">Install Marli Cab on this phone</button>` : ""}
        ${signup && role === "driver" ? `<p class="muted" style="margin-top:14px">Driver accounts must be approved by Marli Cab before you can accept trips.</p>` : ""}
      </div>`;

    document.querySelectorAll("[data-role]").forEach((b) => (b.onclick = () => showAuth("signup", b.dataset.role)));
    $("switch").onclick = () => showAuth(signup ? "login" : "signup", role);
    if ($("install")) $("install").onclick = async () => { installEvent.prompt(); installEvent = null; showAuth(mode, role); };

    $("go").onclick = async () => {
      const email = $("email").value.trim(), password = $("pass").value;
      if (!email || password.length < 6) return toast("Enter your email and a 6+ character password");
      $("go").disabled = true;
      try {
        if (signup) {
          const full_name = $("name").value.trim(), phone = $("phone").value.trim();
          if (!full_name || !phone) throw new Error("Please enter your name and phone number");
          const { data, error } = await sb.auth.signUp({ email, password, options: { data: { full_name, phone, role } } });
          if (error) throw error;
          if (!data.session) { toast("Check your email to confirm your account, then sign in"); showAuth("login"); return; }
        } else {
          const { error } = await sb.auth.signInWithPassword({ email, password });
          if (error) throw error;
        }
        await boot();
      } catch (e) {
        toast(e.message || "Something went wrong");
        $("go").disabled = false;
      }
    };
  }

  // ---------- RIDER ----------
  async function riderShell() {
    $app.innerHTML = `${topbar()}<div id="map"></div><div class="sheet" id="panel"></div>`;
    bindTop();
    initMap("map");
    rider.pickup = null; rider.drop = null; rider.target = "drop"; rider.mode = "";
    map.on("click", (e) => setPoint(rider.target, e.latlng.lat, e.latlng.lng));
    useMyLocation(true);
    await riderRefresh();
    subscribe(`rider-${me.id}`, `rider_id=eq.${me.id}`, riderRefresh);
  }

  async function useMyLocation(quiet) {
    try {
      const p = await getPosition();
      map.setView([p.lat, p.lng], 15);
      await setPoint("pickup", p.lat, p.lng);
    } catch { if (!quiet) toast("Couldn't get your location. Tap the map instead."); }
  }

  async function setPoint(which, lat, lng, text) {
    if (rider.mode !== "book") return;
    rider[which] = { lat, lng, text: text || "Locating…" };
    renderPoints();
    if (!text) { rider[which].text = await reverse(lat, lng); renderPoints(); }
  }

  function renderPoints() {
    if (rider.mode !== "book") return;
    setMarker("pickup", rider.pickup, "#0a8f4f");
    setMarker("drop", rider.drop, "#c62828");
    if ($("pu")) $("pu").value = rider.pickup ? rider.pickup.text : "";
    if ($("dq") && rider.drop && document.activeElement !== $("dq")) $("dq").value = rider.drop.text;
    const ready = rider.pickup && rider.drop;
    $("book").disabled = !ready;
    if (ready) {
      const km = distanceKm(rider.pickup, rider.drop);
      $("est").innerHTML = `<span class="big">${money(fareFor(km))}</span> <span class="muted">· about ${km.toFixed(1)} km</span>`;
      fitMarkers();
    } else {
      $("est").innerHTML = `<span class="muted">Set your destination to see the fare</span>`;
    }
  }

  async function riderRefresh() {
    const { data: rides, error } = await sb.from("rides").select("*").eq("rider_id", me.id).order("created_at", { ascending: false }).limit(15);
    if (error) return toast(error.message);
    const active = rides.find((r) => ACTIVE.includes(r.status));
    if (active) return renderRiderActive(active, rides.filter((r) => r.id !== active.id));
    if (rider.mode !== "book") renderBook();
    $("history").innerHTML = historyHtml(rides);
  }

  function historyHtml(rides) {
    const done = rides.filter((r) => !ACTIVE.includes(r.status));
    if (!done.length) return `<p class="muted">No past rides yet.</p>`;
    return done.map((r) => `
      <div class="card">
        <div class="row"><b>${esc(r.dropoff_text)}</b><span class="status ${r.status}">${LABEL[r.status]}</span></div>
        <div class="muted">${timeAgo(r.created_at)} · ${money(r.fare)}</div>
      </div>`).join("");
  }

  function renderBook() {
    rider.mode = "book";
    $("panel").innerHTML = `
      <div class="card">
        <div class="seg">
          <button class="small ${rider.target === "pickup" ? "on" : ""}" id="tp">Tap map: pickup</button>
          <button class="small ${rider.target === "drop" ? "on" : ""}" id="td">Tap map: destination</button>
        </div>
        <div class="row" style="gap:8px;align-items:stretch">
          <input id="pu" placeholder="Pickup" readonly>
          <button class="small secondary" id="gps" title="Use my location" style="margin-bottom:10px">📍</button>
        </div>
        <input id="dq" placeholder="Where to? Search an address or tap the map" autocomplete="off">
        <div id="res" class="results" hidden></div>
        <div id="est" style="margin-bottom:12px"></div>
        <button id="book" disabled>Request ride</button>
      </div>
      <h3 style="margin:18px 0 10px">Recent rides</h3>
      <div id="history"></div>`;

    $("tp").onclick = () => { rider.target = "pickup"; $("tp").classList.add("on"); $("td").classList.remove("on"); };
    $("td").onclick = () => { rider.target = "drop"; $("td").classList.add("on"); $("tp").classList.remove("on"); };
    $("gps").onclick = () => useMyLocation(false);
    $("dq").oninput = () => {
      clearTimeout(rider.searchTimer);
      const q = $("dq").value.trim();
      if (q.length < 3) { $("res").hidden = true; return; }
      rider.searchTimer = setTimeout(async () => {
        try {
          const list = await search(q);
          $("res").hidden = !list.length;
          $("res").innerHTML = list.map((p, i) => `<div data-i="${i}">${esc(p.display_name)}</div>`).join("");
          $("res").querySelectorAll("div").forEach((d) => (d.onclick = () => {
            const p = list[+d.dataset.i];
            $("res").hidden = true;
            $("dq").value = p.display_name.split(",").slice(0, 3).join(",");
            setPoint("drop", +p.lat, +p.lon, $("dq").value);
          }));
        } catch { /* ignore search errors */ }
      }, 500);
    };
    $("book").onclick = bookRide;
    renderPoints();
  }

  async function bookRide() {
    const km = distanceKm(rider.pickup, rider.drop);
    $("book").disabled = true;
    const { error } = await sb.from("rides").insert({
      rider_id: me.id,
      pickup_text: rider.pickup.text, dropoff_text: rider.drop.text,
      pickup_lat: rider.pickup.lat, pickup_lng: rider.pickup.lng,
      drop_lat: rider.drop.lat, drop_lng: rider.drop.lng,
      distance_km: +km.toFixed(2), fare: +fareFor(km).toFixed(2),
    });
    if (error) { toast(error.message); $("book").disabled = false; return; }
    toast("Ride requested");
    rider.mode = "";
    riderRefresh();
  }

  async function renderRiderActive(r, past) {
    rider.mode = "active";
    setMarker("pickup", { lat: r.pickup_lat, lng: r.pickup_lng }, "#0a8f4f");
    setMarker("drop", { lat: r.drop_lat, lng: r.drop_lng }, "#c62828");
    fitMarkers();
    let drv = null;
    if (r.driver_id) {
      const { data } = await sb.from("profiles").select("full_name,phone").eq("id", r.driver_id).maybeSingle();
      drv = data;
    }
    $("panel").innerHTML = `
      <div class="card">
        <div class="row"><b>${LABEL[r.status]}</b><span class="status ${r.status}">${esc(r.status.replace("_", " "))}</span></div>
        <p class="muted" style="margin:10px 0 2px">From</p><div>${esc(r.pickup_text)}</div>
        <p class="muted" style="margin:10px 0 2px">To</p><div>${esc(r.dropoff_text)}</div>
        <p class="big" style="margin:12px 0 0">${money(r.fare)}</p>
        ${drv ? `<div class="row" style="margin-top:12px"><div><b>${esc(drv.full_name)}</b><div class="muted">Your driver</div></div>${drv.phone ? `<a href="tel:${esc(drv.phone)}"><button class="small">Call</button></a>` : ""}</div>` : `<p class="muted" style="margin-top:12px">Waiting for a driver to accept…</p>`}
        ${r.status !== "in_progress" ? `<button class="danger" id="cancel" style="margin-top:14px">Cancel ride</button>` : ""}
      </div>
      <h3 style="margin:18px 0 10px">Recent rides</h3>${historyHtml(past)}`;
    if ($("cancel")) $("cancel").onclick = async () => {
      if (!confirm("Cancel this ride?")) return;
      const { error } = await sb.from("rides").update({ status: "cancelled" }).eq("id", r.id);
      if (error) toast(error.message); else { rider.mode = ""; riderRefresh(); }
    };
  }

  // ---------- DRIVER ----------
  async function driverShell() {
    if (!me.approved) {
      $app.innerHTML = `${topbar()}<div class="center"><h2>Waiting for approval</h2><p class="muted">Marli Cab needs to approve your driver account before you can accept trips.</p><button id="recheck" style="max-width:260px;margin:0 auto">Check again</button></div>`;
      bindTop();
      $("recheck").onclick = boot;
      return;
    }
    $app.innerHTML = `${topbar()}<div id="map"></div><div class="sheet" id="panel"></div>`;
    bindTop();
    initMap("map");
    getPosition().then((p) => { driver.pos = p; map.setView([p.lat, p.lng], 14); setMarker("me", p, "#1976d2"); driverRefresh(); }).catch(() => {});
    await driverRefresh();
    subscribe("driver-feed", null, driverRefresh);
  }

  async function driverRefresh() {
    const sel = "*, rider:profiles!rides_rider_id_fkey(full_name,phone)";
    const [{ data: act }, { data: open }, { data: done }] = await Promise.all([
      sb.from("rides").select(sel).eq("driver_id", me.id).in("status", ["accepted", "arrived", "in_progress"]).order("created_at", { ascending: false }).limit(1),
      sb.from("rides").select(sel).eq("status", "requested").order("created_at", { ascending: false }).limit(20),
      sb.from("rides").select("fare,created_at").eq("driver_id", me.id).eq("status", "completed"),
    ]);
    const today = new Date().toDateString();
    const total = (done || []).reduce((s, r) => s + Number(r.fare), 0);
    const todayTotal = (done || []).filter((r) => new Date(r.created_at).toDateString() === today).reduce((s, r) => s + Number(r.fare), 0);
    const earnings = `<div class="stats"><div class="card"><div class="muted">Today</div><div class="big">${money(todayTotal)}</div></div><div class="card"><div class="muted">All time · ${(done || []).length} trips</div><div class="big">${money(total)}</div></div></div>`;

    if (act && act.length) {
      const r = act[0];
      setMarker("pickup", { lat: r.pickup_lat, lng: r.pickup_lng }, "#0a8f4f");
      setMarker("drop", { lat: r.drop_lat, lng: r.drop_lng }, "#c62828");
      fitMarkers();
      const next = { accepted: ["arrived", "I've arrived"], arrived: ["in_progress", "Start trip"], in_progress: ["completed", "Complete trip"] }[r.status];
      const dest = r.status === "in_progress" ? { lat: r.drop_lat, lng: r.drop_lng } : { lat: r.pickup_lat, lng: r.pickup_lng };
      $("panel").innerHTML = `${earnings}
        <div class="card">
          <div class="row"><b>${LABEL[r.status]}</b><span class="status ${r.status}">${esc(r.status.replace("_", " "))}</span></div>
          <p class="muted" style="margin:10px 0 2px">Pickup</p><div>${esc(r.pickup_text)}</div>
          <p class="muted" style="margin:10px 0 2px">Drop-off</p><div>${esc(r.dropoff_text)}</div>
          <div class="row" style="margin:12px 0"><span class="big">${money(r.fare)}</span><span class="muted">${Number(r.distance_km).toFixed(1)} km</span></div>
          <div class="row" style="margin-bottom:12px"><div><b>${esc(r.rider?.full_name || "Rider")}</b><div class="muted">Passenger</div></div>${r.rider?.phone ? `<a href="tel:${esc(r.rider.phone)}"><button class="small secondary">Call</button></a>` : ""}</div>
          <a href="https://www.google.com/maps/dir/?api=1&destination=${dest.lat},${dest.lng}" target="_blank" rel="noopener"><button class="secondary" style="margin-bottom:10px">Navigate</button></a>
          <button id="next">${next[1]}</button>
          ${r.status !== "in_progress" ? `<button class="danger" id="drop" style="margin-top:10px">Cancel trip</button>` : ""}
        </div>`;
      $("next").onclick = async () => {
        const { error } = await sb.from("rides").update({ status: next[0] }).eq("id", r.id).eq("driver_id", me.id);
        if (error) toast(error.message); else { if (next[0] === "completed") { toast("Trip complete"); setMarker("pickup"); setMarker("drop"); } driverRefresh(); }
      };
      if ($("drop")) $("drop").onclick = async () => {
        if (!confirm("Cancel this trip for the rider?")) return;
        const { error } = await sb.from("rides").update({ status: "cancelled" }).eq("id", r.id).eq("driver_id", me.id);
        if (error) toast(error.message); else driverRefresh();
      };
      return;
    }

    setMarker("pickup"); setMarker("drop");
    $("panel").innerHTML = `${earnings}<h3 style="margin:6px 0 10px">Ride requests</h3>` + (
      open && open.length ? open.map((r) => {
        const away = driver.pos ? `${distanceKm(driver.pos, { lat: r.pickup_lat, lng: r.pickup_lng }).toFixed(1)} km away · ` : "";
        return `<div class="card">
          <div class="row"><b>${money(r.fare)}</b><span class="muted">${away}${Number(r.distance_km).toFixed(1)} km trip</span></div>
          <div style="margin:8px 0">${esc(r.pickup_text)}<div class="muted">→ ${esc(r.dropoff_text)}</div></div>
          <button data-accept="${r.id}">Accept ride</button>
        </div>`;
      }).join("") : `<div class="card"><p class="muted" style="margin:0">No requests right now. New ones appear here automatically.</p></div>`
    );
    document.querySelectorAll("[data-accept]").forEach((b) => (b.onclick = async () => {
      b.disabled = true;
      const { data, error } = await sb.from("rides").update({ driver_id: me.id, status: "accepted" }).eq("id", b.dataset.accept).eq("status", "requested").is("driver_id", null).select();
      if (error) toast(error.message);
      else if (!data.length) toast("Another driver already took this ride");
      else toast("Ride accepted");
      driverRefresh();
    }));
  }

  // ---------- ADMIN ----------
  async function adminShell() {
    $app.innerHTML = `${topbar()}
      <div class="tabs"><button data-t="overview">Overview</button><button data-t="rides">Rides</button><button data-t="drivers">Drivers</button></div>
      <div class="sheet" id="panel"></div>`;
    bindTop();
    document.querySelectorAll("[data-t]").forEach((b) => (b.onclick = () => { admin.tab = b.dataset.t; adminRender(); }));
    await adminRender();
    subscribe("admin-feed", null, adminRender);
  }

  async function adminRender() {
    document.querySelectorAll("[data-t]").forEach((b) => b.classList.toggle("on", b.dataset.t === admin.tab));
    const [{ data: rides = [] }, { data: drivers = [] }] = await Promise.all([
      sb.from("rides").select("*, rider:profiles!rides_rider_id_fkey(full_name), driver:profiles!rides_driver_id_fkey(full_name)").order("created_at", { ascending: false }).limit(200),
      sb.from("profiles").select("*").eq("role", "driver").order("created_at", { ascending: false }),
    ]);
    const panel = $("panel");

    if (admin.tab === "overview") {
      const completed = rides.filter((r) => r.status === "completed");
      const revenue = completed.reduce((s, r) => s + Number(r.fare), 0);
      const pending = drivers.filter((d) => !d.approved).length;
      panel.innerHTML = `
        <div class="stats">
          <div class="card"><div class="muted">Active rides</div><div class="big">${rides.filter((r) => ACTIVE.includes(r.status)).length}</div></div>
          <div class="card"><div class="muted">Completed</div><div class="big">${completed.length}</div></div>
          <div class="card"><div class="muted">Revenue</div><div class="big">${money(revenue)}</div></div>
          <div class="card"><div class="muted">Drivers waiting</div><div class="big">${pending}</div></div>
        </div>
        <p class="muted">Showing the latest 200 rides.</p>`;
    }

    if (admin.tab === "rides") {
      panel.innerHTML = rides.length ? `<div style="overflow-x:auto"><table>
        <tr><th>When</th><th>Rider</th><th>Driver</th><th>Fare</th><th>Status</th><th></th></tr>
        ${rides.map((r) => `<tr>
          <td>${timeAgo(r.created_at)}</td><td>${esc(r.rider?.full_name || "")}</td><td>${esc(r.driver?.full_name || "-")}</td>
          <td>${money(r.fare)}</td><td><span class="status ${r.status}">${esc(r.status.replace("_", " "))}</span></td>
          <td>${ACTIVE.includes(r.status) ? `<button class="small danger" data-cancel="${r.id}">Cancel</button>` : ""}</td></tr>`).join("")}
      </table></div>` : `<p class="muted">No rides yet.</p>`;
      document.querySelectorAll("[data-cancel]").forEach((b) => (b.onclick = async () => {
        if (!confirm("Cancel this ride?")) return;
        const { error } = await sb.from("rides").update({ status: "cancelled" }).eq("id", b.dataset.cancel);
        if (error) toast(error.message);
      }));
    }

    if (admin.tab === "drivers") {
      panel.innerHTML = drivers.length ? drivers.map((d) => `
        <div class="card"><div class="row">
          <div><b>${esc(d.full_name)}</b><div class="muted">${esc(d.phone)}</div></div>
          <button class="small ${d.approved ? "secondary" : ""}" data-approve="${d.id}" data-on="${d.approved ? 0 : 1}">${d.approved ? "Revoke" : "Approve"}</button>
        </div></div>`).join("") : `<p class="muted">No drivers have signed up yet.</p>`;
      document.querySelectorAll("[data-approve]").forEach((b) => (b.onclick = async () => {
        const { error } = await sb.from("profiles").update({ approved: b.dataset.on === "1" }).eq("id", b.dataset.approve);
        if (error) toast(error.message); else adminRender();
      }));
    }
  }

  // ---------- boot ----------
  async function boot() {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) return showAuth();
    const { data, error } = await sb.from("profiles").select("*").eq("id", session.user.id).maybeSingle();
    if (error || !data) { toast("Couldn't load your profile. Did you run supabase/schema.sql?"); return showAuth(); }
    me = data;
    if (me.role === "admin") return adminShell();
    if (me.role === "driver") return driverShell();
    return riderShell();
  }

  window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); installEvent = e; });
  if ("serviceWorker" in navigator && /^https?:$/.test(location.protocol)) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
  boot();
})();
