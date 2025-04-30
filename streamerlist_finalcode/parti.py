import requests
import json
import time
from datetime import datetime

user_ids = [348242, 464860, 465731, 463000, 350101, 352438]

base_livestream_url = "https://api-backend.parti.com/parti_v2/profile/get_livestream_channel_info/"
base_profile_url = "https://api-backend.parti.com/parti_v2/profile/user_profile/"
base_recent_url = "https://api-backend.parti.com/parti_v2/profile/user_profile_feed/"

output_path = r"parti.json"

headers = {
    'User-Agent': 'Mozilla/5.0'
}

def get_api_data(url, user_id, data_type):
    try:
        response = requests.get(url, headers=headers, timeout=10)
        if response.status_code == 200:
            return response.json(), None
        else:
            return None, f"{data_type} HTTP Error {response.status_code}"
    except requests.exceptions.Timeout:
        return None, f"Timeout fetching {data_type}"
    except requests.exceptions.RequestException as e:
        return None, f"Request Error: {e}"
    except Exception as e:
        return None, f"Unexpected Error: {e}"

def get_relative_time(epoch_ts):
    now = time.time()
    diff = now - epoch_ts

    if diff < 60:
        return f"{int(diff)} seconds ago"
    elif diff < 3600:
        return f"{int(diff // 60)} minutes ago"
    elif diff < 86400:
        return f"{int(diff // 3600)} hours ago"
    elif diff < 2592000:
        return f"{int(diff // 86400)} days ago"
    elif diff < 31104000:
        return f"{int(diff // 2592000)} months ago"
    else:
        return f"{int(diff // 31104000)} years ago"

while True:
    results_output = []
    print("\nStarting check for users...")

    for user_id in user_ids:
        print(f"Checking user {user_id}...")

        livestream_data, live_error = get_api_data(f"{base_livestream_url}{user_id}", user_id, "Livestream")
        profile_data, profile_error = get_api_data(f"{base_profile_url}{user_id}", user_id, "Profile")

        is_live = False
        viewer_count = None
        event_name = None
        user_name = None
        avatar_link = None
        last_broadcast = None
        combined_error = None

        if live_error:
            combined_error = f"Livestream Error: {live_error}"
        if profile_error:
            combined_error = f"{combined_error}; Profile Error: {profile_error}" if combined_error else f"Profile Error: {profile_error}"

        if livestream_data:
            is_live = livestream_data.get("is_streaming_live_now") is True
            if is_live:
                channel_info = livestream_data.get("channel_info", {})
                stream_info = channel_info.get("stream", {})
                viewer_count = stream_info.get("viewer_count")
                event_name = channel_info.get("livestream_event_info", {}).get("event_name")

        if profile_data:
            user_name = profile_data.get("user_name")
            avatar_link = profile_data.get("avatar_link")

        user_output = {
            "user_id": user_id,
            "is_live": is_live,
            "user_name": user_name,
            "avatar_link": avatar_link
        }

        if is_live:
            user_output["viewer_count"] = viewer_count
            user_output["event_name"] = event_name
            print(f"User {user_id} is LIVE. Viewers: {viewer_count}")
        else:
            recent_data, recent_error = get_api_data(f"{base_recent_url}{user_id}?&limit=5", user_id, "Recent Feed")
            if recent_data and isinstance(recent_data, list) and len(recent_data) > 0:
                latest = recent_data[0]
                created_at = latest.get("created_at")
                if isinstance(created_at, int):
                    relative_time = get_relative_time(created_at)
                    user_output["last_broadcast"] = relative_time
            elif recent_error:
                user_output["recent_error"] = recent_error

        if combined_error:
            user_output["error_details"] = combined_error

        results_output.append(user_output)

    live_users = [u for u in results_output if u.get("is_live")]
    live_users.sort(key=lambda x: x.get("viewer_count", -1), reverse=True)

    def extract_broadcast_age(user):
        text = user.get("last_broadcast")
        if not text:
            return float('inf')

        units = {
            "second": 1,
            "minute": 60,
            "hour": 3600,
            "day": 86400,
            "month": 2592000,
            "year": 31104000
        }

        parts = text.split()
        try:
            value = int(parts[0])
            unit = parts[1].rstrip("s") 
            return value * units.get(unit, float('inf'))
        except:
            return float('inf')

    offline_users = [u for u in results_output if not u.get("is_live")]
    offline_users.sort(key=extract_broadcast_age)

    sorted_results = live_users + offline_users

    print(f"\nSaving sorted data to {output_path}...")
    try:
        with open(output_path, "w", encoding='utf-8') as f:
            json.dump(sorted_results, f, indent=4, ensure_ascii=False)
        print("Data saved successfully.")
    except Exception as e:
        print(f"Failed to write file: {e}")

    time.sleep(60)

