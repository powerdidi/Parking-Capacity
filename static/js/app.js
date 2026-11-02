// اندپوینت‌های بک‌اند Flask
const API_URL = "/api/parkings";
const ADDRESS_API_URL = "/api/addresses"; // ← batch (POST)
const ROUTE_API_URL = "/api/route";       // مسیریابی (POST)
const SEARCH_API_URL = "/api/search-address"; // جستجوی آدرس (GET)

let parkings = [];

const listElement = document.getElementById("parkingList");
const searchInput = document.getElementById("searchInput");
const typeFilter = document.getElementById("typeFilter");
const refreshButton = document.getElementById("refreshButton");

// عناصر مودال نقشه
const mapModal = document.getElementById("mapModal");
const mapModalTitle = document.getElementById("mapModalTitle");
const mapModalClose = document.getElementById("mapModalClose");
const mapModalBackdrop = document.getElementById("mapModalBackdrop");
const mapContainer = document.getElementById("parkingMap");

// کش سمت کلاینت برای آدرس‌ها — اگه آدرس یه پارکینگ رو گرفتیم، دوباره درخواست نزن
const addressCache = new Map();

// قفل برای جلوگیری از درخواست batch تکراری هنگام تایپ سریع کاربر
let addressBatchToken = 0;
let addressBatchPending = false;

// نشانه‌ی اینکه آدرس‌ها دریافت شده‌اند
// تا این زمان، فیلتر "بدون آدرس" اعمال نمی‌شود تا همه‌ی پارکینگ‌ها نمایش داده شوند
let addressesLoaded = false;

// نمونه نقشه Leaflet و لایه‌های فعلی
let parkingMap = null;
let currentMapMarker = null;
let currentRouteLayer = null;
let currentOriginMarker = null;

function toPersianNumber(value) {
  return Number(value || 0).toLocaleString("fa-IR");
}

function getFreeCapacity(item) {
  if (item.free_capacity !== undefined && item.free_capacity !== null) {
    return Math.max(0, Number(item.free_capacity));
  }

  return Math.max(
    0,
    Number(item.capacity || 0) - Number(item.occupied || 0)
  );
}

// پشتیبانی از چند ساختار پاسخ (آرایه مستقیم یا شیء با data/result/items)
function getParkingItems(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.result)) return data.result;
  if (Array.isArray(data?.items)) return data.items;
  return [];
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  })[character]);
}

// ساختن کلید یکتا برای کش آدرس بر اساس مختصات
function getAddressCacheKey(lat, lon) {
  if (lat == null || lon == null) return null;
  return `${Number(lat).toFixed(6)},${Number(lon).toFixed(6)}`;
}

// ساختن لیست نوع‌های پارکینگ از روی داده‌ها و پر کردن dropdown
function populateTypeFilter(items) {
  const typesSet = new Set();
  items.forEach(item => {
    const typeName = item.parking_type_name;
    if (typeName && String(typeName).trim()) {
      typesSet.add(String(typeName).trim());
    }
  });

  // مرتب‌سازی الفبایی فارسی
  const types = Array.from(typesSet).sort((a, b) =>
    a.localeCompare(b, "fa")
  );

  const currentValue = typeFilter.value || "all";
  typeFilter.innerHTML =
    '<option value="all">همه انواع</option>' +
    types
      .map(
        type =>
          `<option value="${escapeHtml(type)}">${escapeHtml(type)}</option>`
      )
      .join("");

  if (
    Array.from(typeFilter.options).some(o => o.value === currentValue)
  ) {
    typeFilter.value = currentValue;
  }
}

