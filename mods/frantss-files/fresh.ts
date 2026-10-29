// One Fresh daemon per project folder, so every file opened from that folder goes to the same editor.

/** A daemon name that is readable and different for each folder, even when two folders share a name. */
export function daemonName(root: string): string {
  let hash = 0;
  for (const char of root) hash = (Math.imul(hash, 31) + char.codePointAt(0)) | 0;
  const base = root
    .split(/[\\/]/)
    .pop()
    .replace(/[^\w-]/g, "-");
  return `herdr-${base}-${(hash >>> 0).toString(36)}`;
}

/** Whether `fresh --cmd daemon list` names this daemon. */
export const daemonRunning = (list: string, name: string) =>
  list.split("\n").some((line) => line.trim() === name);

// Fresh theme colors, each from a Herdr theme key or a fixed "#rrggbb". Keys left out come from
// Fresh's built-in light or dark theme.
const COLORS = {
  editor: {
    bg: "background",
    fg: "foreground",
    cursor: "cursor",
    inactive_cursor: "dim",
    selection_bg: "selection",
    current_line_bg: "hover",
    line_number_fg: "dim",
    line_number_bg: "background",
    whitespace_indicator_fg: "border",
    bracket_match_fg: "accent",
  },
  ui: {
    tab_active_fg: "foreground",
    tab_active_bg: "background",
    tab_inactive_fg: "muted",
    tab_inactive_bg: "chrome",
    tab_separator_bg: "chrome",
    tab_hover_bg: "hover",
    tab_close_hover_fg: "blocked",
    menu_bg: "chrome",
    menu_fg: "muted",
    menu_active_bg: "selected",
    menu_active_fg: "foreground",
    menu_dropdown_bg: "popover",
    menu_dropdown_fg: "foreground",
    menu_highlight_bg: "selected",
    menu_highlight_fg: "foreground",
    menu_border_fg: "border",
    menu_separator_fg: "border",
    menu_hover_bg: "hover",
    menu_hover_fg: "foreground",
    menu_disabled_fg: "dim",
    menu_disabled_bg: "popover",
    status_bar_fg: "muted",
    status_bar_bg: "chrome",
    status_palette_fg: "accent_foreground",
    status_palette_bg: "accent",
    prompt_fg: "foreground",
    prompt_bg: "popover",
    prompt_selection_fg: "foreground",
    prompt_selection_bg: "selection",
    popup_border_fg: "border",
    popup_bg: "popover",
    popup_text_fg: "foreground",
    popup_selection_fg: "foreground",
    popup_selection_bg: "selected",
    text_input_selection_bg: "selection",
    settings_selected_fg: "foreground",
    settings_selected_bg: "selected",
    suggestion_bg: "popover",
    suggestion_selected_bg: "selected",
    help_bg: "popover",
    help_fg: "foreground",
    help_key_fg: "accent",
    help_separator_fg: "border",
    help_indicator_fg: "accent_foreground",
    help_indicator_bg: "accent",
    inline_code_bg: "hover",
    split_separator_fg: "border",
    split_separator_hover_fg: "accent",
    scrollbar_track_fg: "background",
    scrollbar_thumb_fg: "input",
    scrollbar_track_hover_fg: "background",
    scrollbar_thumb_hover_fg: "dim",
    terminal_bg: "background",
    terminal_fg: "foreground",
  },
  search: {
    match_fg: "foreground",
    match_bg: "selected",
    current_match_fg: "accent_foreground",
    current_match_bg: "accent",
    label_fg: "accent_foreground",
    label_bg: "accent",
  },
  diagnostic: { error_fg: "blocked", warning_fg: "ansi3", info_fg: "ansi4", hint_fg: "dim" },
};
// Code colors from the Veist VS Code theme (its tokenColors); the rest follow the theme's text color.
// Its mint and white only read on dark, so a light theme keeps colors from its terminal palette.
const DARK_SYNTAX = {
  keyword: "#d32d6c",
  string: "#7ce0c3",
  comment: "#888888",
  function: "#54a6f8",
  constant: "#54a6f8",
  variable: "foreground",
};
const LIGHT_SYNTAX = {
  keyword: "ansi5",
  string: "ansi2",
  comment: "dim",
  function: "ansi4",
  type: "ansi3",
  constant: "ansi6",
  variable: "foreground",
};

/** A Fresh theme (colors as [r, g, b]) with the colors of this Herdr theme. */
export function freshTheme(theme: Record<string, string>, light: boolean) {
  const rgb = (value: string) => {
    const hex = value.startsWith("#") ? value : theme[value];
    return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  };
  const section = (keys: Record<string, string>) =>
    Object.fromEntries(Object.entries(keys).map(([key, value]) => [key, rgb(value)]));
  return {
    name: "frantss",
    extends: light ? "builtin://light" : "builtin://dark",
    editor: section(COLORS.editor),
    ui: section(COLORS.ui),
    search: section(COLORS.search),
    diagnostic: section(COLORS.diagnostic),
    syntax: section(light ? LIGHT_SYNTAX : DARK_SYNTAX),
  };
}

/** Fresh 0.5.4 loads themes only from its own themes folder, so the theme is written there. */
export const FRESH_THEME = "herdr-frantss.json";

/** The Fresh config the panel starts daemons with: the frantss theme, and no welcome tab. */
export const freshConfig = () => ({
  theme: FRESH_THEME,
  plugins: { welcome_screen: { enabled: false } },
});
