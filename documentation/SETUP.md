# Fairway Live — setup guide (no coding experience needed)

This guide assumes you've never used GitHub, Supabase, or Vercel before.
Every step is something you do by clicking around in a website, not by
writing code. It'll take about 20–25 minutes the first time. You only do
this setup once — after that, using the app on the golf course takes
seconds.

**The three pieces, in plain terms:**
- **GitHub** is where the code "lives." Think of it as a folder in the
  cloud that the other two services will read from.
- **Supabase** is the database — where round info, players, and scores
  actually get stored, and what makes scores show up live on everyone's
  phone.
- **Vercel** takes the code from GitHub and turns it into an actual
  website with a real URL you can visit.

Do these in order: GitHub first, then Supabase, then Vercel last (Vercel
needs to know about the other two before it can finish setting up).

---

## Part 1 — Put the code on GitHub

### 1.1 Create a GitHub account
Go to [github.com](https://github.com) and sign up if you don't already
have an account. It's free.

### 1.2 Create a new repository
A "repository" (or "repo") is just the name for one project's folder on
GitHub.

1. Once logged in, click the **+** icon in the top right, then **New
   repository**.
2. Name it something like `fairway-live`.
3. Leave it set to **Public** (Vercel's free tier works with public
   repos; this also means anyone could technically view your code, but
   not your actual round data — that lives in Supabase, separately).
4. Don't check any of the boxes about adding a README or .gitignore —
   leave those unchecked.
5. Click **Create repository**.

You'll land on a mostly empty page with some setup instructions — ignore
those for now and continue to the next step.

### 1.3 Upload the files
You don't need to use any git commands for this part — GitHub lets you
upload files directly from your browser.

1. On your new repo's page, click **uploading an existing file** (it's a
   link in the box of instructions GitHub shows you).
2. From the project files you downloaded, drag in:
   - `index.html`
   - the entire `assets` folder (drag the whole folder in; GitHub will
     keep its contents together)
3. Scroll down and click **Commit changes**.

You should now see `index.html` and an `assets` folder listed on your
repo's main page. That's the code, safely on GitHub.

---

## Part 2 — Set up Supabase (the database)

### 2.1 Create a Supabase account and project
1. Go to [supabase.com](https://supabase.com) and sign up (you can use
   your GitHub account to sign in, which is convenient since you just
   made one).
2. Click **New project**.
3. Give it a name like `fairway-live`.
4. Set a database password — Supabase will generate one for you, which
   is fine. Click **Save it somewhere** if it offers, just in case, but
   you won't need to type it into anything in this app.
5. Choose any region (pick one close to you, it just affects speed
   slightly).
6. Click **Create new project**. It takes a minute or two to provision —
   just wait on this screen.

### 2.2 Create the database tables
This is the one step that involves "code," but it's really just copying
and pasting a block of text — you don't need to understand it.

1. Once your project is ready, look at the left sidebar and click the
   **SQL Editor** icon (it looks like `>_`).
2. Click **New query**.
3. Open the `supabase_schema.sql` file from your project files, select
   all the text in it, and copy it.
4. Paste it into the SQL editor box in Supabase.
5. Click **Run** (or press Ctrl+Enter / Cmd+Enter).
6. You should see a green "Success" message. If you see a red error
   instead, double check you copied the *entire* file, including the
   very first and very last lines.

This created three tables — `rounds`, `players`, and `scores` — and
turned on the live-sync behavior the app depends on.

### 2.3 Get your project's API credentials
The app needs two pieces of information to talk to your Supabase
project: a URL and a public key.

1. In the left sidebar, click the gear icon for **Project Settings**.
2. Click **API** in the settings menu.
3. You'll see a **Project URL** (looks like
   `https://abcdefghijk.supabase.co`) and a key labeled **anon public**
   (a long string of letters and numbers).
4. Keep this tab open — you'll copy these two values into the code in
   the next step.

### 2.4 Add your credentials to the code
1. Back on GitHub, open your repo, then open `assets` →
   `supabase-config.js`.
