# Guild Timesheet

A simple website for recording your crew's weekly hours per project, handling
the Retrofit traffic-light hour reallocation automatically, and producing the
end-of-week payroll report.

It's built as a plain static site (no build tools, no framework) so it can be
hosted for free on **GitHub Pages**, and it stores all its data in a
**Google Sheet** via a small **Google Apps Script** backend (also free, no
server to maintain).

```
guild-timesheet/
├── index.html       the whole app's page structure
├── styles.css       styling
├── config.js        <-- your Apps Script URL lives here
├── app.js           all the app logic
├── Code.gs          the backend that reads/writes the Google Sheet
│                     (paste into the Apps Script editor, see below)
├── SeedData.gs      your crew list + project list, pre-loaded from
│                     your Sept 5 payroll export (also pasted into Apps Script)
└── README.md         (this file)
```

## How it works, in plain terms

- **The Google Sheet is the database.** It gets tabs for Crew, Projects,
  Entries, RetrofitDays, and RetrofitAssignments. You never have to edit the
  Entries/RetrofitDays/RetrofitAssignments tabs by hand — the website does
  that. You *can* edit the Crew and Projects tabs by hand any time (add a
  hire, retire a project, fix a typo).
- **The website is just HTML/CSS/JS files** sitting on GitHub Pages. It has
  no database of its own — every read and save goes to your Apps Script URL.
