import json
import time
import re
from pathlib import Path
import logging
import dateparser
import undetected_chromedriver as uc
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.chrome.options import Options
from selenium.common.exceptions import TimeoutException, NoSuchElementException
from webdriver_manager.chrome import ChromeDriverManager

# Set up logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)
logger = logging.getLogger(__name__)

# --- Configuration ---
usernames = ["waxiest", "loulz", "ac7ionman", "asianandy", "lettyvision", "iholly", "adrianahlee", "garydavid", "bennymack", "mikesmallsjr", "crazytawn", "jandro", "n3on", "Deepak",
             "mskat", "edboys", "floridaboymma", "dtanmanb", "iduncle", "cristravels", "burgerplanet", "tazo", "billyjohn",
             "mando", "iceposeidon", "nedx", "kevtv", "andy", "bongbong_irl", "hamptonbrando", "ddurantv", "boneclinks", "fousey"]

# Save to Desktop using pathlib
desktop_path = Path.home() / "Desktop"
json_path = desktop_path / "kick_streamers_data.json"


# --- Setup WebDriver ---
logger.info("🔧 Initializing undetected Chrome...")
options = Options()
options.add_argument("--start-maximized")

try:
    driver = uc.Chrome(options=options, use_subprocess=True)
    logger.info("✅ WebDriver initialized.")
except Exception as e:
    logger.error(f"❌ Failed to initialize WebDriver: {e}")
    exit()

# --- Set Custom Headers ---
try:
    logger.info("📡 Setting custom headers...")
    driver.execute_cdp_cmd("Network.enable", {})
    driver.execute_cdp_cmd("Network.setExtraHTTPHeaders", {
        "headers": {
            "sec-ch-ua": '"Google Chrome";v="135", "Not-A.Brand";v="8", "Chromium";v="135"',
            "sec-ch-ua-mobile": "?0",
            "sec-ch-ua-platform": '"Windows"',
            "sec-fetch-dest": "empty",
            "sec-fetch-mode": "cors",
            "sec-fetch-site": "same-origin",
            "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
            "x-client-token": "e1393935a959b4020a4491574f6490129f678acdaa92760471263db43487f823"
        }
    })
    logger.info("✅ Headers applied.")
except Exception as e:
    logger.warning(f"⚠️ Could not set headers: {e}")

# --- Helper Functions ---
def parse_viewers(text):
    """Converts viewer text like '1.2k' or '1m' into a number."""
    try:
        text = text.lower().replace(",", "").strip()
        if 'k' in text:
            return int(float(text.replace('k', '')) * 1000)
        elif 'm' in text:
            return int(float(text.replace('m', '')) * 1000000)
        return int(text)
    except:
        return 0

def parse_last_broadcast(text):
    """Converts a 'last_broadcast' string like '5 minutes ago' to seconds using dateparser."""
    if not text or text.lower() == "not available":
        return float('inf')  # Push to bottom
    
    try:
        # Use dateparser to parse relative time expressions
        parsed_time = dateparser.parse(text)
        if parsed_time:
            # Calculate seconds since broadcast
            seconds_ago = (time.time() - parsed_time.timestamp())
            return seconds_ago
    except:
        pass
    
    # Fallback to the original regex method if dateparser fails
    text = text.lower()
    time_map = {
        "second": 1,
        "minute": 60,
        "hour": 3600,
        "day": 86400,
        "week": 604800,
        "month": 2592000  # Assuming 30 days per month for simplicity
    }

    match = re.match(r"(\d+)\s+(second|minute|hour|day|week|month)s?\s+ago", text)
    if match:
        value = int(match.group(1))
        unit = match.group(2)
        return value * time_map.get(unit, 9999999)

    return float('inf')

# --- Sorting ---
def sort_key(x):
    """Custom sorting for live and offline streams."""
    if "viewer_count" in x:  # Live streams sorted by viewers, highest first
        return (0, -x.get("viewer_count", 0))
    else:  # Offline streams sorted by how recent the last broadcast was
        return (1, parse_last_broadcast(x.get("last_broadcast", "")))

