import os
from concurrent.futures import ThreadPoolExecutor, as_completed
import requests
from dotenv import load_dotenv
from flask import Flask, jsonify, render_template, request

load_dotenv()

app = Flask(__name__)

# غیرفعال کردن کش فایل‌های استاتیک در زمان توسعه
# این کار باعث می‌شود مرورگر همیشه نسخه‌ی جدید app.js و style.css را بگیرد
@app.after_request
def add_no_cache_headers(response):
    if request.path.startswith("/static/"):
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
    return response


# وب‌سرویس ظرفیت پارکینگ‌ها
API_URL = (
    "https://aidev.mashhad.ir/"
    "DynamicGenerated/GetParkingCapacity_93436"
)
API_KEY = os.environ.get("AIDEV_API_KEY")

# وب‌سرویس تبدیل مختصات به آدرس (Reverse Geocode)
ADDRESS_API_URL = (
    "https://websdi.mashhad.ir/api/extra-services/point-to-address"
)
ADDRESS_API_TOKEN = os.environ.get("WEBSDI_TOKEN")

# وب‌سرویس مسیریابی مشهد
ROUTING_API_URL = "https://map.mashhad.ir/api/proxy/routing/"

# وب‌سرویس جستجوی آدرس (OSM Nominatim)
SEARCH_API_URL = "https://nominatim.openstreetmap.org/search"

# نادیده گرفتن تنظیمات Proxy محیطی
session = requests.Session()
session.trust_env = False

# کش درون‌حافظه‌ای برای آدرس‌ها
# کلید: (lat, lon) با دقت ۶ رقم اعشار — مقدار: آدرس
# چون مختصات پارکینگ‌ها معمولاً ثابت است، این کش درخواست‌های تکراری را حذف می‌کند
address_cache = {}

# تعداد درخواست‌های موازی به سرویس آدرس
# ۸ معمولاً تعادل خوبی است: نه خیلی کم (کند) نه خیلی زیاد (rate-limit)
ADDRESS_WORKERS = 8


def has_valid_coordinates(item):
    """
    بررسی اینکه آیا پارکینگ مختصات معتبر دارد.
    مختصات null، None، رشته‌ی خالی یا غیرعددی نامعتبر محسوب می‌شوند.
    """
    lat = item.get("latitude")
    lon = item.get("longitude")

    if lat is None or lon is None:
        return False

    # تبدیل به float برای اطمینان (ممکن است رشته باشد)
    try:
        float(lat)
        float(lon)
    except (TypeError, ValueError):
        return False

    return True


@app.get("/")
def index():
    return render_template("index.html")


@app.get("/api/parkings")
def get_parkings():
    if not API_KEY:
        return jsonify({
            "error": "کلید API تنظیم نشده است."
        }), 500

    try:
        api_response = session.get(
            API_URL,
            headers={
                "AIDEV_API_KEY": API_KEY,
                "Accept": "application/json",
            },
            timeout=30,
        )

        api_response.raise_for_status()
        result = api_response.json()

        if not isinstance(result, dict):
            return jsonify({
                "error": "ساختار پاسخ API معتبر نیست."
            }), 502

        if not result.get("success"):
            return jsonify({
                "error": (
                    result.get("message")
                    or "دریافت اطلاعات ناموفق بود."
                )
            }), 502

        data = result.get("data", [])

        if not isinstance(data, list):
            return jsonify({
                "error": "ساختار اطلاعات معتبر نیست."
            }), 502

        parkings = [
            {
                "parking_name": item.get("parking_name"),
                "parking_type_name": item.get("parking_type_name"),
                "capacity": item.get("capacity"),
                "free_capacity": item.get("free_capacity"),
                "latitude": item.get("latitude"),
                "longitude": item.get("longitude"),
            }
            for item in data
            if isinstance(item, dict) and has_valid_coordinates(item)
        ]

        # مرتب‌سازی بر اساس نام پارکینگ (الفبای فارسی)
        parkings.sort(key=lambda p: (p.get("parking_name") or ""))

        response = jsonify(parkings)
        response.headers["Cache-Control"] = "no-store"
        return response

    except (requests.RequestException, ValueError):
        app.logger.exception("خطا در دریافت اطلاعات پارکینگ")

        return jsonify({
            "error": "دریافت اطلاعات ناموفق بود."
        }), 502


