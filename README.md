# दियो online radio

A free internet radio station you deploy yourself on **GitHub + Vercel**. No paid services. Green and orange, with a classic old-radio look.

- **Never silent:** when nothing is scheduled, it automatically plays free Creative Commons music from Jamendo (genre you choose, default "relaxing"), even with an empty library
- Plays free Creative Commons music (Jamendo) and **your own recordings** (Internet Archive, Google Drive, direct MP3 links)
- An **AI host** speaks between tracks (Gemini Flash or Mistral free tier, spoken by the browser's built-in voice)
- A **weekly schedule** so everyone hears the same thing at the same time (default timezone Asia/Kathmandu)
- **Go Live** from your microphone to listeners (WebRTC via PeerJS), mixed with tracks from your library
- **Vintage radio player:** tuning dial with a needle that "tunes" to each track, speaker grille, amber display, a rotary volume knob (drag, scroll or use arrow keys) and a big classic play button
- **Sleep timer** (15 / 30 / 60 minutes), **recently played** list, **share** button, **install as an app** (works like a phone app), lock-screen play/stop controls
- **Song requests and dedications:** listeners send a message, you read it in the admin "Requests" tab and play it on air (needs Supabase; messages are private)

Plain HTML/CSS/JavaScript, plus a few Vercel serverless functions that keep your keys secret.

```
ai-radio-station/
├─ api/                      Vercel serverless functions (keys stay here)
│  ├─ _lib/util.js           password check, rate limiter
│  ├─ _lib/store.js          Supabase read/write
│  ├─ login.js               admin login
│  ├─ state.js               load/save library, playlists, schedule, settings
│  ├─ host.js                AI host line (Gemini / Mistral) + optional weather
│  ├─ messages.js            listener requests / dedications (admin reads them)
│  ├─ live.js                shared "are we live?" signal (admin heartbeat, listeners poll)
│  ├─ health.js              setup checker: open /api/health to see which keys the server can see
│  ├─ jamendo.js             Jamendo music search proxy
│  ├─ archive.js             Internet Archive metadata fallback proxy
│  └─ time.js                server clock (keeps all listeners in sync)
├─ public/
│  ├─ index.html             listener page
│  ├─ admin.html             admin page
│  ├─ css/style.css          green & orange theme + vintage radio
│  ├─ manifest.webmanifest, sw.js, icon.svg, icons/*.png   install-as-app support
│  ├─ data/state.json        station data file (used when Supabase is not set up)
│  └─ js/  schedule.js  core.js  voice.js  listener.js  admin.js  live.js
├─ tests/schedule.test.js    unit tests for the schedule engine
├─ supabase.sql              one table, run once in Supabase
├─ dev-server.js             run locally with `npm run dev`
├─ vercel.json  package.json  .env.example
```

---

## Setup, step by step

### 1. Get the free keys

**AI host key (pick one)**
- **Gemini (recommended):** go to <https://aistudio.google.com/apikey>, sign in, click *Create API key*. Copy it.
- **Mistral:** go to <https://console.mistral.ai>, create an account, open *API keys*, create a key on the free (Experiment) plan.

Free tiers have rate limits, not "unlimited" use. The app is built for that: it asks for one short line per track, caches lines, and if the AI is slow or rate-limited it skips the line and keeps playing music.

**Jamendo key (free music)**
1. Go to <https://devportal.jamendo.com> and sign up.
2. Create an application. You will get a **Client ID**. That is all you need.
3. Free keys are for non-commercial use. Check each track's licence if you ever monetise the station.

**Supabase (free database, optional but recommended)**
1. Go to <https://supabase.com>, create a free project.
2. Open *SQL Editor → New query*, paste the contents of `supabase.sql`, press *Run*. It creates two tables: the station data and the listener requests. (If you ran an older version of this file, run it again: it is safe to repeat.)
3. Open *Project Settings → API*. Copy the **Project URL** and the **service_role** key (keep this one secret; it only goes into Vercel, never into the browser).

> No Supabase? It still works: the admin page has **Export JSON**. Save the file as `public/data/state.json`, push to GitHub, and Vercel redeploys with your station data.

### 2. Put the project on GitHub
1. Create a new empty repository on <https://github.com/new>.
2. In this folder:
   ```bash
   git init
   git add .
   git commit -m "AI Radio Station"
   git branch -M main
   git remote add origin https://github.com/YOUR-NAME/YOUR-REPO.git
   git push -u origin main
   ```
   `.env` files are git-ignored, so keys never get uploaded.

### 3. Deploy on Vercel
1. Go to <https://vercel.com>, sign in with GitHub, click *Add New → Project*, and import your repo.
2. Leave the framework as **Other**. Don't change the build settings (`vercel.json` already points to `public/`).
3. Before pressing *Deploy*, open **Environment Variables** and add:

| Name | Value |
|---|---|
| `ADMIN_PASSWORD` | a long password only you know |
| `GEMINI_API_KEY` | your Gemini key (or `MISTRAL_API_KEY`) |
| `JAMENDO_CLIENT_ID` | your Jamendo client id |
| `SUPABASE_URL` | your Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | your Supabase service_role key |

4. Press **Deploy**. Your radio is at `https://YOUR-PROJECT.vercel.app` and the admin page at `/admin`.
5. If you change a variable later, redeploy (*Deployments → ⋯ → Redeploy*).

### 4. First run (about 10 minutes)
1. Open `/admin` and log in.
2. **Library:** search Jamendo (try `lofi`), press *Add all*. Add your own recordings from Internet Archive.
3. **Playlists:** create one and tick tracks. Set it as the default playlist under *Schedule*.
4. **AI host:** choose name, personality, language and how often to speak. Press *Generate & speak a test line*.
5. **Schedule:** add slots (days, start/end, playlist / single recording / auto music by genre). Under *When nothing is scheduled* choose what plays the rest of the time: free Jamendo music (default), a playlist, or your whole library.
6. Press **Save changes**. Open the main page, press the big play button.

---

## Schedule times and editing

Times use simple dropdowns (hour, minute, AM/PM) so they can be edited on any phone or computer. Each timetable row has an **Edit** button: it loads the slot into the form, and **Save changes to this slot** updates it. For an all-day slot use 12:00 AM to 11:59 PM; an end time earlier than the start continues past midnight.

## Free music when nothing is scheduled

The default programme is **free Jamendo music**. The listener page asks `/api/jamendo` for popular tracks with your chosen tag (admin → Schedule → *When nothing is scheduled*) and plays them in a fixed order, so everyone hears the same song at the same moment. It needs only the free `JAMENDO_CLIENT_ID`. If Jamendo is unreachable, the station falls back to your library, and if that is empty the page says the free music could not load. Free Jamendo keys are for non-commercial use.

## Song requests and dedications

With Supabase set up, the radio page shows a request form (name, type, 200-character message). It is rate-limited and has a hidden bot trap. Messages are **private**: only the admin sees them (Admin → *Requests*), and nothing is published automatically. Without Supabase the form is hidden.

## Install as an app

When someone opens the radio on an **Android phone**, a green banner appears at the top: **"दियो radio एप इन्स्टल गर्नुहोस्"** with an **Install** button. Tapping it shows Android's own install box; after they accept, the radio is on their home screen with the diya icon and opens full screen like a normal app. Updates arrive automatically, because the app is just your website.

- If the browser does not offer the install box by itself (for example Samsung Internet or Firefox), the banner shows a **How?** button with the manual steps: browser menu (three dots), then **Install app** or **Add to Home screen**.
- On iPhone the banner explains: Safari, Share button, **Add to Home Screen**.
- Closing the banner hides it for a week. It never shows inside the installed app or on computers.
- Requirements already handled: HTTPS (Vercel), a web app manifest with 192 and 512 pixel icons (`public/icons`), and a service worker (`public/sw.js`). The app only caches the page itself; audio always streams live.

## Adding your own recordings

**Internet Archive (best, use this first).** Upload your audio at <https://archive.org/upload>. Paste the item link (like `https://archive.org/details/my-recordings`) or just the identifier into the admin library. The app reads `https://archive.org/metadata/ITEM`, lists every audio file, and streams from `https://archive.org/download/ITEM/FILE`.

**Google Drive (works for small files, can fail).** Set the file to *Anyone with the link* and paste the share link. It is converted to a direct stream URL from the file ID. Drive can fail for large files (it can show a virus-scan page instead of audio) and when many people listen at once. The app tells you this and tests the link before adding it.

**Direct MP3 URL.** Any public `https://…mp3` link.

Only use audio you own or have permission to play.

## How "everyone hears the same thing" works

The player never keeps a private playlist position. Every second it asks: *given the schedule, the library and the clock, what should be playing right now, and how many seconds into it?* Everyone with the same data gets the same answer, so a new listener joins mid-track at the correct spot. Playlists loop to fill their slot. The clock comes from the server (`/api/time`), so a wrong phone clock does not desync a listener. Tracks need a correct **duration**, which is why the app measures it when you add one.

## Going live

1. Admin → **Go live** → press the button and allow the microphone.
2. **The scheduled programme stops for everyone within about 5 seconds.** Listeners see a red **LIVE** badge and hear you. The page checks a shared live signal (`/api/live`, stored in your Supabase table, no new setup needed) and then connects to your microphone.
3. **When you press Stop broadcast, the schedule continues** at the position it should be at that moment (the same song everyone would be hearing). If your tab closes or loses internet, the signal expires after 30 seconds and listeners return to the schedule by themselves.
4. If a listener's network cannot connect to you (strict firewalls), after 20 seconds their page plays the schedule again and keeps retrying, instead of leaving them in silence.
5. Use *Mute mic*, play a library track into the broadcast, and let the music duck while you talk.

Honest limits:
- Audio goes **directly from your device to each listener**. Keep it to about **20 listeners** (the page warns you).
- **Keep the tab open and the screen awake** (the app requests a screen wake lock, but a locked phone can still stop it).
- Some networks (strict firewalls, some mobile carriers) block peer-to-peer connections. This setup uses free STUN servers only, which cannot relay audio.
- Library tracks in the broadcast only work if the audio host allows cross-origin use (Internet Archive does; Google Drive does not). Wear headphones to avoid echo.
- The broadcast id is saved with your station settings. With Supabase this happens automatically when you press *Go live*. Without Supabase, press *Go live* once, export the JSON, commit it, and redeploy; after that it works.

## Run locally

```bash
cp .env.example .env.local     # fill in values
npm run dev                    # http://localhost:3000
npm test                       # schedule engine tests
```
The microphone needs `https` or `localhost`.

## Troubleshooting

| Problem | Fix |
|---|---|
| Nothing plays until I tap | Browsers block autoplay. Press the big play button once. |
| "No Nepali voice on this device" | Voices come from the device. Chrome on Android usually has one; otherwise install a voice in system settings. The app falls back to a Hindi or default voice and tells you. |
| Host never speaks | Check `GEMINI_API_KEY` / `MISTRAL_API_KEY` in Vercel and redeploy. Use the *test line* button in Admin → AI host to see the error. |
| Jamendo search fails | Check `JAMENDO_CLIENT_ID`. |
| Drive track stops or errors | Expected for big files. Move it to Internet Archive. |
| Changes don't show for listeners | They refresh about every minute. Without Supabase you must commit `public/data/state.json`. |
| Wrong programme time | Admin → Station & data → Timezone. |
| "Free music could not load" | Check `JAMENDO_CLIENT_ID` in Vercel and redeploy, or add tracks/playlist and choose them as the default programme. |
| English host says the station name oddly | Set *Name for an English-speaking host* (Station & data) to a spelling like "Diyo Online Radio". The Nepali name is used when the host speaks Nepali. |
| Request form is missing | It only appears when Supabase is configured. |
| `Gemini HTTP 404` | Google renamed the model. Set `GEMINI_MODEL` in Vercel to a current Flash model. |

## Security notes
- The admin password is only checked on the server. A successful login returns a token derived from the password with HMAC; saving requires it. Login attempts are rate-limited (best effort on serverless).
- Public visitors can read the station data and ask for host lines (rate-limited) but cannot change anything.
- Never commit `.env` files or the Supabase `service_role` key.
