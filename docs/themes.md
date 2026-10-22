# Light and dark themes

The console has two themes. **Light** is the console as it has always looked: a dark navigation and top bar with pale, frosted panels. **Dark** darkens the panels, the dialogs and the menus as well, for rooms and hours where
a pale page is too much. Both are checked for accessibility (see below).

## Choosing

**Account menu → Appearance** has three buttons:

| Button | What it does |
|---|---|
| Device | follows the device: dark when the operating system or browser is set to dark, light otherwise, and it changes when the device does (the default) |
| Light | always light |
| Dark | always dark |

The launcher (**Ctrl + K**) has the same three: *Use the light theme*, *Use the dark theme*, *Match the theme to this device*.

The choice is kept **by the browser** (local storage, `nuvrion.theme`), not by the server: it is a property of the screen in front of you, not of your account, so it does not follow you to another computer and an
administrator cannot see or change it. A browser that blocks storage still works: the choice then lasts until the page is closed, and a value in storage that is not one of the three is ignored.

`theme-boot.js`, a few lines in the page head, applies the choice **before the console is drawn**, so a person who chose dark never sees a flash of light, and the sign-in page follows it too.

## How the dark theme is made

The light theme is the stylesheets (`styles.css`, `visibility.css`, `vm-workspace.css`) and is not touched by the dark theme. `apps/web/dark.css` is **generated** from them by `tools/build-dark-theme.js`:

- it repeats every colour declaration of every rule (background, text, border, shadow, SVG fill and stroke, colour variables) under `html[data-theme="dark"]`, with the colours turned: pale surfaces become dark ones of the same hue,
  dark text becomes light text, pale borders become faint ones. Saturated colours (the teal of a button, the red of a failure) and what is already dark are left alone;
- every colour declaration is repeated, changed or not, so a state such as `:hover` or `.active` keeps the strength it has in the light theme and still beats the rule it beats there;
- a rule with a bright background of its own (a bright button) keeps its dark text; text in the brand teal uses a lighter teal (`--teal-ink`) on dark panels, because the button teal is too dim to read there.

Do not edit `dark.css`. When a stylesheet changes, run

```bash
node tools/build-dark-theme.js
```

A test compares the committed `dark.css` with what the stylesheets give and fails if they differ. A fix the rules cannot make (a chart, an unusual component) goes in `apps/web/dark-tweaks.css`, which is written by hand and
loaded after `dark.css`; today it sets the browser's `color-scheme` (so scrollbars and form controls match) and the lighter teal.

## Checked

The accessibility checks (axe-core, WCAG 2.1 A and AA) run on every page, dialog and menu **in both themes** (`accessibility.e2e.test.js` and `accessibility-dark.e2e.test.js`). A unit test holds the palette: every text and
surface colour pair the light theme uses must still read at 4.5 to 1 once turned. axe cannot judge text on a translucent or gradient panel, so the dark theme was also measured by a script that works out the contrast of every
visible piece of text against what is really behind it, on every page.

## Limits

- Light is today's look, not a new bright redesign: the navigation and top bar are dark in both themes.
- The sign-in page (a photograph with a dark card) looks the same in both.
- Charts and bars use their own colours, chosen to be visible on both kinds of panel.
- The choice is per browser; there is no per-account or organisation-wide default.