@app.post("/api/addresses")
def get_addresses_batch():
    """
    دریافت آدرس‌ها به‌صورت batch برای چند مختصات.

    بدنه‌ی درخواست (JSON):
        {
            "points": [
                {"lat": 36.290, "lon": 59.607},
                {"lat": 36.310, "lon": 59.540},
                ...
            ]
        }

    پاسخ:
        {
            "addresses": {
                "36.290000,59.607000": "بلوار وکیل‌آباد، ...",
                "36.310000,59.540000": "خیابان احمدآباد، ...",
                ...
            },
            "errors": [
                {"key": "36.000000,59.000000", "error": "آدرس یافت نشد."}
            ]
        }
    """
    if not ADDRESS_API_TOKEN:
        return jsonify({
            "error": "توکن سرویس آدرس تنظیم نشده است."
        }), 500

    body = request.get_json(silent=True) or {}
    points = body.get("points")

    if not isinstance(points, list) or not points:
        return jsonify({
            "error": "بدنه‌ی درخواست باید شامل لیست points باشد."
        }), 400

    # نرمال‌سازی و حذف تکراری‌ها (فقط مختصات یکتا پردازش می‌شوند)
    unique_points = {}
    for p in points:
        if not isinstance(p, dict):
            continue
        try:
            lat = float(p.get("lat"))
            lon = float(p.get("lon"))
        except (TypeError, ValueError):
            continue
        cache_key = (round(lat, 6), round(lon, 6))
        unique_points[cache_key] = (lat, lon)

    if not unique_points:
        return jsonify({
            "addresses": {},
            "errors": []
        })

    # جداکردن مختصاتی که از قبل در کش هستند
    pending = {}
    addresses = {}

    for key, (lat, lon) in unique_points.items():
        if key in address_cache:
            addresses[key] = address_cache[key]
        else:
            pending[key] = (lat, lon)

    # دریافت موازی آدرس‌های باقی‌مانده
    errors = []
    if pending:
        with ThreadPoolExecutor(max_workers=ADDRESS_WORKERS) as executor:
            futures = {
                executor.submit(fetch_address_for_point, lat, lon): key
                for key, (lat, lon) in pending.items()
            }

            for future in as_completed(futures):
                key = futures[future]
                try:
                    address = future.result()
                    if address:
                        address_cache[key] = address
                        addresses[key] = address
                except Exception as exc:
                    errors.append({
                        "key": f"{key[0]},{key[1]}",
                        "error": str(exc) or "خطای نامشخص"
                    })

    # قالب‌بندی نهایی: کلیدها به رشته تبدیل می‌شوند تا JSON معتبر باشد
    response_data = {
        "addresses": {
            f"{key[0]},{key[1]}": addr
            for key, addr in addresses.items()
        },
        "errors": errors,
    }

    response = jsonify(response_data)
    response.headers["Cache-Control"] = "no-store"
    return response


def fetch_address_for_point(lat, lon):
    """
    دریافت آدرس برای یک نقطه از سرویس websdi.
    این تابع در یک thread جداگانه اجرا می‌شود.
    """
    api_response = session.get(
        ADDRESS_API_URL,
        params={
            "lat": lat,
            "lon": lon,
            "result_format": "geojson",
        },
        headers={
            "Authorization": f"Bearer {ADDRESS_API_TOKEN}",
            "Accept": "application/json",
        },
        timeout=15,
    )

    api_response.raise_for_status()
    data = api_response.json()
    address = extract_address_from_response(data)

    if not address:
        raise ValueError("آدرس برای این مختصات یافت نشد.")

    return address


def extract_address_from_response(data):
    """
    استخراج آدرس از پاسخ سرویس point-to-address.
    اولویت: neighbourhood + road، و اگه نبود fallback به suburb/quarter/city یا display_name.
    مثال خروجی: "آزادشهر، کوچه آزادی ۲"
    """
    if not isinstance(data, dict):
        return None

    # پاسخ سرویس داخل فیلد result قرار دارد
    result = data.get("result")
    if not isinstance(result, dict):
        features = data.get("features")
    else:
        features = result.get("features")

    if not isinstance(features, list) or not features:
        return None

    first_feature = features[0]
    if not isinstance(first_feature, dict):
        return None

    properties = first_feature.get("properties", {})
    if not isinstance(properties, dict):
        return None

    address_obj = properties.get("address")

    # اگه فیلد address نبود یا خالی بود، از display_name استفاده کن
    if not isinstance(address_obj, dict) or not address_obj:
        return _extract_from_display_name(properties.get("display_name"))

    # انتخاب بهترین فیلد محله (اولویت: neighbourhood > suburb > quarter > city)
    neighbourhood = address_obj.get("neighbourhood")
    suburb = address_obj.get("suburb")
    quarter = address_obj.get("quarter")
    road = address_obj.get("road")
    city = (
        address_obj.get("city")
        or address_obj.get("town")
        or address_obj.get("village")
    )

    area = None
    for candidate in (neighbourhood, suburb, quarter, city):
        if candidate and str(candidate).strip():
            area = str(candidate).strip()
            break

    road_str = str(road).strip() if road and str(road).strip() else None

    parts = []
    if area:
        parts.append(area)
    if road_str and road_str != area:
        parts.append(road_str)

    # اگه neighbourhood یا road پیدا نشد، از display_name استفاده کن
    if not parts:
        return _extract_from_display_name(properties.get("display_name"))

    # اتصال با "، " (ویرگول فارسی + فاصله)
    return "، ".join(parts) if parts else None