function renderParkings() {
  const query = searchInput.value.trim().toLocaleLowerCase("fa");
  const selectedType = typeFilter.value;

  const filtered = parkings.filter(item => {
    const nameMatch = String(item.parking_name || "")
      .toLocaleLowerCase("fa")
      .includes(query);

    const typeMatch =
      selectedType === "all" ||
      String(item.parking_type_name || "").trim() === selectedType;

    if (!nameMatch || !typeMatch) return false;

    // بعد از دریافت آدرس‌ها، فقط پارکینگ‌هایی که آدرس دارند نمایش داده می‌شوند
    if (addressesLoaded) {
      const cacheKey = getAddressCacheKey(item.latitude, item.longitude);
      if (!cacheKey || !addressCache.has(cacheKey)) {
        return false;
      }
    }

    return true;
  });

  if (!filtered.length) {
    listElement.innerHTML =
      '<div class="state">پارکینگی با این مشخصات پیدا نشد.</div>';
    return;
  }

  // هر کارت یه شناسه یکتا بر اساس index می‌گیره تا بعداً آدرس رو تزریق کنیم
  listElement.innerHTML = filtered.map((item, index) => {
    const free = getFreeCapacity(item);
    const freeClass = free === 0 ? "capacity-item free full" : "capacity-item free";

    const typeName = item.parking_type_name
      ? `<span class="parking-type">${escapeHtml(item.parking_type_name)}</span>`
      : "";

    const cacheKey = getAddressCacheKey(item.latitude, item.longitude);
    const cachedAddress = cacheKey ? addressCache.get(cacheKey) : null;

    // اگه آدرس از قبل تو کش باشه، مستقیم نمایش بده؛ وگرنه حالت loading نشون بده
    const addressHtml = cachedAddress
      ? escapeHtml(cachedAddress)
      : "در حال دریافت آدرس...";

    const addressClass = cachedAddress
      ? "parking-address"
      : "parking-address missing";

    // آیکون لوکیشن (جزء آدرس، کلیک‌پذیر همراه متن)
    const addressIconSvg = `
      <svg class="address-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/>
        <circle cx="12" cy="10" r="3"/>
      </svg>
    `;

    // ذخیره‌ی مختصات به‌صورت data attribute برای کلیک روی آدرس
    const lat = item.latitude != null ? Number(item.latitude) : "";
    const lon = item.longitude != null ? Number(item.longitude) : "";

    return `
      <article class="parking-card" id="parking-card-${index}" data-card-index="${index}">
        <div class="parking-info">
          <h2 class="parking-name">
            ${escapeHtml(item.parking_name || "پارکینگ بدون نام")}
          </h2>
          <div
            class="${addressClass}"
            id="parking-address-${index}"
            data-lat="${lat}"
            data-lon="${lon}"
            data-name="${escapeHtml(item.parking_name || "پارکینگ")}"
            data-capacity="${item.capacity || 0}"
            data-free="${free}"
            role="button"
            tabindex="0"
            aria-label="نمایش موقعیت روی نقشه"
            title="برای نمایش روی نقشه کلیک کنید"
          >
            ${addressIconSvg}
            <span class="address-text">${addressHtml}</span>
          </div>
          <div class="meta-row">
            ${typeName}
            <button
              class="route-button"
              type="button"
              data-lat="${lat}"
              data-lon="${lon}"
              data-name="${escapeHtml(item.parking_name || "پارکینگ")}"
              aria-label="مسیریابی تا این پارکینگ"
              title="مسیریابی"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M6 19c0 1.1.9 2 2 2s2-.9 2-2-.9-2-2-2-2 .9-2 2z"/>
                <path d="M18 5c0 1.1.9 2 2 2s2-.9 2-2-.9-2-2-2-2 .9-2 2z"/>
                <path d="M8 19h8"/>
                <path d="M20 5v7a2 2 0 0 1-2 2H10"/>
                <path d="M4 7v7a2 2 0 0 0 2 2h2"/>
              </svg>
              <span>مسیریابی</span>
            </button>
          </div>
        </div>

        <div class="capacity-info">
          <div class="capacity-item">
            <span class="capacity-label">ظرفیت</span>
            <span class="capacity-value">
              ${toPersianNumber(item.capacity)}
            </span>
          </div>

          <div class="${freeClass}">
            <span class="capacity-label">باقیمانده</span>
            <span class="capacity-value">
              ${toPersianNumber(free)}
            </span>
          </div>
        </div>
      </article>
    `;
  }).join("");

  // بعد از رندر، آدرس‌های ناقص رو به‌صورت batch بگیر
  loadMissingAddresses(filtered);

  // attach event listener برای کلیک روی آدرس و نمایش نقشه
  attachAddressClickHandlers();
}

function attachAddressClickHandlers() {
  document.querySelectorAll(".parking-address[data-lat]").forEach(el => {
    // جلوگیری از attach مجدد
    if (el.dataset.clickAttached) return;
    el.dataset.clickAttached = "true";

    el.addEventListener("click", handleAddressClick);
    el.addEventListener("keydown", (e) => {
      // Enter یا Space
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        handleAddressClick(e);
      }
    });
  });

  // دکمه‌های مسیریابی
  document.querySelectorAll(".route-button[data-lat]").forEach(el => {
    if (el.dataset.clickAttached) return;
    el.dataset.clickAttached = "true";
    el.addEventListener("click", handleRouteClick);
  });
}

function handleRouteClick(event) {
  const el = event.currentTarget;
  const lat = parseFloat(el.dataset.lat);
  const lon = parseFloat(el.dataset.lon);

  if (!lat || !lon || isNaN(lat) || isNaN(lon)) {
    return;
  }

  const name = el.dataset.name || "پارکینگ";
  startRouting({ lat, lon, name });
}

function handleAddressClick(event) {
  const el = event.currentTarget;
  const lat = parseFloat(el.dataset.lat);
  const lon = parseFloat(el.dataset.lon);

  if (!lat || !lon || isNaN(lat) || isNaN(lon)) {
    return;
  }

  const name = el.dataset.name || "پارکینگ";
  const capacity = parseInt(el.dataset.capacity, 10) || 0;
  const free = parseInt(el.dataset.free, 10) || 0;

  // آدرس فعلی که تو کارت نمایش داده شده (از span با کلاس address-text)
  const textEl = el.querySelector(".address-text");
  const address = textEl ? textEl.textContent.trim() : "";

  showParkingOnMap({ lat, lon, name, address, capacity, free });
}

// ===== توابع مسیریابی =====

// متغیرهای حالت مسیریابی
let pendingDestination = null;  // مقصد در انتظار دریافت مبدأ
let isWaitingForOriginSelection = false;  // حالت انتخاب مبدأ از نقشه

function startRouting({ lat, lon, name }) {
  // ذخیره‌ی مقصد برای استفاده بعد از دریافت مبدأ
  pendingDestination = { lat, lon, name };

  // باز کردن نقشه بلافاصله
  mapModal.classList.add("open");
  mapModal.setAttribute("aria-hidden", "false");
  mapModalTitle.textContent = `مسیریابی تا ${name}`;

  initMap();

  // با تأخیر کوتاه نقشه رو invalidateSize بزن
  setTimeout(() => {
    if (!parkingMap) return;

    parkingMap.invalidateSize();
    parkingMap.setView([lat, lon], 14);

    // حذف لایه‌های قبلی
    clearMapOverlays();

    // نشون دادن مارکر مقصد
    addDestinationMarker(lat, lon, name);

    // فعال‌کردن حالت انتخاب مبدأ از نقشه بلافاصله
    // تا کاربر بتونه حتی در حین منتظر موندن geolocation کلیک کنه
    enableMapClickToSelectOrigin();

    // نمایش پیام به کاربر
    showMapBanner(
      "موقعیت خود را انتخاب کنید",
      "روی نقشه کلیک کنید یا از دکمه‌ی «موقعیت من» استفاده کنید."
    );

    // تلاش برای دریافت موقعیت کاربر در پس‌زمینه
    // اگه موفق بشه، حالت انتخاب از نقشه غیرفعال می‌شه
    tryGetUserLocation();
  }, 350);
}

