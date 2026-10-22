// Light and dark themes (docs/themes.md). Pure functions, kept apart from app.js so they can be tested in node. The choice is kept by the browser (localStorage), not by the server: it is a
// property of the screen, not of the account. theme-boot.js, a few lines that run before the page is painted, applies the same rule, and a test holds the two together.

export const THEME_KEY = 'nuvrion.theme';
export const CHOICES = Object.freeze(['system', 'light', 'dark']);
export const CHOICE_LABEL = Object.freeze({ system: 'Match this device', light: 'Light', dark: 'Dark' });

export const normaliseChoice = value => (CHOICES.includes(value) ? value : 'system');

// The theme to show for a choice: "system" follows the device's setting.
export const resolveTheme = (choice, prefersDark) => (choice === 'dark' || (choice !== 'light' && Boolean(prefersDark)) ? 'dark' : 'light');

// The choices in the account menu: the one in use is pressed.
export function choiceHtml(current) {
  return CHOICES.map(choice => `<button type="button" data-theme-choice="${choice}" aria-pressed="${choice === current}">${choice === 'system' ? 'Device' : CHOICE_LABEL[choice]}</button>`).join('');
}

// What the account menu says about the choice in use.
export const choiceHint = (choice, resolved) => (choice === 'system' ? `Following this device (${resolved} now)` : `${CHOICE_LABEL[choice]} theme`);
