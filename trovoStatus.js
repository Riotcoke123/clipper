const fs = require('fs');
const ini = require('ini');
const axios = require('axios');
const dayjs = require('dayjs');
const relativeTime = require('dayjs/plugin/relativeTime');
const pLimit = require('p-limit');

dayjs.extend(relativeTime);

const config = ini.parse(fs.readFileSync('./config.ini', 'utf-8'));
const trovoClientId = config.trovo.client_id;

const limit = pLimit(5);

const trovoAPI = axios.create({
  baseURL: 'https://open-api.trovo.live/openplatform',
  headers: {
    'Client-ID': trovoClientId,
    'Accept': 'application/json',
    'Content-Type': 'application/json',
  }
});

async function getChannelInfo(username) {
  try {
    const res = await trovoAPI.post('/channels/id', { username });
    return res.data;
  } catch (err) {
    console.error(`❌ Error for ${username}:`, err.response?.data || err.message);
    return null;
  }
}

function cleanProfilePic(url) {
  if (!url) return null;
  return url.split('&')[0].split('?')[0];
}

function formatStatus(data) {
  const {
    is_live,
    username,
    channel_url,
    profile_pic,
    live_title,
    current_viewers,
    ended_at
  } = data;

  const cleanPic = cleanProfilePic(profile_pic);

  const base = {
    username,
    profile_pic: cleanPic,
    channel_url: channel_url || `https://trovo.live/${username}`
  };

  if (is_live) {
    return {
      ...base,
      live_title: live_title || '',
      current_viewers: current_viewers || 0,
      status: 'online'
    };
  } else {
    return {
      ...base,
      last_broadcast: ended_at ? dayjs.unix(Number(ended_at)).fromNow() : 'Unknown',
      status: 'offline'
    };
  }
}

async function checkUsersStatus(usernames) {
  const results = await Promise.all(
    usernames.map(username =>
      limit(async () => {
        const data = await getChannelInfo(username);
        if (!data) return null;
        return formatStatus(data);
      })
    )
  );

  const filtered = results.filter(Boolean);

  fs.writeFileSync('status.json', JSON.stringify(filtered, null, 2));
  console.log('✅ status.json saved');

  filtered.forEach(entry => console.log(entry));
}

const usernames = [
  'SenserTV',
  'iNation',
  'givethemone'
];

checkUsersStatus(usernames);