def _extract_from_display_name(display_name):
    """
    استخراج آدرس از فیلد display_name.
    این فیلد یک رشته‌ی کامل با کاما جدا شده است:
    "نام مکان، شماره، خیابان، محله، شهر، استان، کشور"
    معمولاً ۲ قسمت اول برای نمایش کافی هستند.
    """
    if not display_name or not str(display_name).strip():
        return None

    raw = str(display_name).strip()
    # split بر اساس کاما (انگلیسی و فارسی)
    parts = [p.strip() for p in raw.replace("،", ",").split(",") if p.strip()]

    if not parts:
        return None

    # اگه فقط یک قسمت بود، همون رو برگردان
    if len(parts) == 1:
        return parts[0]

    # اگه قسمت اول عدد بود (مثل شماره پلاک)، از قسمت دوم شروع کن
    if parts[0].replace("-", "").replace("/", "").isdigit():
        parts = parts[1:]
        if not parts:
            return None

    # دو قسمت اول رو بگیر
    return "، ".join(parts[:2])


@app.post("/api/route")
def get_route():
    """
    دریافت مسیر بین دو نقطه از سرویس مسیریابی مشهد.

    بدنه‌ی درخواست (JSON):
        {
            "origin": {"lat": 36.312, "lon": 59.586},
            "destination": {"lat": 36.307, "lon": 59.552},
            "vehicle_type": "car"  (اختیاری، پیش‌فرض car)
        }

    پاسخ: همان پاسخ خام سرویس map.mashhad.ir (معمولاً GeoJSON LineString)
    """
    body = request.get_json(silent=True) or {}
    origin = body.get("origin")
    destination = body.get("destination")
    vehicle_type = body.get("vehicle_type", "car")

    # اعتبارسنجی مختصات
    if not isinstance(origin, dict) or not isinstance(destination, dict):
        return jsonify({
            "error": "origin و destination باید شامل lat و lon باشند."
        }), 400

    try:
        origin_lat = float(origin.get("lat"))
        origin_lon = float(origin.get("lon"))
        dest_lat = float(destination.get("lat"))
        dest_lon = float(destination.get("lon"))
    except (TypeError, ValueError):
        return jsonify({"error": "مختصات معتبر نیست."}), 400

    try:
        api_response = session.get(
            ROUTING_API_URL,
            params={
                "origin": f"{origin_lat},{origin_lon}",
                "destination": f"{dest_lat},{dest_lon}",
                "avoidTrafficZone": "false",
                "vehicle_type": vehicle_type,
            },
            headers={
                "Accept": "application/json, text/plain, */*",
                "Accept-Language": "fa",
                "Content-Type": "application/json",
                "User-Agent": "ParkingApp/1.0",
                "Referer": "https://map.mashhad.ir/fa",
            },
            timeout=20,
        )

        api_response.raise_for_status()
        data = api_response.json()

        response = jsonify(data)
        response.headers["Cache-Control"] = "no-store"
        return response

    except (requests.RequestException, ValueError) as exc:
        app.logger.exception("خطا در دریافت مسیر")
        return jsonify({
            "error": "دریافت مسیر ناموفق بود.",
            "detail": str(exc)
        }), 502


@app.get("/api/search-address")
def search_address():
    """
    جستجوی آدرس با استفاده از OSM Nominatim.
    محدود به شهر مشهد برای نتایج دقیق‌تر.

    پارامترهای query:
        q: عبارت جستجو (مثلاً "آزادشهر" یا "بلوار وکیل‌آباد")

    پاسخ:
        {
            "results": [
                {
                    "display_name": "آزادشهر، مشهد، ایران",
                    "lat": 36.312,
                    "lon": 59.586,
                    "type": "neighbourhood"
                },
                ...
            ]
        }
    """
    query = request.args.get("q", "").strip()

    if not query or len(query) < 2:
        return jsonify({"results": []})

    try:
        api_response = session.get(
            SEARCH_API_URL,
            params={
                "q": query,
                "format": "json",
                "limit": 5,
                "accept-language": "fa",
                "countrycodes": "ir",
                # محدود کردن به محدوده‌ی مشهد (bbox: south,west,north,east)
                "viewbox": "59.30,36.10,59.80,36.50",
                "bounded": "1",
            },
            headers={
                "Accept": "application/json",
                "User-Agent": "ParkingApp/1.0 (mashhad-parking.app)",
            },
            timeout=10,
        )

        api_response.raise_for_status()
        data = api_response.json()

        if not isinstance(data, list):
            return jsonify({"results": []})

        # فیلتر کردن نتایج برای مشهد و فیلد‌های مورد نیاز
        results = []
        for item in data:
            if not isinstance(item, dict):
                continue

            display_name = item.get("display_name", "")
            lat = item.get("lat")
            lon = item.get("lon")

            # فقط نتایجی که مختصات دارن
            if not lat or not lon:
                continue

            results.append({
                "display_name": display_name,
                "lat": float(lat),
                "lon": float(lon),
                "type": item.get("type") or item.get("class") or "unknown",
                "name": item.get("name", ""),
            })

        response = jsonify({"results": results})
        response.headers["Cache-Control"] = "no-store"
        return response

    except (requests.RequestException, ValueError) as exc:
        app.logger.exception("خطا در جستجوی آدرس")
        return jsonify({
            "error": "جستجوی آدرس ناموفق بود.",
            "detail": str(exc)
        }), 502


if __name__ == "__main__":
    app.run(debug=True)