# --- Scraping Loop ---
def scrape_loop():
    while True:
        logger.info("\n🔄 Starting new scrape cycle...")
        results = []

        for username in usernames:
            url = f"https://kick.com/{username}"
            logger.info(f"\n🔍 Checking {username} ({url})...")
            data = {}

            try:
                driver.get(url)
                time.sleep(2)

                wait = WebDriverWait(driver, 20)
                wait.until(EC.presence_of_element_located((By.ID, "channel-content")))

                # Check live status
                is_live = False
                try:
                    live_badge = WebDriverWait(driver, 5).until(
                        EC.visibility_of_element_located((By.CSS_SELECTOR,
                            "#channel-content > div.flex.w-full.min-w-0.max-w-full.flex-col.justify-between.gap-3.pb-3.pt-2.lg\\:flex-row.lg\\:gap-12.lg\\:pb-0.lg\\:pt-0 > div.flex.max-w-full.shrink.grow-0.flex-row.gap-2.overflow-hidden.lg\\:gap-4 > div.shrink-0 > button > div > span"
                        ))
                    )
                    if live_badge and "live" in live_badge.text.lower():
                        is_live = True
                        logger.info("🎥 Stream is LIVE.")
                except:
                    logger.info("📴 Stream is OFFLINE.")

                # Username (from display if possible)
                try:
                    name_elem = driver.find_element(By.CSS_SELECTOR, "#channel-username")
                    display_name = name_elem.text
                except NoSuchElementException:
                    display_name = username

                # Profile photo
                try:
                    if is_live:
                        avatar = driver.find_element(By.CSS_SELECTOR, "#channel-avatar img")
                    else:
                        avatar = driver.find_element(By.CSS_SELECTOR, "#channel-content img.rounded-full")
                    profile_photo = avatar.get_attribute("src")
                except:
                    profile_photo = "Not Found"

                # If LIVE
                if is_live:
                    try:
                        title_elem = driver.find_element(By.CSS_SELECTOR,
                            "#channel-content > div.flex.w-full.min-w-0.max-w-full.flex-col.justify-between.gap-3.pb-3.pt-2.lg\\:flex-row.lg\\:gap-12.lg\\:pb-0.lg\\:pt-0 > div.flex.max-w-full.shrink.grow-0.flex-row.gap-2.overflow-hidden.lg\\:gap-4 > div.flex.max-w-full.grow.flex-col.gap-1.overflow-hidden > div.flex.min-w-0.max-w-full.shrink.gap-1.overflow-hidden > span"
                        )
                        viewers_elem = driver.find_element(By.CSS_SELECTOR,
                            "#channel-content > div.flex.w-full.min-w-0.max-w-full.flex-col.justify-between.gap-3.pb-3.pt-2.lg\\:flex-row.lg\\:gap-12.lg\\:pb-0.lg\\:pt-0 > div.flex.shrink-0.flex-col.items-end.gap-2 > div.flex.items-center.gap-2.self-end.py-0\\.5 > div > span > span.relative.tabular-nums"
                        )
                        title = title_elem.text
                        viewer_count = parse_viewers(viewers_elem.text)
                    except:
                        title = "N/A"
                        viewer_count = 0

                    data = {
                        "username": display_name,
                        "profile_photo": profile_photo,
                        "title": title,
                        "viewer_count": viewer_count
                    }

                # If OFFLINE
                else:
                    try:
                        last_broadcast_elem = driver.find_element(By.CSS_SELECTOR,
                            "#channel-content > div.flex.w-full.min-w-0.max-w-full.flex-col.justify-between.gap-3.pb-3.pt-2.lg\\:flex-row.lg\\:gap-12.lg\\:pb-0.lg\\:pt-0 > div.flex.max-w-full.shrink.grow-0.flex-row.gap-2.overflow-hidden.lg\\:gap-4 > div.flex.max-w-full.grow.flex-col.gap-1.overflow-hidden > span:nth-child(3) > span"
                        )
                        last_broadcast = last_broadcast_elem.text.strip()
                    except:
                        last_broadcast = "Not Available"

                    data = {
                        "username": display_name,
                        "profile_photo": profile_photo,
                        "last_broadcast": last_broadcast
                    }

            except TimeoutException:
                logger.warning(f"⏰ Timeout loading {username}")
                continue
            except Exception as e:
                logger.error(f"⚠️ Error processing {username}: {e}")
                continue

            results.append(data)
            time.sleep(2)

        # Sort results
        results.sort(key=sort_key)

        # Save JSON
        try:
            with open(json_path, "w", encoding="utf-8") as f:
                json.dump(results, f, indent=2, ensure_ascii=False)
            logger.info(f"\n💾 Results saved to {json_path}")
        except Exception as e:
            logger.error(f"❌ Failed to save JSON: {e}")

        logger.info("⏳ Waiting 60 seconds...\n")
        time.sleep(60)

# --- Run ---
try:
    scrape_loop()
except KeyboardInterrupt:
    logger.info("🛑 Script interrupted.")
finally:
    try:
        driver.quit()
        logger.info("✅ WebDriver closed.")
    except:
        logger.warning("⚠️ Error during driver.quit()")
        