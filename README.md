# Marli Cab

A ride-hailing app for Marli Cab with three roles: **riders** book rides, **drivers** accept and complete trips, and an **admin** approves drivers and watches all rides.

- **Hosting:** GitHub Pages (free) serves the app.
- **Live data:** Supabase (free tier) stores users and rides and pushes real-time updates.
- **Phone app:** installs from the web link, or as a real Android APK built by GitHub Actions.

## Setup (about 15 minutes)

### 1. Create the backend (Supabase)
1. Sign up at https://supabase.com and create a new project.
2. Open **SQL Editor**, paste all of `schema.sql`, and click **Run**.
3. Open **Project Settings > API** and copy the **Project URL** and **anon public** key.
4. (Easier testing) **Authentication > Providers > Email**: turn off "Confirm email". Turn it back on before launch.

### 2. Add your keys
Edit `config.js` and paste the URL and anon key. Also set your prices there (`BASE_FARE`, `PER_KM`, `MIN_FARE`, `CURRENCY`).
The anon key is meant to be public; the rules in `schema.sql` protect the data.

### 3. Put it on GitHub
1. Create a new GitHub repository and upload this whole folder (or `git push` it).
2. In the repo: **Settings > Pages > Source: GitHub Actions**.
3. Push to `main`. The **Deploy web app to GitHub Pages** workflow runs, and your app goes live at `https://YOUR-USERNAME.github.io/YOUR-REPO/`.

### 4. Make yourself admin
Open the live app, sign up with your own email (as a rider), then in Supabase SQL Editor run:

```sql
update public.profiles set role = 'admin', approved = true
where id = (select id from auth.users where email = 'YOUR@EMAIL');
```
Sign out and back in. You'll see the admin dashboard, where you approve drivers.

### 5. Get the downloadable Android app
In your repo: **Actions > Build Android APK > Run workflow**. When it finishes, download `marli-cab-apk` from the run page, unzip it, and send `app-debug.apk` to phones (enable "install unknown apps"). Pushing a tag like `v1.0` also attaches the APK to a GitHub Release, which gives you a shareable download link.

On iPhone, open the live link in Safari and choose **Share > Add to Home Screen**. (A real iOS app needs a Mac and a paid Apple developer account.)

## How it works
- Rider: GPS pickup, search or tap the map for the destination, see the estimated fare, request, track status, cancel.
- Driver: sees new requests live, accepts (first driver wins), moves the trip through arrived, started and completed, sees earnings. New drivers wait for admin approval.
- Admin: stats, all rides, cancel any active ride, approve or revoke drivers.
- Fares are estimated from straight-line distance times 1.3. Address search and maps use free OpenStreetMap services.

## Before real customers
- The debug APK is for testing. For Google Play you need a signed release build.
- Add payments (cash is assumed now), live driver tracking on the rider's map, and ratings.
- OpenStreetMap's free search and tile servers have fair-use limits; switch to a paid map provider if you grow.
