# Continuous Calendar for Obsidian

*A year-at-a-glance calendar that turns your vault into a lightweight personal planner.*

>[!IMPORTANT] Why a continuous calendar?
>Monthly views chop weeks in half and hide adjacent days on separate pages. A **continuous calendar** lines the whole year up—week by week—so you can spot gaps, overlaps, and long-range deadlines at a glance. Think of it as the Kanban board for time itself.

![screenshot-full](https://github.com/LoopBraker/continuous-calendar/blob/ae614dac31ef33f5eaed361a652bb06c259bbc64/images/Screenshot-full.png)

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

![some features](https://github.com/LoopBraker/continuous-calendar/blob/ae614dac31ef33f5eaed361a652bb06c259bbc64/images/some-features.png)

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

[<img src="https://img.shields.io/badge/paypal-LoopBreaker-yellow?style=social&logo=paypal" alt="BuyMeACoffee" width="100">](https://www.paypal.com/donate/?hosted_button_id=R24VP67KCPC88)

## Work in progress
This plugin is still in active development. If you have ideas, suggestions, or issues, please [open an issue](https://github.com/LoopBraker/continuous-calendar/issues). Here are some of the features I’m working on:

**Display & Interaction:**
 - [ ] Toggleable 'Expanded Linear View' (Inline Titles):
	 - **Goal:** Offer an optional display mode for the continuous calendar that shows note/event titles directly, suitable for larger screens or users preferring more immediate detail.
	 - **Details:** Add a toggle button (not sure where..idea?) to switch between the standard 'Compact Linear View' (current behavior with expandable cells) and a new 'Expanded Linear View'. When 'Expanded', the rows/cells in the linear layout will be taller, allowing sufficient space to display titles of associated single-date notes, range notes (potentially spanning multiple days visually), and holidays directly within the view. In this mode, the click-to-expand functionality for individual day cells would be disabled, as the details are already visible inline. **See the month  view in the example vault**.
	 
- [ ] Alternative `Monthly Grid View`:
    - **Goal:** Offer a traditional monthly calendar grid view as an alternative to the current yearly linear view.
    - **Details:** Implement a new view mode that displays one month at a time in a standard grid format. Add a toggle control within the plugin's view panel to allow users to switch between the `Yearly Linear View` and the `Monthly Grid View`.
    
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