2. Click the pencil/edit icon (top right of the file view) to edit it
   directly in the browser.3. Replace `https://YOUR_PROJECT_REF.supabase.co` with your actual
   Project URL from Supabase.
4. Replace `YOUR_ANON_PUBLIC_KEY` with your actual anon public key.
5. Make sure both stay inside the quote marks, exactly like the
   placeholders were.
6. Scroll down and click **Commit changes**.

The anon public key is *meant* to be public, even in a public repo —
Supabase's actual security comes from the rules we set up in the SQL
step, not from hiding this key. So this is safe to leave visible.

---

## Part 3 — Deploy with Vercel (make it a real website)

### 3.1 Create a Vercel account
Go to [vercel.com](https://vercel.com) and sign up — choose **Continue
with GitHub** so the two are connected automatically.

### 3.2 Import your repo
1. On your Vercel dashboard, click **Add New** → **Project**.
2. You should see your `fairway-live` repo in the list (if not, click
   **Adjust GitHub App Permissions** and grant Vercel access to it).
3. Click **Import** next to it.
4. Vercel will show some configuration options — you don't need to
   change anything, since this is a plain static site with no build
   step. Click **Deploy**.
5. Wait about 30–60 seconds. Vercel will give you a live URL, something
   like `https://fairway-live-yourname.vercel.app`.

That URL is your working app. Open it, bookmark it, and consider adding
it to your phone's home screen (most phone browsers have a "share" or
"..." menu with an option like "Add to Home Screen").

### 3.3 Making changes later
Any time you edit a file on GitHub (like if you wanted to tweak colors
in `styles.css`), Vercel automatically redeploys the live site within
about a minute — you don't need to repeat any of the steps above.

---

## You're done — quick test

Open your Vercel URL on two devices (or two browser tabs). On one, tap
**Start a round**, fill in a course name and a couple of players, and
create it. On the other, tap **Join an existing round** and enter the
code. Start the round and try entering a score — it should show up on
both screens within a couple of seconds.

If something doesn't work, the most common causes are covered in
**Troubleshooting** below.

---

## Troubleshooting

**"Could not create round" / "Could not reach the round" toasts appear**
This almost always means `assets/supabase-config.js` still has a
placeholder value, or has a typo. Double check both the URL and the key
were pasted in correctly, with the quote marks intact, and that you
clicked **Commit changes** on GitHub afterward (and that Vercel had time
to redeploy — check the **Deployments** tab in Vercel to confirm the
latest one succeeded).

**The SQL step showed a red error**
Most likely the copy-paste was incomplete. Go back to the SQL Editor,
clear the box, and paste the entire `supabase_schema.sql` file contents
again from scratch.

**Scores aren't updating live on the other device**
First, confirm both devices are looking at the same round code. If they
are, check Supabase's **Table Editor** (left sidebar) — open the
`scores` table and see if new rows are actually appearing there as you
tap. If rows are appearing in Supabase but not showing up on the other
screen, it's worth checking the **Database → Replication** section in
Supabase to confirm `rounds`, `players`, and `scores` are listed under
the realtime publication (the SQL script does this automatically, but
it's the one thing worth a manual glance at if live sync isn't working).

**I made a typo or want to start over with the database**
You can re-run the SQL script's `create table` statements — but if the
tables already exist, you'll need to delete them first. In Supabase's
**Table Editor**, you can delete a table from its menu, or simply create
a brand new Supabase project and repeat Part 2.

---

## What's intentionally not included yet

This build is the simplified core: create a round, join with a code,
each player enters their own scores, and a live leaderboard across
Gross, Net, Stableford, Skins, and Match play modes. Two things we
discussed adding later are not in this version:

- **Host editing other players' scores** (a backup option if someone's
  phone dies mid-round)
- **Round history** (saving final standings after a round ends, so you
  can look back at past rounds later)

Both are straightforward to add on top of this Supabase foundation
whenever you're ready — just ask, and I can walk through what changes
without needing to redo any of the setup above.
