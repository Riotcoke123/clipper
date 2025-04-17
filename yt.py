import json
from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.common.by import By
import time
import os

channel_ids = [
    "UCueVr5KzwKPzTcFjcDUfMMw",
    "UCUNfKvI45t9zMsuLzbqigqA",
    "UCUNHxLIQ1AgtYCTGXxBvX2w",
    "UCjYKsjt-7EDU78KEcVbhYnQ"
]

def get_driver():
    options = Options()
    options.add_argument("--headless")
    options.add_argument("--disable-gpu")
    options.add_argument("--enable-unsafe-webgpu")
    options.add_argument("--disable-software-rasterizer")
    options.add_argument("--no-sandbox")
    return webdriver.Chrome(options=options)

def get_stream_info(channel_id):
    url = f"https://www.youtube.com/channel/{channel_id}/live"
    driver = get_driver()
    driver.get(url)
    time.sleep(5)

    try:
        viewer_count_element = driver.find_element(By.CSS_SELECTOR, "#view-count > yt-animated-rolling-number")
        viewer_count = viewer_count_element.text.replace(",", "").split()[0]
        viewer_count = int(viewer_count)

        username = driver.find_element(By.CSS_SELECTOR, "#text > a").text
        profile_photo = driver.find_element(By.CSS_SELECTOR, "#img").get_attribute("src")
        title = driver.find_element(By.CSS_SELECTOR, "#title > h1 > yt-formatted-string").text

        result = {
            "channel_id": channel_id,
            "status": "live",
            "username": username,
            "profile_photo": profile_photo,
            "viewer_count": viewer_count,
            "title": title
        }

    except:
        # Fallback: offline
        driver.get(f"https://www.youtube.com/channel/{channel_id}")
        time.sleep(5)
        try:
            username = driver.find_element(By.CSS_SELECTOR, "#page-header h1 span").text
            profile_photo = driver.find_element(By.CSS_SELECTOR, "#page-header img").get_attribute("src")
            last_broadcast = driver.find_element(By.CSS_SELECTOR, "#metadata-line > span:nth-child(4)").text
        except:
            username = "Unknown"
            profile_photo = ""
            last_broadcast = "Unavailable"

        result = {
            "channel_id": channel_id,
            "status": "offline",
            "username": username,
            "profile_photo": profile_photo,
            "last_broadcast": last_broadcast
        }

    driver.quit()
    return result

def main():
    all_data = []
    for channel_id in channel_ids:
        data = get_stream_info(channel_id)
        all_data.append(data)

    live_streams = [d for d in all_data if d["status"] == "live"]
    live_streams.sort(key=lambda x: x["viewer_count"], reverse=True)

    offline_streams = [d for d in all_data if d["status"] == "offline"]

    final_output = {
        "live_streams": live_streams,
        "offline_streams": offline_streams
    }

    # Save to JSON
    save_path = r"C:\Users\srrm4\Desktop\yt.json"
    with open(save_path, "w", encoding="utf-8") as f:
        json.dump(final_output, f, indent=4, ensure_ascii=False)

    print(f"Data saved to {save_path}")

if __name__ == "__main__":
    main()
