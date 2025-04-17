import os
import json
import requests
from pathlib import Path
from flask import Flask, jsonify
from dotenv import load_dotenv
from datetime import datetime

# Load .env from the same folder as this script
load_dotenv(dotenv_path=Path(__file__).parent / "twitch.env")

TWITCH_CLIENT_ID = os.getenv("TWITCH_CLIENT_ID")
TWITCH_CLIENT_SECRET = os.getenv("TWITCH_CLIENT_SECRET")

app = Flask(__name__)

def get_app_access_token():
    print("TWITCH_CLIENT_ID:", TWITCH_CLIENT_ID)
    print("TWITCH_CLIENT_SECRET:", TWITCH_CLIENT_SECRET)

    url = "https://id.twitch.tv/oauth2/token"
    params = {
        'client_id': TWITCH_CLIENT_ID,
        'client_secret': TWITCH_CLIENT_SECRET,
        'grant_type': 'client_credentials'
    }
    try:
        response = requests.post(url, params=params)
        response.raise_for_status()
        token = response.json().get("access_token")
        print("Access token retrieved:", token)
        return token
    except requests.exceptions.HTTPError as http_err:
        print("HTTP error occurred:", http_err)
        print("Response code:", response.status_code)
        print("Response content:", response.text)
    except Exception as e:
        print("Other error occurred:", e)
    return None

def get_users(access_token, logins):
    url = "https://api.twitch.tv/helix/users"
    headers = {
        'Authorization': f'Bearer {access_token}',
        'Client-Id': TWITCH_CLIENT_ID
    }
    params = [('login', login) for login in logins]
    try:
        response = requests.get(url, headers=headers, params=params)
        response.raise_for_status()
        data = response.json().get('data', [])
        return {user['login']: {'id': user['id'], 'profile_image_url': user['profile_image_url']} for user in data}
    except requests.exceptions.RequestException as e:
        print(f"Error getting user information: {e}")
        return None

def get_live_streams(access_token, user_ids):
    url = "https://api.twitch.tv/helix/streams"
    headers = {
        'Authorization': f'Bearer {access_token}',
        'Client-Id': TWITCH_CLIENT_ID
    }
    params = [('user_id', uid) for uid in user_ids]
    try:
        response = requests.get(url, headers=headers, params=params)
        response.raise_for_status()
        return response.json().get('data', [])
    except requests.exceptions.RequestException as e:
        print(f"Error getting live streams: {e}")
        return []

def get_last_broadcast(access_token, user_id):
    url = "https://api.twitch.tv/helix/videos"
    headers = {
        'Authorization': f'Bearer {access_token}',
        'Client-Id': TWITCH_CLIENT_ID
    }
    params = {
        'user_id': user_id,
        'first': 1,
        'type': 'archive'  # "archive" = past broadcast
    }
    try:
        response = requests.get(url, headers=headers, params=params)
        response.raise_for_status()
        videos = response.json().get('data', [])
        return videos[0] if videos else None
    except requests.exceptions.RequestException as e:
        print(f"Error getting last broadcast: {e}")
        return None

def fetch_twitch_data():
    access_token = get_app_access_token()
    if not access_token:
        return {"error": "Could not retrieve access token", "live_streamers": [], "offline_streamers": []}

    twitch_usernames = ["dohertyjack", "boyflyirl", "jewelrancidlive", "dankquan", "vpgloves", "kaicenat", "gcwrestling", "trumporbiden2028"]
    user_data_map = get_users(access_token, twitch_usernames)
    if not user_data_map:
        return {"error": "Could not retrieve user information", "live_streamers": [], "offline_streamers": []}

    user_ids = [data['id'] for data in user_data_map.values()]
    live_streams_data = get_live_streams(access_token, user_ids)

    live_streamers = []
    offline_streamers = []

    live_user_ids = [stream['user_id'] for stream in live_streams_data]

    for stream in live_streams_data:
        user_id = stream['user_id']
        username = next((name for name, data in user_data_map.items() if data['id'] == user_id), None)
        if username:
            live_streamers.append({
                "profile_photo": user_data_map[username]['profile_image_url'],
                "username": username,
                "title": stream['title'],
                "viewer_count": stream['viewer_count']
            })

    live_streamers.sort(key=lambda x: x['viewer_count'], reverse=True)

    offline_usernames = [name for name in twitch_usernames if user_data_map[name]['id'] not in live_user_ids]
    
    for username in offline_usernames:
        user_id = user_data_map[username]['id']
        last_broadcast = get_last_broadcast(access_token, user_id)
        
        offline_info = {
            "profile_photo": user_data_map[username]['profile_image_url'],
            "username": username
        }

        if last_broadcast:
            broadcast_time = last_broadcast.get("created_at")
            try:
                dt = datetime.strptime(broadcast_time, "%Y-%m-%dT%H:%M:%SZ")
                formatted_time = dt.strftime("%Y-%m-%d %H:%M:%S")
            except Exception:
                formatted_time = broadcast_time

            offline_info["last_stream_time"] = formatted_time

        offline_streamers.append(offline_info)

    # Sort offline streamers by last stream time (low to high)
    offline_streamers.sort(key=lambda x: x.get("last_stream_time", "9999-12-31 23:59:59"))

    return {
        "live_streamers": live_streamers,
        "offline_streamers": offline_streamers
    }

@app.route('/twitch_data')
def get_twitch_data():
    twitch_data = fetch_twitch_data()

    file_path = Path.home() / "Desktop" / "twitch_data.json"
    try:
        with open(file_path, "w", encoding="utf-8") as f:
            json.dump(twitch_data, f, indent=4)
        print(f"Twitch data saved to {file_path}")
    except Exception as e:
        print(f"Failed to save JSON: {e}")

    return jsonify(twitch_data)

if __name__ == "__main__":
    app.run(host='0.0.0.0', port=5001, debug=True)