function tryGetUserLocation() {
  if (!("geolocation" in navigator)) {
    // مرورگر از geolocation پشتیبانی نمی‌کنه — فعال‌کردن حالت انتخاب از نقشه
    enableMapClickToSelectOrigin();
    return;
  }

  // نمایش loader روی دکمه‌ی «موقعیت من»
  const locateBtn = document.getElementById("locateMeButton");
  if (locateBtn) {
    locateBtn.classList.add("loading");
  }

  navigator.geolocation.getCurrentPosition(
    async (position) => {
      if (locateBtn) locateBtn.classList.remove("loading");

      const originLat = position.coords.latitude;
      const originLon = position.coords.longitude;

      // غیرفعال‌کردن حالت انتخاب از نقشه (چون موقعیت واقعی رو داریم)
      disableMapClickToSelectOrigin();

      try {
        await fetchAndShowRoute({
          originLat,
          originLon,
          destLat: pendingDestination.lat,
          destLon: pendingDestination.lon,
          name: pendingDestination.name,
        });
      } catch (error) {
        console.error("خطا در مسیریابی:", error);
        showMapBanner("خطا در دریافت مسیر", "لطفاً دوباره تلاش کنید یا موقعیت دیگری را انتخاب کنید.", "error");
      }
    },
    (error) => {
      if (locateBtn) locateBtn.classList.remove("loading");

      let title = "موقعیت خود را انتخاب کنید";
      let message = "روی نقشه کلیک کنید تا مبدأ مسیر تعیین شود.";

      if (error.code === 1) {
        message = "دسترسی به موقعیت شما رد شد. روی نقشه کلیک کنید تا مبدأ مسیر را انتخاب کنید.";
      } else if (error.code === 2) {
        message = "موقعیت شما در دسترس نیست. روی نقشه کلیک کنید تا مبدأ مسیر را انتخاب کنید.";
      } else if (error.code === 3) {
        message = "زمان دریافت موقعیت تمام شد. روی نقشه کلیک کنید تا مبدأ مسیر را انتخاب کنید.";
      }

      showMapBanner(title, message);
      enableMapClickToSelectOrigin();
    },
    {
      enableHighAccuracy: true,
      timeout: 8000,
      maximumAge: 0,
    }
  );
}

// فعال‌کردن کلیک روی نقشه برای انتخاب مبدأ
function enableMapClickToSelectOrigin() {
  if (isWaitingForOriginSelection) return;
  isWaitingForOriginSelection = true;

  // تغییر cursor نقشه
  if (parkingMap) {
    parkingMap.getContainer().style.cursor = "crosshair";
  }

  parkingMap.on("click", handleMapClickForOrigin);
}

function disableMapClickToSelectOrigin() {
  if (!isWaitingForOriginSelection) return;
  isWaitingForOriginSelection = false;

  if (parkingMap) {
    parkingMap.getContainer().style.cursor = "";
    parkingMap.off("click", handleMapClickForOrigin);
  }
}

async function handleMapClickForOrigin(e) {
  // جلوگیری از اجرای مجدد اگه در حال پردازش هست
  if (!pendingDestination) {
    console.warn("handleMapClickForOrigin: pendingDestination is null");
    return;
  }

  const originLat = e.latlng.lat;
  const originLon = e.latlng.lng;

  console.log("مبدأ انتخاب شد:", { originLat, originLon, destination: pendingDestination });

  // غیرفعال‌کردن حالت انتخاب
  disableMapClickToSelectOrigin();

  // حذف پیام
  hideMapBanner();

  // نمایش وضعیت loading
  showMapBanner("در حال محاسبه مسیر...", "", "info");

  try {
    await fetchAndShowRoute({
      originLat,
      originLon,
      destLat: pendingDestination.lat,
      destLon: pendingDestination.lon,
      name: pendingDestination.name,
    });
  } catch (error) {
    console.error("خطا در مسیریابی:", error);
    showMapBanner(
      "خطا در دریافت مسیر",
      error.message || "لطفاً دوباره تلاش کنید یا نقطه دیگری را انتخاب کنید.",
      "error"
    );
  }
}

// دریافت مسیر از بک‌اند و رسم روی نقشه
async function fetchAndShowRoute({ originLat, originLon, destLat, destLon, name }) {
  // حذف لایه‌های قبلی (مارکرها و مسیر قبلی)
  clearMapOverlays();

  // مارکر مقصد (پارکینگ)
  addDestinationMarker(destLat, destLon, name);

  // مارکر مبدأ (موقعیت کاربر)
  addOriginMarker(originLat, originLon);

  // دریافت مسیر از بک‌اند
  const response = await fetch(ROUTE_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      origin: { lat: originLat, lon: originLon },
      destination: { lat: destLat, lon: destLon },
      vehicle_type: "car",
    }),
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`خطای سرور: ${response.status}`);
  }

  const data = await response.json();

  if (data && typeof data === "object" && data.error) {
    throw new Error(data.error);
  }

  console.log("پاسخ سرویس مسیریابی:", data);

  // استخراج خط مسیر از پاسخ (پشتیبانی از چند ساختار)
  const routeLatLngs = extractRouteCoordinates(data);

  console.log("مختصات استخراج‌شده مسیر:", routeLatLngs.length, "نقطه");

  if (!routeLatLngs.length) {
    throw new Error("مسیری برای این نقطه پیدا نشد. لطفاً نقطه دیگری را انتخاب کنید.");
  }

  // رسم مسیر روی نقشه
  currentRouteLayer = L.polyline(routeLatLngs, {
    color: "#07875f",
    weight: 6,
    opacity: 0.9,
    lineCap: "round",
    lineJoin: "round",
  }).addTo(parkingMap);

  // تنظیم زوم نقشه برای نمایش کل مسیر
  const bounds = L.latLngBounds(routeLatLngs);
  bounds.extend([originLat, originLon]);
  bounds.extend([destLat, destLon]);
  parkingMap.fitBounds(bounds, { padding: [60, 60] });

  // اگه مسافت یا زمان تو پاسخ بود، نمایش بده
  const summary = extractRouteSummary(data);
  if (summary) {
    showMapBanner("مسیر یافت شد", summary, "success");
  } else {
    hideMapBanner();
  }
}

