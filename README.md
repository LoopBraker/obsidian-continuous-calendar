# Continuous Calendar for Obsidian

*A year-at-a-glance calendar that turns your vault into a lightweight personal planner.*
 
>Why a continuous calendar?
>Monthly views chop weeks in half and hide adjacent days on separate pages. A **continuous calendar** lines the whole year up—week by week—so you can spot gaps, overlaps, and long-range deadlines at a glance. Think of it as the Kanban board for time itself.

![screenshot-full](https://github.com/LoopBraker/obsidian-continuous-calendar/blob/7cbb9e771ca686211038e7fe1624c42dcc050beb/images/Screenshot-full.png)

## Main features

| 📌 | What it does | Why it matters |
|----|--------------|----------------|
| **Year grid view** | Renders the 52-week matrix inline in Obsidian’s right sidebar. | See the whole year without scrolling between months. |
| **Daily-notes** | Pulls or create your Daily Notes | Jump to any day’s note with a click. |
| **Front-matter events** | Any note with `date:` (or `dateStart` + `dateEnd`) turns into an event or a multiday bar. | Tie projects, trips, tasks, etc. directly to their dates. |
| **Birthdays** | Reads `birthday:` from notes in your chosen “People” folder or vault and repeats them every year. | Never forget cake again. |
| **Official holidays** | Fetches holidays for selected countries via **date-holidays** and stores them in markdown for offline use. | Background tint instantly tells you “day off”. |
| **Color & symbol rules** | Override colors per-note *or* set default colors/symbols per tag. | Fast visual categorisation without messing with CSS. |
| **Click-to-expand** | Click any day to pop open a list of events/birthdays/notes with live links. | No more hunting dots with tooltips. |
| **Focus & opacity toggles** | Fade or highlight whole months to declutter past/future noise. | Great for quarter planning. |

![some features](https://github.com/LoopBraker/obsidian-continuous-calendar/blob/7cbb9e771ca686211038e7fe1624c42dcc050beb/images/some-features.png)

## Quick start

1. **Install**   
   - Clone/download the latest release to `<vault>/.obsidian/plugins/continuous-calendar`  
   - Go to *Settings → Community plugins → Searched installed plugins* and search for `continuous-calendar` 
   - Toggle the plugin on.

2. Click the 📅 ribbon icon, and the calendar opens in the right split.

3. **Tweak settings** under *Settings → Plugin → Continuous Calendar*  
   - Pick the year to display.  
   - Choose folders, default colors, and holiday sources.  
   - Add tag→color rules or per-country holiday tints.

>[!IMPORTANT]
>continuous-calendar requires Obsidian 1.0+, [Daily Notes core plugin](https://help.obsidian.md/plugins/daily-notes), [dataview](https://help.obsidian.md/plugins/daily-notes), and [periodic-notes](https://github.com/liamcain/obsidian-periodic-notes) plugins to work.


## Say thanks 🙏
If you like this plugin or want to support further development, you can!

[<img src="https://img.shields.io/badge/paypal-LoopBreaker-yellow?style=social&logo=paypal" alt="BuyMeACoffee" width="220">](https://www.paypal.com/donate/?hosted_button_id=R24VP67KCPC88)



[<img src="https://img.shields.io/badge/buy_me_a_coffee-LoopBreaker-FFDD00?style=social&logo=buy-me-a-coffee&logoColor=black" width="300">]([coff.ee/loopbraker](https://buymeacoffee.com/loopbraker))


## Work in progress
This plugin is still in active development. If you have ideas, suggestions, or issues, please [open an issue](https://github.com/LoopBraker/continuous-calendar/issues). Here are some of the features I’m working on:

**Display & Interaction:**
- [ ] Toggleable 'Expanded Linear View' (Inline Titles):
	- **Goal:** Offer an optional display mode for the continuous calendar that shows note/event titles directly, suitable for larger screens or users preferring more immediate detail.
	- **Details:** Add a toggle button (not sure where..idea?) to switch between the standard 'Compact Linear View' (current behavior with expandable cells) and a new 'Expanded Linear View'. When 'Expanded', the rows/cells in the linear layout will be taller, allowing sufficient space to display titles of associated single-date notes, range notes (potentially spanning multiple days visually), and holidays directly within the view. In this mode, the click-to-expand functionality for individual day cells would be disabled, as the details are already visible inline. **See the month  view in the example vault to have an idea**.
	 
- [ ] Alternative `Monthly Grid View`:
    - **Goal:** Offer a traditional monthly calendar grid view as an alternative to the current continuous calendar view.
    - **Details:** Implement a new view mode that displays one month at a time in a standard grid format. Add a toggle control within the plugin's view panel to allow users to switch between the `continuous calendar View` and the `Monthly Grid View`.
    
- [ ] Details Panel for `Monthly Grid View`:
    - **Goal:** Define how day details are shown in the proposed `Monthly Grid View`.
    - **Details:** When a user clicks on a day in the `Monthly Grid View`, instead of expanding the cell inline (like the current yearly view), display the day's details (holidays, associated notes, events, birthdays) in a separate, dedicated panel or area, likely positioned below the month grid itself.

**Notes & Data Handling:**
- [x] Confirmation Setting for `Range Note Creation`: ✅ 2025-06-30
    - **Goal:** Allow users to optionally confirm before a new range note file is created.
    - **Details:** Add a new toggle setting, `"Confirm before creating range notes"`. If enabled, after the user selects the start and end dates via click and Cmd/Ctrl+click, display a confirmation dialog before the plugin proceeds to create the Untitled Range Note... file.
    
- [x] Birthday Entry Customization: ✅ 2025-06-30
    - **Goal:** Allow users to set a specific color for birthday indicators.
    - **Details:** Add a color picker setting specifically for the birthday indicator (B), similar to the existing 'Default Event Dot Color' setting.
    
- [x] Indicator Symbol  ✅ 2025-06-30
    - **Goal:** Allow users to personalize the look and size of calendar indicators.
    - **Details:** Add settings to:
        - **Symbols:** Allow users to input custom characters/emojis to use for:
            - Single-Date Notes (Default: ●)
            - Daily Notes (Default: ▼)
            - Birthdays (Default: ✱)
- [ ] **Size:** Provide options (e.g., dropdown: Small/Medium/Large, or a number input for font-size/height) to control the visual size of the dot/symbol indicators and the height/thickness of the range bars.
    

**Bug Fixes / Refinements:**
- [x] Refine Focus/Opacity Interaction: ✅ 2025-06-30
    - **Goal:** Ensure turning off 'Focus' correctly resets the month's visual state.
    - **Details:** When the 'Focus' toggle ('plus/minus' icon) is deactivated for a month, the month should return to its default appearance (faded if it's not the current month), unless the 'Opacity' toggle ('eye' icon) has been separately activated to keep it visible. Fix any cases where removing focus leaves the month incorrectly opaque.
    

**Additional:**
- **Settings Organization:** settings is growing, I should consider grouping them more clearly using headings.
    
- **Code Refactoring Continuous Calendar:** especially `view.ts` and `settings.ts`. I will look for opportunities to extract functions or create smaller components.
    
- **Error Handling:** Enhance error handling, especially around file operations (reading templates, creating notes) and API interactions (holiday service, potentially Templater). Provide informative messages to the user via Notice.
    
- **Performance?**
    
- **Range Note Folder Setting:** Add a setting to specify the default folder where new range notes should be created.
    
- **Mobile Usability:** Test how the calendar view and its interactions (like range selection, clicking icons) behave on mobile devices and make necessary CSS adjustments.

## Plugin Progress

**The Barebones Calendar Grid**
The first step was to get the fundamental structure in place. This version establishes the plugin, registers the custom view, and implements the core logic for laying out a year's worth of days in a simple grid format. At this stage, it is just a static, visual skeleton with no interactivity or settings.

**Introducing Settings and a Dynamic Year**
This is the first step towards making the plugin dynamic and user-configurable. A settings tab is added, allowing users to change the year displayed by the calendar, making the tool reusable and adaptable beyond the current year.

**Integrating and Creating Daily Notes**
Inspired by [Liam Cain](https://github.com/liamcain)'s legendary [obsidian-calendar-plugin](https://github.com/liamcain/obsidian-calendar-plugin), this stage turns the calendar into a functional part of the Obsidian workflow.

**Displaying General Events & Date Ranges**
The plugin's scope expands beyond just daily notes. It now scans the entire vault for any note with `date`, `dateStart`, or `dateEnd` in its frontmatter, displaying single-day events as dots and multi-day events as continuous bars. This transforms the calendar into a central hub for all time-based information.
*   [x] Added color coding to events and ranges based on a `color` property in their frontmatter.
*   [x] Added color coding to events and ranges based on their tags via a new settings section.

**Visual Polish: "Today" & Structural Highlighting**
The calendar becomes much more readable with several key visual enhancements: (1) The current day is now prominently highlighted. (2) The current week's number is styled differently to stand out. (3) Months are distinguished by alternating background colors (a "zebra striping" effect), and weekends are subtly shaded. These cues make the year-long view significantly easier to parse at a glance.

**Adding Birthday Tracking**
The plugin can now identify and display recurring birthdays. This is controlled by a `birthday` frontmatter property.

**Click-to-Expand Day Details and Per-Note Color**
Clicking on the body of a calendar cell now reveals an expanded popover view directly in the grid. This view lists all events, birthdays, and ranges for that day with clickable links. This is more useful and accessible than relying on tiny dots or hover tooltips. **Motivation:** The calendar was getting crowded. It was time to provide a way to see details clearly. The click-to-expand feature makes the calendar much more interactive and informative. The per-note `color` override, which allows users to set a color directly in a note's frontmatter, is a natural companion, enabling a rich, user-driven, color-coded system.

**Holiday Integration, Month Labels, and Sticky Header**
*   The plugin can now fetch and display official holidays for selected countries. It integrates the `date-holidays` library, and a `HolidayService` is created to manage fetching data and caching it in special Markdown files within the vault. This avoids re-fetching on every load. The settings are expanded to allow users to add/remove countries and specify where the data files are stored. **Motivation:** Manually adding every public holiday is tedious. Caching the data in the vault makes the plugin fast after the initial fetch and allows the data to be version-controlled and even manually edited.
    *   [x] Added support for fully manual "Custom" holiday sources.
    *   [x] Added settings to allow users to assign a specific color to each holiday source.
*   A new column is added to the right side of the calendar that displays the month's abbreviation, providing a clear visual anchor when scrolling.
*   The header row ("Mon, Tue, ...") is made "sticky" so it remains visible as the user scrolls through the year.

**Final Interactivity and Customization Push**

*   **Powerful Interactivity:** Users can now create multi-day "range notes" via a `click` + `Cmd/Ctrl+click` interaction. Clicking a week number toggles a "relative week" view for easy project tracking. Controls are added to the bottom to "Reset Focus" states and "Relocate to Today".
*   **Rendering:** The engine is upgraded to slot overlapping range bars into non-colliding lanes and to draw perfect, continuous outlines around focused months.
*   **Customization:** Tag-based settings are enhanced to include custom **symbols** (e.g., `🎖️`) and an option to collapse duplicates.
*   **Enhanced Settings UX:** The settings tab is polished with an auto-completing folder path suggester and live color previews, making configuration a breeze.