- **The Apps Script is the only thing that touches the Sheet.** The website
  never talks to Google directly (that would require exposing credentials in
  public code, which GitHub Pages can't protect), so the setup here is:
  `Website (GitHub Pages) → Apps Script (Google) → Google Sheet`.

## Setup status

The Google Sheet + Apps Script backend for this were already set up (in
your Google account) and are live:

- Sheet: "Guild Timesheet Data" — has Crew, Projects, Entries, RetrofitDays,
  and RetrofitAssignments tabs, with Crew (105 people) and Projects (7,
  including the Retrofit one) already loaded from your Sept 5 payroll
  export.
- Apps Script project: "Guild Timesheet API", deployed as a web app
  (Execute as Me, access Anyone), and its URL is already saved in
  `config.js` in this repo.
- Site password: **giuseppe123** (change any time — see below).

The only step left is putting these files on GitHub Pages:

1. Create a new GitHub repository (public or private — Pages works with
   both, though private repos need a paid plan for Pages on some account
   tiers).
2. Push all the files in this folder to that repository (or use GitHub's
   "uploading an existing file" page if you'd rather not use git).
3. In the repo, go to **Settings → Pages**. Under "Build and deployment",
   set Source to **Deploy from a branch**, branch **main**, folder **/
   (root)**. Save.
4. GitHub will give you a URL like
   `https://<your-username>.github.io/<repo-name>/`. That's the link for
   your dad to use — bookmark it, or add it to his phone's home screen.

That's it — no ongoing hosting cost, no server to keep running.

### If you ever need to redo the Google side

1. Go to [sheets.google.com](https://sheets.google.com) and create a new,
   blank spreadsheet.
2. In the Sheet, go to **Extensions → Apps Script**. This opens the script
   editor in a new tab, already linked to your Sheet.
3. Delete whatever is in the default `Code.gs` file that's there, and paste
   in the entire contents of **`Code.gs`** from this repo.
4. Click the **+** next to "Files" and add a new script file named
   `SeedData` (Apps Script will call it `SeedData.gs`). Paste in the entire
   contents of **`SeedData.gs`** from this repo.
5. Save the project (the disk icon, or Ctrl/Cmd+S).
6. In the function dropdown at the top (next to the Debug button), select
   **`setupSheet`** and click **Run** (▶). The first time, Google will ask
   you to authorize the script — click through "Advanced" → "Go to
   (project name)" and allow it. This is safe: it's your own script acting
   on your own Sheet.
7. Back in the Apps Script editor, open **`setPassword`**, change the
   password inside it, save, select `setPassword` in the function dropdown,
   and click **Run** once.
8. Deploy it as a web app: click **Deploy → New deployment**. Click the
   gear icon next to "Select type" and choose **Web app**. Set Execute as
   **Me** and Who has access **Anyone**. Click **Deploy** and copy the
   Web app URL into `config.js` in this repo.

## Using the site

- **Log in** with the site password (**giuseppe123** — change it any time, see below).
- **Pick the week** at the top using the week-ending (Saturday) date field,
  or the ← / → arrows to move a week at a time, or "This week".
- **Enter Hours tab:** start typing a crew member's name, pick them from the
  list, and you'll see Monday–Saturday for them. For each day, pick a
  project and enter hours; click "+ Add another project for this day" if
  they worked more than one project that day. Pick "O/T (1.5x)" or
  "O/T (2x)" from the dropdown next to a row if your dad has decided that
  time should be overtime or double time — it defaults to Regular.
  Everything saves automatically as you type (you'll see a "Saved" note in
  the corner). The right-hand panel is a running tally of everyone entered
  so far this week — click a name there to jump back to editing them.
- **Retrofit / Traffic Lights tab:** for each day, enter how many traffic
  lights were done. The site shows the labor-hour budget that unlocks
  (traffic lights × 4 hours — this "4" can be changed, see below). Add the
  crew members who should be paid under Retrofit that day and how many
  hours each. The site automatically finds that same amount of hours in
  each person's *other* project entries for that week and moves it out —
  their weekly total hours stay the same, only the project the hours are
  billed to changes. It picks which of their other entries to reduce
  automatically (it doesn't matter which project loses the hours, so this
  step is hands-off); if someone doesn't have enough hours recorded
  elsewhere that week to fully cover the move, the Report tab will flag it
  so you know to double check.
- **Report tab:** click "Generate report" to see the finished breakdown,
  grouped by project, e.g.:

  ```
  Project TMH00251 — Traffic Signals Mississauga Emergency Maint PRC005227
  Adam Zaretsky — 10 Hours Regular
  Mark Bello — 5 Hours Regular
  Tom Green — 3 Hours Regular, 5 Hours O/T (1.5x)
  ```

  This report reflects the Retrofit reallocation, so it's the one to use
  for actually running payroll. Use "Copy to clipboard" to paste it
  elsewhere, or "Print / Save PDF" to print or save a PDF copy.

## Adjusting things later

- **Add a new crew member or project any time** — either through the "+ Add
  as new crew member" option that shows up while searching a name that
  doesn't exist yet, or by adding a row directly in the Crew / Projects
  tabs of the Google Sheet (Active column should be `TRUE`).
- **Change the password** any time: in the Apps Script editor, edit and
  re-run `setPassword`.
- **Change how many hours one traffic light is worth** (currently 4): edit
  and re-run `setHoursPerLight` in the Apps Script editor.
- **Retire a project or crew member** without losing their history: set
  their `Active` column to `FALSE` in the Sheet instead of deleting the
  row — this hides them from the dropdowns/search but keeps old timesheets
  intact.

## Assumptions worth knowing about

- The week is always **Monday–Saturday**, identified by its ending
  Saturday's date, matching what you described.
- Regular vs. O/T (1.5x) vs. O/T (2x) is entirely your dad's call, entered
  per project/day line — the site doesn't calculate overtime automatically,
  since you mentioned it depends on his judgment per project.
- Reallocated Retrofit hours default to "Regular" pay type; if a particular
  week's Retrofit reallocation should actually be O/T for someone, just
  change the pay type dropdown on that assignment row in the Retrofit tab.
- The login is a single shared password (no per-user accounts). It's meant
  to keep the site from being casually stumbled into — it isn't bank-grade
  security, so don't put anything more sensitive than work hours behind it.

## If something looks wrong

Almost everything lives in the Google Sheet, so it's easy to sanity-check:
open the Sheet directly and look at the **Entries** tab (raw hours entered)
and **RetrofitAssignments** tab (the reallocation instructions) for a given
`WeekEnding` date. The Report tab's numbers are always computed fresh from
those two tabs, so nothing is ever "stuck" — fixing an entry and
re-generating the report will always reflect the fix.
