// The accessibility checks of accessibility.e2e.test.js, run in the dark theme (docs/themes.md).
process.env.NUVRION_AXE_THEME = 'dark';
await import('./accessibility.e2e.test.js');