// حذف تمام لایه‌های روی نقشه (مارکرها و مسیر)
function clearMapOverlays() {
  if (currentMapMarker && parkingMap) {
    parkingMap.removeLayer(currentMapMarker);
    currentMapMarker = null;
  }
  if (currentRouteLayer && parkingMap) {
    parkingMap.removeLayer(currentRouteLayer);
    currentRouteLayer = null;
  }
  if (currentOriginMarker && parkingMap) {
    parkingMap.removeLayer(currentOriginMarker);
    currentOriginMarker = null;
  }
}

// اضافه‌کردن مارکر مقصد (پارکینگ)
function addDestinationMarker(lat, lon, name) {
  const parkingIcon = L.divIcon({
    className: "parking-marker-wrapper",
    html: `<div class="parking-marker-icon"><span>P</span></div>`,
    iconSize: [36, 36],
    iconAnchor: [18, 36],
    popupAnchor: [0, -36],
  });

  currentMapMarker = L.marker([lat, lon], { icon: parkingIcon })
    .addTo(parkingMap)
    .bindPopup(`<div class="popup-title">${escapeHtml(name)}</div>`, {
      className: "parking-marker-popup",
      maxWidth: 280,
    });
}

// اضافه‌کردن مارکر مبدأ (موقعیت کاربر)
function addOriginMarker(lat, lon) {
  const userIcon = L.divIcon({
    className: "user-marker-wrapper",
    html: `<div class="user-marker-icon"></div>`,
    iconSize: [20, 20],
    iconAnchor: [10, 10],
  });

  currentOriginMarker = L.marker([lat, lon], { icon: userIcon })
    .addTo(parkingMap)
    .bindPopup(`<div class="popup-title">مبدأ مسیر</div>`, {
      className: "parking-marker-popup",
      maxWidth: 280,
    });
}

// استخراج خلاصه‌ی مسیر (مسافت و زمان)
function extractRouteSummary(data) {
  // حالت ۱: ساختار map.mashhad.ir
  // result.routes[0].legs[0].distance.value و duration.value
  if (data?.result?.routes && Array.isArray(data.result.routes)) {
    const route = data.result.routes[0];
    if (route?.legs && Array.isArray(route.legs)) {
      const leg = route.legs[0];
      const distance = leg?.distance?.value != null
        ? formatDistance(leg.distance.value)
        : (leg?.distance?.text || null);
      const duration = leg?.duration?.value != null
        ? formatDuration(leg.duration.value)
        : (leg?.duration?.text || null);
      if (distance && duration) return `${distance} • ${duration}`;
      if (distance) return distance;
      if (duration) return duration;
    }
  }

  // حالت ۲: paths[0].summary (GraphHopper)
  if (Array.isArray(data?.paths) && data.paths[0]?.summary) {
    const s = data.paths[0].summary;
    const distance = s.distance != null ? formatDistance(s.distance) : null;
    const duration = s.time != null ? formatDuration(s.time) : null;
    if (distance && duration) return `${distance} • ${duration}`;
    if (distance) return distance;
    if (duration) return duration;
  }

  // حالت ۳: features[0].properties (GeoJSON)
  if (Array.isArray(data?.features) && data.features[0]?.properties) {
    const p = data.features[0].properties;
    const distance = p.distance != null ? formatDistance(p.distance) : null;
    const duration = p.duration != null || p.time != null
      ? formatDuration(p.duration || p.time)
      : null;
    if (distance && duration) return `${distance} • ${duration}`;
    if (distance) return distance;
    if (duration) return duration;
  }

  // حالت ۴: مستقیم summary
  if (data?.summary) {
    const s = data.summary;
    const distance = s.distance != null ? formatDistance(s.distance) : null;
    const duration = s.duration != null || s.time != null
      ? formatDuration(s.duration || s.time)
      : null;
    if (distance && duration) return `${distance} • ${duration}`;
    if (distance) return distance;
    if (duration) return duration;
  }

  return null;
}

function formatDistance(meters) {
  const m = Number(meters);
  if (isNaN(m)) return null;
  if (m < 1000) return `${Math.round(m)} متر`;
  return `${(m / 1000).toFixed(1)} کیلومتر`;
}

