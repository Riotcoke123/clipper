# Ensure you have the requests library installed: pip install requests
import requests
import json
import time # Used for optional delays

# --- Configuration ---

# User IDs to check
user_ids = [348242, 464860, 465731, 463000, 350101, 352438] # Add more user IDs here if needed

# API Endpoints
base_livestream_url = "https://api-backend.parti.com/parti_v2/profile/get_livestream_channel_info/" # Source for live status, viewer_count, event_name
base_profile_url = "https://api-backend.parti.com/parti_v2/profile/user_profile/" # Source for user_name, avatar_link

# Output file path
output_path = r"C:\Users\srrm4\Desktop\parti_streamer_status_final_sorted.json" # Changed filename

# --- End Configuration ---

# List to store the final results for JSON output
results_output = []

# Headers to mimic a browser request
headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
}

# --- Helper function for making API requests ---
def get_api_data(url, user_id, data_type):
    """ Fetches and parses JSON data. Returns (parsed_data, error_message) """
    print(f"   Requesting {data_type} info for user {user_id} from: {url}")
    try:
        response = requests.get(url, headers=headers, timeout=10)
        if response.status_code == 200:
            try:
                data = response.json()
                print(f"   ✅ Successfully fetched and parsed {data_type} data for user {user_id}.")
                return data, None
            except json.JSONDecodeError:
                error_msg = f"{data_type} JSON Decode Error"
                print(f"   ❌ Error: {error_msg} for user {user_id}.")
                return None, error_msg
            except Exception as e_parse:
                error_msg = f"{data_type} Data Parse Error: {e_parse}"
                print(f"   ❌ Error parsing {data_type} data for user {user_id}: {e_parse}")
                return None, error_msg
        else:
            error_msg = f"{data_type} HTTP Error {response.status_code}"
            print(f"   ❌ Error: {data_type} request failed for user {user_id} with status code {response.status_code}")
            return None, error_msg
    except requests.exceptions.Timeout:
        error_msg = f"Network Timeout fetching {data_type}"
        print(f"❌ {error_msg} for user {user_id}")
        return None, error_msg
    except requests.exceptions.RequestException as e_req:
        error_msg = f"Network/Request Error fetching {data_type}: {e_req}"
        print(f"❌ {error_msg} for user {user_id}")
        return None, error_msg
    except Exception as e_general:
        error_msg = f"Unexpected Error fetching {data_type}: {e_general}"
        print(f"❌ {error_msg} for user {user_id}")
        return None, error_msg

# --- Main Processing Loop ---
print(f"Starting checks for {len(user_ids)} users...")

for user_id in user_ids:
    print(f"\n🔍 Checking user {user_id}...")

    # --- Step 1: Fetch data ---
    livestream_url = f"{base_livestream_url}{user_id}"
    livestream_data, live_error = get_api_data(livestream_url, user_id, "Livestream")

    profile_url = f"{base_profile_url}{user_id}"
    profile_data, profile_error = get_api_data(profile_url, user_id, "Profile")

    # --- Step 2: Initialize variables ---
    is_live = False
    viewer_count = None
    event_name = None
    user_name = None
    avatar_link = None
    combined_error = None

    if live_error: combined_error = f"Livestream Error: {live_error}"
    if profile_error: combined_error = f"{combined_error}; Profile Error: {profile_error}" if combined_error else f"Profile Error: {profile_error}"

    # --- Step 3: Process Livestream Data ---
    if livestream_data:
        is_live = livestream_data.get("is_streaming_live_now") is True
        if is_live:
             # Corrected nested data extraction
             viewer_count = None
             event_name = None
             channel_info = livestream_data.get("channel_info")
             if channel_info and isinstance(channel_info, dict):
                 stream_info = channel_info.get("stream")
                 if stream_info and isinstance(stream_info, dict):
                     viewer_count = stream_info.get("viewer_count")
                 livestream_event_info = channel_info.get("livestream_event_info")
                 if livestream_event_info and isinstance(livestream_event_info, dict):
                     event_name = livestream_event_info.get("event_name")

    # --- Step 4: Process Profile Data ---
    if profile_data:
        user_name = profile_data.get("user_name")
        avatar_link = profile_data.get("avatar_link")

    # --- Step 5: Construct Output Dictionary for this user ---
    user_output = {
        "user_id": user_id,
        "is_live": is_live,
        "user_name": user_name,
        "avatar_link": avatar_link,
    }
    if is_live:
        # Add viewer_count and event_name ONLY if live
        # (Value might be None if API didn't provide it, even if live)
        user_output["viewer_count"] = viewer_count
        user_output["event_name"] = event_name
        print(f"   🟢 User {user_id} ({user_name or 'N/A'}) is LIVE. Viewers: {viewer_count}, Event: {event_name}")
    else:
        # Print appropriate offline message
        if livestream_data and not is_live: print(f"   ⚪ User {user_id} ({user_name or 'N/A'}) is OFFLINE.")
        elif live_error: print(f"   ⚪ User {user_id} ({user_name or 'N/A'}) is OFFLINE due to API error.")
        else: print(f"   ⚪ User {user_id} ({user_name or 'N/A'}) is OFFLINE.")

    if combined_error:
        user_output["error_details"] = combined_error
        print(f"   ⚠️ Recorded error details for user {user_id}: {combined_error}")

    # Append the dictionary for this user to the main list
    results_output.append(user_output)

    # time.sleep(1) # Optional delay

# --- NEW: Sorting Step ---
print(f"\n📊 Sorting {len(results_output)} results by viewer count (high to low)...")

# Define a helper function to get the viewer count for sorting
# Handles missing key, None value, or non-integer types safely
def get_viewer_count_for_sort(user_dict):
    count = user_dict.get("viewer_count") # Get value, defaults to None if key missing
    if isinstance(count, int):
        return count  # Return the integer count if valid
    else:
        return -1     # Return -1 for sorting if count is None, missing, or not an int

# Use sorted() to create a NEW list, sorted in reverse (descending)
# based on the value returned by the key function
sorted_results = sorted(results_output, key=get_viewer_count_for_sort, reverse=True)

print("   Sorting complete.")
# --- End Sorting Step ---


# --- Step 6: Save results to JSON file ---
# Use the sorted_results list now
print(f"\n💾 Attempting to save sorted data for {len(sorted_results)} users to {output_path}...")
try:
    with open(output_path, "w", encoding='utf-8') as f:
        # Write the SORTED list to the file
        json.dump(sorted_results, f, indent=4, ensure_ascii=False)
    print(f"\n✅ Finished successfully. Sorted data saved to {output_path}")
except IOError as e_io:
    print(f"\n❌ Error writing file: {e_io}")
except Exception as e_write:
     print(f"\n❌ Unexpected error writing file: {e_write}")