function formatDuration(seconds) {
  const s = Number(seconds);
  if (isNaN(s)) return null;
  // گاهی اوقات سرویس به جای ثانیه، میلی‌ثانیه می‌ده
  let secondsNormalized = s;
  if (s > 100000) secondsNormalized = s / 1000;
  const minutes = Math.round(secondsNormalized / 60);
  if (minutes < 60) return `${minutes} دقیقه`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours} ساعت و ${remainingMinutes} دقیقه`;
}

// ===== توابع بنر پیام نقشه =====

function showMapBanner(title, message, type = "info") {
  let banner = document.getElementById("mapBanner");
  if (!banner) return;

  banner.className = `map-banner ${type}`;
  banner.innerHTML = `
    <div class="map-banner-title">${escapeHtml(title)}</div>
    ${message ? `<div class="map-banner-message">${escapeHtml(message)}</div>` : ""}
  `;
  banner.style.display = "block";
}

function hideMapBanner() {
  const banner = document.getElementById("mapBanner");
  if (banner) {
    banner.style.display = "none";
    banner.className = "map-banner";
  }
}

function extractRouteCoordinates(data) {
  // حالت ۱: پاسخ سرویس map.mashhad.ir با encoded polyline
  // { result: { routes: [{ overview_polyline: { points: "..." } }] } }
  if (data?.result?.routes && Array.isArray(data.result.routes)) {
    const route = data.result.routes[0];
    if (route?.overview_polyline?.points) {
      const decoded = decodePolyline(route.overview_polyline.points);
      if (decoded.length) return decoded;
    }
    // fallback: اگه overview_polyline نبود، از steps استفاده کن
    if (route?.legs && Array.isArray(route.legs)) {
      const coords = [];
      for (const leg of route.legs) {
        if (!leg.steps) continue;
        for (const step of leg.steps) {
          if (step.polyline) {
            const decoded = decodePolyline(step.polyline);
            coords.push(...decoded);
          } else if (step.start_location && Array.isArray(step.start_location)) {
            // start_location به صورت [lng, lat]
            coords.push([Number(step.start_location[1]), Number(step.start_location[0])]);
          }
        }
      }
      if (coords.length) return coords;
    }
  }

  // حالت ۲: پاسخ مستقیم GeoJSON FeatureCollection
  if (data && data.type === "FeatureCollection" && Array.isArray(data.features)) {
    for (const feature of data.features) {
      const coords = extractCoordsFromFeature(feature);
      if (coords.length) return coords;
    }
  }

  // حالت ۳: features مستقیم
  if (Array.isArray(data?.features)) {
    for (const feature of data.features) {
      const coords = extractCoordsFromFeature(feature);
      if (coords.length) return coords;
    }
  }

  // حالت ۴: یک Feature واحد
  if (data?.type === "Feature") {
    return extractCoordsFromFeature(data);
  }

  // حالت ۵: geometry مستقیم
  if (data?.geometry?.coordinates) {
    return coordsArrayToLatLngs(data.geometry.coordinates);
  }

  // حالت ۶: آرایه مستقیم مختصات
  if (Array.isArray(data?.coordinates)) {
    return coordsArrayToLatLngs(data.coordinates);
  }

  // حالت ۷: فیلد paths با encoded polyline (GraphHopper style)
  if (Array.isArray(data?.paths)) {
    for (const path of data.paths) {
      if (path?.points) {
        // اگه points رشته باشه (encoded)
        if (typeof path.points === "string") {
          const decoded = decodePolyline(path.points);
          if (decoded.length) return decoded;
        }
        // اگه points آرایه باشه
        else if (path.points.coordinates) {
          return coordsArrayToLatLngs(path.points.coordinates);
        }
      }
    }
  }

  return [];
}

/**
 * دیکود کردن Encoded Polyline (الگوریتم Google Maps)
 * @param {string} encoded - رشته‌ی encoded polyline
 * @returns {Array<[number, number]>} آرایه‌ی [lat, lng]
 */
function decodePolyline(encoded) {
  if (!encoded || typeof encoded !== "string") return [];

  const coords = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < encoded.length) {
    let result = 1;
    let shift = 0;
    let b;

    // دیکود latitude
    do {
      b = encoded.charCodeAt(index++) - 63 - 1;
      result += b << shift;
      shift += 5;
    } while (b >= 0x1f);

    lat += (result & 1) ? ~(result >> 1) : (result >> 1);

    result = 1;
    shift = 0;

    // دیکود longitude
    do {
      b = encoded.charCodeAt(index++) - 63 - 1;
      result += b << shift;
      shift += 5;
    } while (b >= 0x1f);

    lng += (result & 1) ? ~(result >> 1) : (result >> 1);

    // ضرب در 1e-5 برای تبدیل به مختصات واقعی
    coords.push([lat * 1e-5, lng * 1e-5]);
  }

  return coords;
}

function extractCoordsFromFeature(feature) {
  if (!feature || !feature.geometry) return [];
  const geom = feature.geometry;

  if (geom.type === "LineString" && Array.isArray(geom.coordinates)) {
    return coordsArrayToLatLngs(geom.coordinates);
  }

  if (geom.type === "MultiLineString" && Array.isArray(geom.coordinates)) {
    // اولین خط رو می‌گیریم (یا می‌تونیم همه رو concat کنیم)
    return coordsArrayToLatLngs(geom.coordinates[0]);
  }

  return [];
}

function coordsArrayToLatLngs(coords) {
  if (!Array.isArray(coords)) return [];
  return coords
    .filter((c) => Array.isArray(c) && c.length >= 2)
    .map((c) => [Number(c[1]), Number(c[0])]); // [lat, lng]
}

// ===== توابع مدیریت نقشه =====

function initMap() {
  if (parkingMap) return;

  parkingMap = L.map("parkingMap", {
    center: [36.329616, 59.56543],
    zoom: 12,
    zoomControl: true,
    attributionControl: true,
  });

  // نقشه پایه‌ی مشهد (TMS)
  L.tileLayer(
    "https://basemap.mashhad.ir/geoserver/gwc/service/tms/1.0.0/MashhadBaseMap1401@EPSG:900913@png/{z}/{x}/{y}.png",
    {
      minZoom: 7,
      maxZoom: 20,
      tms: true,
      attribution: "Mashhad Map",
    }
  ).addTo(parkingMap);
}

function showParkingOnMap({ lat, lon, name, address, capacity, free }) {
  // باز کردن مودال
  mapModal.classList.add("open");
  mapModal.setAttribute("aria-hidden", "false");
  mapModalTitle.textContent = name;

  // مقداردهی اولیه‌ی نقشه (فقط یه‌بار)
  initMap();

  // با تأخیر کوتاه تا مودال نمایش داده بشه، بعد نقشه رو invalidateSize بزن
  setTimeout(() => {
    if (parkingMap) {
      parkingMap.invalidateSize();
      parkingMap.setView([lat, lon], 17);
    }

    // حذف مارکر قبلی
    if (currentMapMarker) {
      parkingMap.removeLayer(currentMapMarker);
      currentMapMarker = null;
    }

    // ساخت آیکون سفارشی پارکینگ (بدون نیاز به فایل تصویری)
    const parkingIcon = L.divIcon({
      className: "parking-marker-wrapper",
      html: `<div class="parking-marker-icon"><span>P</span></div>`,
      iconSize: [36, 36],
      iconAnchor: [18, 36],
      popupAnchor: [0, -36],
    });

    // ساخت محتوای popup
    const popupHtml = `
      <div class="popup-title">${escapeHtml(name)}</div>
      ${address ? `<div class="popup-address">${escapeHtml(address)}</div>` : ""}
      <div class="popup-capacity">
        <div class="popup-capacity-item">
          <span class="popup-capacity-label">ظرفیت</span>
          <span class="popup-capacity-value">${toPersianNumber(capacity)}</span>
        </div>
        <div class="popup-capacity-item">
          <span class="popup-capacity-label">باقیمانده</span>
          <span class="popup-capacity-value">${toPersianNumber(free)}</span>
        </div>
      </div>
    `;

    currentMapMarker = L.marker([lat, lon], { icon: parkingIcon })
      .addTo(parkingMap)
      .bindPopup(popupHtml, {
        className: "parking-marker-popup",
        maxWidth: 280,
        closeButton: true,
      })
      .openPopup();
  }, 350);
}

function closeMapModal() {
  mapModal.classList.remove("open");
  mapModal.setAttribute("aria-hidden", "true");

  // غیرفعال‌کردن حالت انتخاب از نقشه
  disableMapClickToSelectOrigin();

  // پاک کردن لایه‌ها بعد از بسته شدن
  clearMapOverlays();

  // مخفی کردن بنر
  hideMapBanner();

  // ریست مقصد در انتظار
  pendingDestination = null;
}

// بستن با کلیک روی backdrop و دکمه‌ی close و کلید Escape
mapModalClose.addEventListener("click", closeMapModal);
mapModalBackdrop.addEventListener("click", closeMapModal);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && mapModal.classList.contains("open")) {
    closeMapModal();
  }
});

// دکمه‌ی «موقعیت من» — دریافت موقعیت کاربر
document.getElementById("locateMeButton").addEventListener("click", () => {
  if (!pendingDestination) {
    // اگه مقصدی تو انتظار نیست، فقط پیام بده
    showMapBanner("ابتدا مقصد انتخاب کنید", "برای مسیریابی، روی دکمه‌ی «مسیریابی» یکی از پارکینگ‌ها کلیک کنید.", "info");
    return;
  }

  // حذف لایه‌های قبلی به جز مارکر مقصد
  if (currentRouteLayer && parkingMap) {
    parkingMap.removeLayer(currentRouteLayer);
    currentRouteLayer = null;
  }
  if (currentOriginMarker && parkingMap) {
    parkingMap.removeLayer(currentOriginMarker);
    currentOriginMarker = null;
  }

  // غیرفعال‌کردن حالت انتخاب از نقشه (اگه فعال بود)
  disableMapClickToSelectOrigin();

  // تلاش برای دریافت موقعیت کاربر
  tryGetUserLocation();
});

// ===== مدیریت آدرس‌ها (batch) =====

async function loadMissingAddresses(items) {
  // جمع‌آوری مختصاتی که هنوز آدرس نداریم
  const pendingPoints = [];
  const pendingCardIndices = [];

  items.forEach((item, index) => {
    const lat = item.latitude;
    const lon = item.longitude;
    if (lat == null || lon == null) {
      // مختصات نداره — مستقیم "آدرس ثبت نشده" بذار
      const el = document.getElementById(`parking-address-${index}`);
      if (el) {
        el.textContent = "آدرس ثبت نشده";
        el.classList.add("missing");
      }
      return;
    }

    const cacheKey = getAddressCacheKey(lat, lon);
    if (cacheKey && addressCache.has(cacheKey)) {
      // از قبل تو کش هست — renderParkings قبلاً نشون داده
      return;
    }

    pendingPoints.push({ lat, lon });
    pendingCardIndices.push({ index, cacheKey });
  });

  if (!pendingPoints.length) {
    // اگه چیزی برای دریافت نبود، آدرس‌ها رو "دریافت‌شده" اعلام کن
    addressesLoaded = true;
    return;
  }

  // قفل: فقط یه درخواست batch همزمان فعال باشه
  if (addressBatchPending) return;

  const currentToken = ++addressBatchToken;
  addressBatchPending = true;

  try {
    const response = await fetch(ADDRESS_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify({ points: pendingPoints }),
      cache: "no-store"
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();

    if (data && typeof data === "object" && data.error) {
      throw new Error(data.error);
    }

    const addresses = data?.addresses || {};
    const errors = data?.errors || [];

    // ذخیره در کش سمت کلاینت
    Object.entries(addresses).forEach(([key, address]) => {
      addressCache.set(key, address);
    });

    // اگه توامر چرخه‌ی رندر عوض شده، کنسل کن
    if (currentToken !== addressBatchToken) return;

    // نشانه‌ی دریافت آدرس‌ها
    addressesLoaded = true;

    // به‌روزرسانی DOM فقط برای کارت‌هایی که هنوز تو صفحه هستن
    pendingCardIndices.forEach(({ index, cacheKey }) => {
      const el = document.getElementById(`parking-address-${index}`);
      if (!el) return;

      const address = addressCache.get(cacheKey);
      // آپدیت کردن فقط متن آدرس (نه آیکون)
      const textEl = el.querySelector(".address-text");
      if (!textEl) return;

      if (address) {
        textEl.textContent = address;
        el.classList.remove("missing");
      } else {
        textEl.textContent = "آدرس ثبت نشده";
        el.classList.add("missing");
      }
    });

    if (errors.length) {
      console.warn("برخی آدرس‌ها دریافت نشد:", errors);
    }

    // بعد از دریافت آدرس‌ها، فیلتر اعمال می‌شه و پارکینگ‌های بدون آدرس حذف می‌شن
    renderParkings();
  } catch (error) {
    console.error("خطا در دریافت آدرس‌ها (batch):", error);

    // در صورت خطا، فیلتر اعمال نمی‌شه تا همه‌ی پارکینگ‌ها نمایش داده بشن
    addressesLoaded = false;

    // نشون دادن خطا تو همه‌ی کارت‌های در انتظار
    if (currentToken === addressBatchToken) {
      pendingCardIndices.forEach(({ index }) => {
        const el = document.getElementById(`parking-address-${index}`);
        if (el) {
          el.textContent = "دریافت آدرس ناموفق بود";
          el.classList.add("missing");
        }
      });
    }
  } finally {
    if (currentToken === addressBatchToken) {
      addressBatchPending = false;
    }
  }
}

async function loadParkings() {
  refreshButton.classList.add("loading");
  listElement.innerHTML =
    '<div class="state">در حال دریافت اطلاعات پارکینگ‌ها…</div>';

  // ریست کردن حالت آدرس‌ها
  addressesLoaded = false;
  addressCache.clear();

  try {
    const response = await fetch(API_URL, {
      method: "GET",
      headers: { "Accept": "application/json" },
      cache: "no-store"
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();

    if (data && typeof data === "object" && !Array.isArray(data) && data.error) {
      throw new Error(data.error);
    }

    parkings = getParkingItems(data);

    if (!parkings.length) {
      throw new Error("فهرست پارکینگ‌ها در پاسخ سرویس پیدا نشد.");
    }

    populateTypeFilter(parkings);
    renderParkings();
  } catch (error) {
    console.error("خطا در دریافت اطلاعات:", error);
    listElement.innerHTML = `
      <div class="state">
        دریافت اطلاعات ناموفق بود.<br>
        ${escapeHtml(error.message || "لطفاً اتصال شبکه را بررسی کنید.")}
      </div>
    `;
  } finally {
    refreshButton.classList.remove("loading");
  }
}

// هنگام تایپ سریع، debounce کوتاه تا درخواست batch تکراری نره
let searchDebounce = null;
searchInput.addEventListener("input", () => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(renderParkings, 200);

  // جستجوی آدرس (با debounce جداگانه)
  handleAddressSearch();
});
typeFilter.addEventListener("change", renderParkings);
refreshButton.addEventListener("click", loadParkings);

// ===== جستجوی آدرس =====

let addressSearchDebounce = null;
let currentAddressSearchToken = 0;

function handleAddressSearch() {
  clearTimeout(addressSearchDebounce);
  addressSearchDebounce = setTimeout(performAddressSearch, 600);
}

async function performAddressSearch() {
  const query = searchInput.value.trim();

  // اگه عبارت کوتاهه، dropdown رو ببند
  if (query.length < 3) {
    hideAddressSuggestions();
    return;
  }

  // اگه عبارت با نام پارکینگ تطبیق می‌کنه، احتمالاً کاربر داره پارکینگ می‌گرده
  // در این حالت، جستجوی آدرس انجام نمی‌شه
  const matchesParking = parkings.some(item =>
    String(item.parking_name || "")
      .toLocaleLowerCase("fa")
      .includes(query.toLocaleLowerCase("fa"))
  );

  if (matchesParking) {
    hideAddressSuggestions();
    return;
  }

  // token برای کنسل‌کردن درخواست‌های قدیمی
  const token = ++currentAddressSearchToken;

  try {
    const response = await fetch(
      `${SEARCH_API_URL}?q=${encodeURIComponent(query)}`,
      {
        method: "GET",
        headers: { Accept: "application/json" },
        cache: "no-store",
      }
    );

    if (!response.ok) return;

    const data = await response.json();

    // اگه درخواست جدیدتری اومده، این نتیجه رو کنسل کن
    if (token !== currentAddressSearchToken) return;

    const results = data?.results || [];
    showAddressSuggestions(results);
  } catch (error) {
    console.error("خطا در جستجوی آدرس:", error);
    hideAddressSuggestions();
  }
}

function showAddressSuggestions(results) {
  let dropdown = document.getElementById("addressSuggestions");
  if (!dropdown) {
    // ساخت dropdown اگه وجود نداره
    const searchWrap = document.querySelector(".search-wrap");
    if (!searchWrap) return;

    dropdown = document.createElement("div");
    dropdown.id = "addressSuggestions";
    dropdown.className = "address-suggestions";
    searchWrap.appendChild(dropdown);
  }

  if (!results.length) {
    hideAddressSuggestions();
    return;
  }

  dropdown.innerHTML = results
    .map(
      (r, i) => `
      <div
        class="suggestion-item"
        data-index="${i}"
        data-lat="${r.lat}"
        data-lon="${r.lon}"
        data-name="${escapeHtml(r.name || r.display_name.split(",")[0] || "")}"
        data-display="${escapeHtml(r.display_name)}"
        role="button"
        tabindex="0"
      >
        <svg class="suggestion-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/>
          <circle cx="12" cy="10" r="3"/>
        </svg>
        <span class="suggestion-text">${escapeHtml(r.display_name)}</span>
      </div>
    `
    )
    .join("");

  dropdown.style.display = "block";

  // اضافه‌کردن event listener به هر آیتم
  dropdown.querySelectorAll(".suggestion-item").forEach(item => {
    item.addEventListener("click", handleSuggestionClick);
    item.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        handleSuggestionClick(e);
      }
    });
  });
}

function hideAddressSuggestions() {
  const dropdown = document.getElementById("addressSuggestions");
  if (dropdown) {
    dropdown.style.display = "none";
    dropdown.innerHTML = "";
  }
}

function handleSuggestionClick(event) {
  const el = event.currentTarget;
  const lat = parseFloat(el.dataset.lat);
  const lon = parseFloat(el.dataset.lon);
  const name = el.dataset.name || "آدرس انتخاب شده";
  const display = el.dataset.display || name;

  if (!lat || !lon) return;

  hideAddressSuggestions();
  showSearchedAddressOnMap({ lat, lon, name, display });
}

// بستن dropdown با کلیک خارج از آن
document.addEventListener("click", (e) => {
  if (!e.target.closest(".search-wrap")) {
    hideAddressSuggestions();
  }
});

// نمایش آدرس جستجو شده روی نقشه + پارکینگ‌های نزدیک
function showSearchedAddressOnMap({ lat, lon, name, display }) {
  mapModal.classList.add("open");
  mapModal.setAttribute("aria-hidden", "false");
  mapModalTitle.textContent = "نتایج جستجو";

  initMap();

  setTimeout(() => {
    if (!parkingMap) return;

    parkingMap.invalidateSize();
    parkingMap.setView([lat, lon], 15);

    // حذف لایه‌های قبلی
    clearMapOverlays();
    hideMapBanner();

    // مارکر آدرس جستجو شده (آبی)
    const addressIcon = L.divIcon({
      className: "search-result-marker-wrapper",
      html: `<div class="search-result-marker-icon"></div>`,
      iconSize: [24, 24],
      iconAnchor: [12, 12],
    });

    currentOriginMarker = L.marker([lat, lon], { icon: addressIcon })
      .addTo(parkingMap)
      .bindPopup(
        `<div class="popup-title">${escapeHtml(name)}</div>
         <div class="popup-address">${escapeHtml(display)}</div>`,
        {
          className: "parking-marker-popup",
          maxWidth: 280,
        }
      )
      .openPopup();

    // پیدا کردن پارکینگ‌های نزدیک (شعاع ۲ کیلومتر)
    const nearbyParkings = findNearbyParkings(lat, lon, 2000);

    if (nearbyParkings.length) {
      // یه LayerGroup برای همه‌ی مارکرهای پارکینگ نزدیک
      const parkingMarkersGroup = L.layerGroup();

      nearbyParkings.forEach(p => {
        const parkingIcon = L.divIcon({
          className: "parking-marker-wrapper",
          html: `<div class="parking-marker-icon"><span>P</span></div>`,
          iconSize: [36, 36],
          iconAnchor: [18, 36],
          popupAnchor: [0, -36],
        });

        const marker = L.marker([p.latitude, p.longitude], { icon: parkingIcon })
          .bindPopup(
            `<div class="popup-title">${escapeHtml(p.parking_name || "پارکینگ")}</div>
             <div class="popup-address">فاصله: ${toPersianNumber(p.distance)} متری</div>
             <div class="popup-capacity">
               <div class="popup-capacity-item">
                 <span class="popup-capacity-label">ظرفیت</span>
                 <span class="popup-capacity-value">${toPersianNumber(p.capacity)}</span>
               </div>
               <div class="popup-capacity-item">
                 <span class="popup-capacity-label">باقیمانده</span>
                 <span class="popup-capacity-value">${toPersianNumber(p.free_capacity)}</span>
               </div>
             </div>`,
            {
              className: "parking-marker-popup",
              maxWidth: 280,
            }
          );

        parkingMarkersGroup.addLayer(marker);
      });

      parkingMarkersGroup.addTo(parkingMap);
      // ذخیره‌ی group به‌عنوان currentMapMarker تا موقع بستن حذف بشه
      currentMapMarker = parkingMarkersGroup;

      showMapBanner(
        `${toPersianNumber(nearbyParkings.length)} پارکینگ نزدیک پیدا شد`,
        `شعاع ۲ کیلومتری از آدرس جستجو شده`,
        "success"
      );
    } else {
      showMapBanner(
        "هیچ پارکینگی نزدیک این آدرس پیدا نشد",
        "شعاع جستجو: ۲ کیلومتر",
        "info"
      );
    }
  }, 350);
}

// محاسبه فاصله بین دو نقطه (به متر) با فرمول Haversine
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371000; // شعاع زمین به متر
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δφ = ((lat2 - lat1) * Math.PI) / 180;
  const Δλ = ((lon2 - lon1) * Math.PI) / 180;

  const a =
    Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
    Math.cos(φ1) * Math.cos(φ2) *
    Math.sin(Δλ / 2) * Math.sin(Δλ / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// پیدا کردن پارکینگ‌های نزدیک با شعاع مشخص
function findNearbyParkings(lat, lon, radiusMeters) {
  return parkings
    .filter(p => p.latitude != null && p.longitude != null)
    .map(p => ({
      ...p,
      distance: Math.round(calculateDistance(lat, lon, p.latitude, p.longitude)),
    }))
    .filter(p => p.distance <= radiusMeters)
    .sort((a, b) => a.distance - b.distance);
}

loadParkings();
